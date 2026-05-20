'use strict';

const cron      = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');
const db        = require('./db');
const { sendEmail } = require('./email');

const { getCurrentBuildWeek } = require('./db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Scheduling guard ──────────────────────────────────────────────────────────

function isLastFridayOfMonth(now = new Date()) {
  const nextWeek = new Date(now);
  nextWeek.setDate(now.getDate() + 7);
  return nextWeek.getMonth() !== now.getMonth();
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(d = new Date()) {
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── DB queries ────────────────────────────────────────────────────────────────

function queryMonthTasks() {
  return db.prepare(`
    SELECT
      t.id, t.title, t.priority, t.status,
      t.deadline, t.estimated_minutes,
      t.created_at, t.updated_at,
      COALESCE(p.name, 'Unassigned') AS project_name
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE date(t.updated_at) >= date('now', '-30 days')
       OR date(t.created_at) >= date('now', '-30 days')
    ORDER BY p.name ASC,
      CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                      WHEN 'medium'   THEN 2 ELSE 3 END ASC
  `).all();
}

function queryAllProjects() {
  return db.prepare(
    `SELECT id, name, status FROM projects ORDER BY priority_rank ASC, name ASC`
  ).all();
}

function queryMonthNetworkContacts() {
  return db.prepare(`
    SELECT name, context, met_via, relationship_strength
    FROM network_contacts
    WHERE date(created_at) >= date('now', '-30 days')
    ORDER BY relationship_strength DESC
  `).all();
}

function queryStaleIdeas() {
  return db.prepare(`
    SELECT i.idea_text, i.captured_at,
           COALESCE(p.name, 'Unassigned') AS project_name
    FROM ideas i
    LEFT JOIN projects p ON i.project_id = p.id
    WHERE i.status = 'raw'
      AND date(i.captured_at) <= date('now', '-30 days')
    ORDER BY i.captured_at ASC
    LIMIT 5
  `).all();
}

// Returns constraints that have been running for 28+ days and are still active.
function queryAuditableConstraints() {
  return db.prepare(`
    SELECT * FROM constraints
    WHERE status = 'active'
      AND date(started_at) <= date('now', '-28 days')
    ORDER BY started_at ASC
  `).all();
}

function groupByProject(tasks) {
  const map = {};
  for (const t of tasks) {
    if (!map[t.project_name]) map[t.project_name] = [];
    map[t.project_name].push(t);
  }
  return map;
}

function projectStats(tasks) {
  const todayStr = today();
  const done     = tasks.filter(t => ['done', 'archived'].includes(t.status)).length;
  const inProg   = tasks.filter(t => t.status === 'in_progress').length;
  const blocked  = tasks.filter(t => t.status === 'blocked').length;
  const overdue  = tasks.filter(
    t => t.deadline && t.deadline < todayStr && !['done', 'cancelled', 'archived'].includes(t.status)
  ).length;
  const total = tasks.length;
  const rate  = total > 0 ? Math.round((done / total) * 100) : 0;
  return { total, done, inProg, blocked, overdue, rate };
}

// ── Task audit prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the personal operating system for Anshhika Jain, 20 years old, CS undergrad at Krea University graduating April 2027.

NORTH STAR: Generational wealth. Multiple businesses. Multiple technical products. First class international travel. One of very few high-power women in India operating at this level. Parents never think twice about any purchase. Kids inherit wealth not just money.

WEALTH TIMELINE:
₹1Cr → age 24-26 | ₹3Cr → age 26-28 | ₹5Cr → age 27-30
₹10Cr → age 30-33 | ₹20Cr → age 32-36

HIERARCHY (in order):
#1 Matrix Media Solutions — ₹20L/month profit, active CEO in 2 years.
   Biggest single wealth lever. Equity upside dwarfs everything else.
#2 Lumiere Internship — exit with full-time offer. Starts June 4.
#3 Autumn (Corelinq) — launch + 1 user/day. ₹20L/month each in 5 years.
#4 Personal Brand — Instagram + LinkedIn. 100K Instagram. Top 0.5% rooms.
#5 Jobs Pipeline — April 2027. Founder's office > PM > TPM > VC.
#6 Personal OS — gym/reading/skincare non-negotiables.
#7 Krea + Actuarial — dormant, context only.

ACTIVE PRODUCTS:
- Autumn: WhatsApp D2C photo editor. Mayank builds, Anshhika leads
  ops/marketing/sales/testing. Taking too long — blocker needs diagnosing.
- Insurance/Investment OS: Anshhika's solo build. Strongest idea.
  Validate with user interviews before building.

PRODUCT PIPELINE (copy-and-build):
- E-commerce automation (Indian platforms: Meesho/Shopify India)
- Content repurposing tool India-first (₹999/mo, Indian creator economy)
- SMB review/feedback tool (restaurants, salons, D2C brands)
- Vertical CRMs (one core build, multiple verticals)

INSTAGRAM:
- Reference: Avni Barman. Cadence: 1 post/week anchor.
- Pillars: Build 40% / Think 40% / Live 20%
- No boyfriend content. Family/friends fine.
- Brand goal: Dior/LV/Dyson/Chanel tier partnerships
- First post: reintroduction carousel (NOT DONE YET — flag weekly)

LINKEDIN:
- 2300 connections, ~1000 impressions/week currently
- Goal: 5-10k impressions/week in 6 months
- Strategy: inbound from founders, not cold applications
- Needs: headline update, operator+builder content shift, pinned post

JOBS PIPELINE (April 2027):
- Now-Aug: build signal, ship one product publicly, 3 case studies
- Sep-Nov: 30-company list, 10 warm international relationships
- Dec-Jan: 20 conversations, selective applications
- Feb-Apr: interview, close offer before graduation
- Unfair edge: age 20 + real outcomes, international BD, builder cred

UNFAIR ADVANTAGES (always reference when relevant):
- Age 20 + real business outcomes (not internships)
- International BD (Netherlands, Gulf, London markets)
- Builder credibility — ships AI products end-to-end
- Operator inside existing company + founder building simultaneously

RULES FOR EVERY OUTPUT:
1. Connect every task to the north star or a wealth milestone
2. Call out anything that is not compounding toward generational wealth
3. Never let a day feel like random busywork
4. Treat her like a founder reviewing her own company — no softening
5. Optimize for the life, not for comfort
6. Peak cognition: 9PM onwards. Deep work always in evening blocks.

Open every monthly audit with this exact block:

THE LIFE SHE IS BUILDING:
Multiple businesses owned simultaneously. Multiple technical products generating revenue. First class international travel multiple times a year. Respected and sought-after in every room. One of very few high-power women in India at this level. Parents never think twice about any purchase at any scale. Children who inherit wealth, not just money.

Then answer these five questions using actual task/project data:

1. PROUD OF
What happened this month that the 35-year-old version of her would be proud of?

2. SMALL THINKING
What happened this month that was small thinking — playing it safe when she should have moved bigger?

3. TRACK STATUS
Which active tracks made real progress and which is stagnating?
Rate each — Matrix / Lumiere / Corelinq / Instagram / Jobs Pipeline — one word:
Compounding / Moving / Stagnating / Drifting

4. RELATIONSHIPS
Is she building relationships with the right people — people 5-10 years ahead of where she wants to be?
Use the network contacts data provided.

5. AVOIDED DECISION
What is the one decision she is avoiding that she needs to make?
Look at tasks that keep getting pushed or ideas marked raw for more than 30 days.

Do not let her optimize for comfort. Optimize for the life.
Output plain text only. No markdown, no asterisks, no backticks.
Use exactly these section headers: THE LIFE SHE IS BUILDING / PROUD OF / SMALL THINKING / TRACK STATUS / RELATIONSHIPS / AVOIDED DECISION`;

function buildUserPrompt(grouped, projects, networkContacts, staleIdeas) {
  const allTasks  = Object.values(grouped).flat();
  const totalDone = allTasks.filter(t => ['done', 'archived'].includes(t.status)).length;
  const totalOpen = allTasks.filter(t => !['done', 'cancelled', 'archived'].includes(t.status)).length;

  let block = `Month: ${monthLabel()}\n`;
  block += `Total tasks active this month: ${allTasks.length} — ${totalDone} completed, ${totalOpen} open\n\n`;
  block += `PER-PROJECT BREAKDOWN:\n`;

  for (const proj of projects) {
    const tasks = grouped[proj.name] || [];
    const s     = projectStats(tasks);

    block += `\n${proj.name} [project status: ${proj.status}]\n`;
    block += `  ${s.total} tasks | ${s.done} done | ${s.inProg} in-progress | ${s.blocked} blocked | ${s.overdue} overdue | ${s.rate}% completion\n`;

    if (tasks.length === 0) {
      block += `  (no activity this month)\n`;
    } else {
      for (const t of tasks.slice(0, 6)) {
        const due = t.deadline ? ` — due ${t.deadline}` : '';
        block += `  • [${t.priority}/${t.status}] ${t.title}${due}\n`;
      }
      if (tasks.length > 6) block += `  … +${tasks.length - 6} more\n`;
    }
  }

  block += `\nNETWORK CONTACTS ADDED THIS MONTH (${networkContacts.length}):\n`;
  if (networkContacts.length > 0) {
    for (const c of networkContacts) {
      block += `  • ${c.name}${c.context ? ' — ' + c.context : ''}${c.met_via ? ' [' + c.met_via + ']' : ''} (strength ${c.relationship_strength}/5)\n`;
    }
  } else {
    block += `  (none)\n`;
  }

  block += `\nIDEAS RAW FOR 30+ DAYS (${staleIdeas.length}):\n`;
  if (staleIdeas.length > 0) {
    for (const i of staleIdeas) {
      const preview = i.idea_text.slice(0, 80) + (i.idea_text.length > 80 ? '…' : '');
      block += `  • "${preview}" (${i.project_name}, since ${i.captured_at.slice(0, 10)})\n`;
    }
  } else {
    block += `  (none)\n`;
  }

  return block + `\nGenerate the Monthly Audit.`;
}

// ── Task audit response parsing ───────────────────────────────────────────────

function parseAuditResponse(raw) {
  let scoresJson = {};
  const scoreMatch = raw.match(/^SCORES_JSON:\s*(\{[\s\S]+?\})/m);
  if (scoreMatch) {
    try { scoresJson = JSON.parse(scoreMatch[1]); } catch {}
  }

  const driftMatch = raw.match(
    /DRIFT FLAGS\s*\n([\s\S]*?)(?=\n[A-Z][A-Z ]+\n|$)/
  );
  const driftText  = driftMatch?.[1]?.trim() || '';
  const driftFlags = driftText === '(none)' || !driftText
    ? []
    : driftText.split('\n').map(l => l.replace(/^[•\-]\s*/, '').trim()).filter(Boolean);

  const emailText = raw.replace(/^SCORES_JSON:.*\n?/m, '').trim();

  return { scoresJson, driftFlags, emailText };
}

// ── Routine audit HTML ────────────────────────────────────────────────────────

function buildRoutineAuditHtml(constraints) {
  if (!constraints.length) return '';

  let html = `
    <hr style="border-color:#2a2a2a;margin:28px 0">
    <h2 style="color:#a78bfa;margin-top:0;margin-bottom:12px;">ROUTINE AUDIT</h2>
    <p style="color:#c0c0c0;margin-bottom:12px;">Constraints you've been running:</p>`;

  for (const c of constraints) {
    const startedFmt = new Date(c.started_at).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric',
    });
    const streakColor = c.missed_streak >= 5 ? '#ff6b6b' : c.missed_streak >= 3 ? '#e3b341' : '#7ee787';
    html += `
      <div style="margin:10px 0 10px 8px;padding:10px 14px;
                  background:#1a1a1a;border-left:3px solid #a78bfa;border-radius:2px;">
        <p style="margin:0 0 4px 0;">
          <strong style="color:#d4d4d4">${c.title}</strong>
          <span style="color:#5a5a5a"> — ${c.frequency}</span>
        </p>
        <p style="margin:0;font-size:12px;color:#5a5a5a;">
          started ${startedFmt} &bull;
          <span style="color:${streakColor}">missed ${c.missed_streak} time${c.missed_streak !== 1 ? 's' : ''}</span>
        </p>
        <p style="margin:6px 0 0 0;color:#7a7a7a;font-size:12px;">
          Keep, modify, or retire?
        </p>
      </div>`;
  }

  return html;
}

// ── Constraint audit reply parsing ────────────────────────────────────────────

// Exported so server.js can call it when a monthly-audit reply arrives.
// Returns array of { title, action, new_frequency? }
async function parseAuditConstraintReplies(replyText, constraints) {
  if (!replyText || !constraints.length) return [];

  const lower = replyText.toLowerCase();
  if (!/keep|retire|drop|pause|modify|change/i.test(lower)) return [];

  const constraintList = constraints.map(c => `"${c.title}"`).join(', ');

  let response;
  try {
    response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `Active constraints: ${constraintList}

Audit reply: ${JSON.stringify(replyText.slice(0, 1000))}

For each constraint explicitly mentioned with a clear action, return JSON array:
[{"title": "...", "action": "keep" | "retire" | "pause" | "modify", "new_frequency": "..." or null}]
Only include constraints with a clear decision. If none found, return [].`,
      }],
    });
  } catch (err) {
    console.error('[monthlyAudit] parseAuditConstraintReplies error:', err.message);
    return [];
  }

  const raw = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();

  try {
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    return JSON.parse(match[0]);
  } catch {
    return [];
  }
}

// ── HTML conversion ───────────────────────────────────────────────────────────

const SECTION_COLORS = {
  'THE LIFE SHE IS BUILDING': '#a78bfa',
  'PROUD OF':                  '#7ee787',
  'SMALL THINKING':            '#e3b341',
  'TRACK STATUS':              '#58a6ff',
  'RELATIONSHIPS':             '#c0c0c0',
  'AVOIDED DECISION':          '#ff6b6b',
};

function auditToHtml(text) {
  const lines = text.split('\n');
  let html      = '';
  let inSection = false;

  const closeSection = () => { if (inSection) { html += '</div>'; inSection = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) { html += '<div style="height:8px"></div>'; continue; }

    if (/MONTHLY AUDIT/.test(line)) {
      closeSection();
      html += `<h1>${line}</h1>`;
      continue;
    }

    const sectionKey = Object.keys(SECTION_COLORS).find(k => line.trim() === k);
    if (sectionKey) {
      closeSection();
      html += `<h2 style="color:${SECTION_COLORS[sectionKey]};margin-top:22px;margin-bottom:8px;">${sectionKey}</h2>`;
      html += `<div style="padding-left:4px;line-height:1.75;">`;
      inSection = true;
      continue;
    }

    const trackMatch = line.match(/^(Matrix|Lumiere|Corelinq|Instagram|Jobs Pipeline):\s*(Compounding|Moving|Stagnating|Drifting)$/i);
    if (trackMatch && inSection) {
      const [, track, status] = trackMatch;
      const color = {
        compounding: '#7ee787',
        moving:      '#58a6ff',
        stagnating:  '#e3b341',
        drifting:    '#ff6b6b',
      }[status.toLowerCase()] || '#c0c0c0';
      html += `<p style="margin:5px 0;"><strong style="color:#d4d4d4">${track}:</strong> <span style="color:${color}">${status}</span></p>`;
      continue;
    }

    if (line.trimStart().startsWith('•')) {
      const content = line.trimStart().slice(1).trim();
      html += `<p style="margin:5px 0 5px 8px;">• ${content}</p>`;
      continue;
    }

    if (inSection) {
      html += `<p style="margin:4px 0;color:#c0c0c0;">${line}</p>`;
    } else {
      html += `<p style="color:#5a5a5a;font-size:12px;">${line}</p>`;
    }
  }

  closeSection();
  return html;
}

// ── Monthly task reset ────────────────────────────────────────────────────────

function runMonthlyReset() {
  const todayStr = today();

  const archived = db.prepare(`
    UPDATE tasks
    SET status = 'archived', updated_at = datetime('now')
    WHERE status = 'done'
  `).run().changes;

  const surfaced = db.prepare(`
    UPDATE tasks
    SET priority = 'critical', updated_at = datetime('now')
    WHERE status NOT IN ('done', 'cancelled', 'archived')
      AND deadline IS NOT NULL
      AND deadline < ?
      AND priority != 'critical'
  `).run(todayStr).changes;

  console.log(`[monthlyAudit] Reset: ${archived} archived, ${surfaced} overdue → critical`);
  return { archived, surfaced };
}

// ── 52 Builds audit section ───────────────────────────────────────────────────

function buildBuildsAuditHtml() {
  const weekNum   = getCurrentBuildWeek();
  const startDate = new Date('2025-05-05T00:00:00.000Z');
  const weeksElapsed = weekNum - 1; // weeks fully elapsed

  const shipped  = db.prepare(`SELECT * FROM builds WHERE status IN ('shipped','elevated','archived')`).all();
  const elevated = db.prepare(`SELECT * FROM builds WHERE status = 'elevated'`).all();
  const onTrack  = shipped.length >= weeksElapsed;

  let html = `<hr style="border-color:#2a2a2a;margin:28px 0">`;
  html += `<h2 style="color:#e3b341;margin-top:0;margin-bottom:12px;">52 BUILDS</h2>`;
  html += `<p style="color:#c0c0c0;margin:4px 0;">Shipped: <strong style="color:${onTrack ? '#7ee787' : '#ff6b6b'}">${shipped.length} / ${weeksElapsed}</strong> weeks elapsed</p>`;

  if (elevated.length > 0) {
    html += `<p style="color:#c0c0c0;margin:4px 0;">Elevated:</p>`;
    html += `<div style="padding-left:8px;">`;
    for (const b of elevated) {
      html += `<p style="margin:3px 0;color:#a78bfa;font-size:12px;">• Week ${b.week_number}: ${b.title} → ${b.elevated_to || 'project'}</p>`;
    }
    html += `</div>`;
  } else {
    html += `<p style="color:#5a5a5a;font-size:12px;">Elevated: none yet</p>`;
  }

  html += `<p style="color:${onTrack ? '#7ee787' : '#ff6b6b'};margin:8px 0 0 0;font-size:12px;">On track: ${onTrack ? 'yes' : 'no — ' + (weeksElapsed - shipped.length) + ' week(s) behind'}</p>`;
  return html;
}

// ── Ideas captured audit section ─────────────────────────────────────────────

function buildIdeasCapturedHtml() {
  const total    = db.prepare(`SELECT COUNT(*) AS n FROM ideas WHERE date(captured_at) >= date('now', '-30 days')`).get().n;
  const actioned = db.prepare(`SELECT COUNT(*) AS n FROM ideas WHERE date(captured_at) >= date('now', '-30 days') AND status IN ('actioned','reviewed')`).get().n;
  const raw      = db.prepare(`SELECT COUNT(*) AS n FROM ideas WHERE date(captured_at) >= date('now', '-30 days') AND status = 'raw'`).get().n;
  const topRaw   = db.prepare(`
    SELECT i.idea_text, p.name AS project_name FROM ideas i
    LEFT JOIN projects p ON i.project_id = p.id
    WHERE i.status = 'raw'
    ORDER BY i.captured_at DESC LIMIT 1
  `).get();

  let html = `<hr style="border-color:#2a2a2a;margin:28px 0">`;
  html += `<h2 style="color:#a78bfa;margin-top:0;margin-bottom:8px;">IDEAS CAPTURED THIS MONTH</h2>`;
  html += `<p style="color:#c0c0c0;margin:4px 0;">Total: <strong>${total}</strong> &nbsp;|&nbsp; Actioned: ${actioned} &nbsp;|&nbsp; Still raw: ${raw}</p>`;
  if (topRaw) {
    const preview = topRaw.idea_text.slice(0, 80) + (topRaw.idea_text.length > 80 ? '…' : '');
    html += `<p style="color:#5a5a5a;font-size:12px;margin:8px 0 0 0;">Top unreviewed: "${preview}"${topRaw.project_name ? ` (${topRaw.project_name})` : ''}</p>`;
  }
  return html;
}

// ── Network growth audit section ─────────────────────────────────────────────

function buildNetworkGrowthHtml() {
  const monthStart = new Date();
  monthStart.setDate(1);
  const monthStr = monthStart.toISOString().slice(0, 10);

  const newContacts = db.prepare(`
    SELECT COUNT(*) AS n FROM network_contacts
    WHERE date(created_at) >= ?
  `).get(monthStr).n;

  const eventsAttended = db.prepare(`
    SELECT COUNT(*) AS n FROM events_log
    WHERE attended = 1
      AND event_date >= ?
  `).get(monthStr).n;

  const outreachWeeksHit = db.prepare(`
    SELECT COUNT(*) AS n FROM networking_goals
    WHERE week_of >= ?
      AND actual_outreach >= target_outreach
  `).get(monthStr).n;

  const totalWeeks = db.prepare(`
    SELECT COUNT(*) AS n FROM networking_goals WHERE week_of >= ?
  `).get(monthStr).n;

  const strongest = db.prepare(`
    SELECT * FROM network_contacts ORDER BY relationship_strength DESC LIMIT 1
  `).get();

  const weakestArea = outreachWeeksHit === 0
    ? 'outreach (zero weeks hit)'
    : eventsAttended === 0
    ? 'events (none attended this month)'
    : 'consistency (not all weeks hit)';

  const onTrack = totalWeeks > 0 && (outreachWeeksHit / totalWeeks) >= 0.75;

  let html = `<hr style="border-color:#2a2a2a;margin:28px 0">`;
  html += `<h2 style="color:#7ee787;margin-top:0;margin-bottom:12px;">NETWORK GROWTH</h2>`;
  html += (
    `<p style="color:#c0c0c0;margin:4px 0;">` +
    `New contacts: <strong>${newContacts}</strong> &nbsp;|&nbsp; ` +
    `Events attended: <strong>${eventsAttended}</strong> &nbsp;|&nbsp; ` +
    `Outreach weeks: <strong style="color:${onTrack ? '#7ee787' : '#ff6b6b'}">${outreachWeeksHit} / ${totalWeeks}</strong>` +
    `</p>`
  );

  if (strongest) {
    html += `<p style="color:#5a5a5a;font-size:12px;margin:6px 0;">Strongest connection: ${strongest.name}${strongest.context ? ` (${strongest.context})` : ''}</p>`;
  }

  html += `<p style="color:${onTrack ? '#7ee787' : '#ff6b6b'};font-size:12px;margin:6px 0;">Weakest area this month: ${weakestArea}</p>`;

  return html;
}

// ── Core send function ────────────────────────────────────────────────────────

async function sendMonthlyAudit() {
  const month = monthKey();

  const existing = db.prepare('SELECT id FROM monthly_audits WHERE month = ?').get(month);
  if (existing) {
    console.log(`[monthlyAudit] Already sent for ${month} — skipping.`);
    return null;
  }

  const tasks           = queryMonthTasks();
  const projects        = queryAllProjects();
  const grouped         = groupByProject(tasks);
  const constraints     = queryAuditableConstraints();
  const networkContacts = queryMonthNetworkContacts();
  const staleIdeas      = queryStaleIdeas();

  const aiResponse = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'user', content: buildUserPrompt(grouped, projects, networkContacts, staleIdeas) },
    ],
  });

  const rawText = aiResponse.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  const { scoresJson, driftFlags, emailText } = parseAuditResponse(rawText);

  const label    = monthLabel();
  const subject  = `Monthly Audit — ${label}`;
  const replyTag = `monthly-audit-${month}`;

  let htmlBody = auditToHtml(emailText);
  htmlBody    += buildRoutineAuditHtml(constraints);
  htmlBody    += buildBuildsAuditHtml();
  htmlBody    += buildIdeasCapturedHtml();
  htmlBody    += buildNetworkGrowthHtml();

  await sendEmail(subject, htmlBody, replyTag);

  const resetStats = runMonthlyReset();

  db.prepare(`
    INSERT INTO monthly_audits (month, scores_json, drift_flags, reset_notes, sent_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(
    month,
    JSON.stringify(scoresJson),
    driftFlags.length ? driftFlags.join('\n') : null,
    `${resetStats.archived} archived, ${resetStats.surfaced} surfaced to critical`
  );

  console.log(`[monthlyAudit] Sent  : "${subject}" | tag: ${replyTag}`);
  console.log(`[monthlyAudit] Scores: ${JSON.stringify(scoresJson)}`);
  console.log(`[monthlyAudit] Drift : ${driftFlags.length} project(s) flagged`);
  console.log(`[monthlyAudit] Routine audit: ${constraints.length} constraint(s) included`);
  console.log(`[monthlyAudit] Tokens: in=${aiResponse.usage.input_tokens} out=${aiResponse.usage.output_tokens} cache_read=${aiResponse.usage.cache_read_input_tokens ?? 0}`);

  return { month, scoresJson, driftFlags, resetStats, replyTag, constraintsAudited: constraints.length };
}

// ── Cron scheduler ────────────────────────────────────────────────────────────

function startScheduler() {
  cron.schedule('0 20 * * 5', () => {
    if (!isLastFridayOfMonth()) return;
    console.log('[monthlyAudit] Last Friday of month — running audit...');
    sendMonthlyAudit().catch(err => {
      console.error('[monthlyAudit] Error during scheduled run:', err.message);
    });
  }, {
    timezone: 'Asia/Kolkata',
  });

  console.log('[monthlyAudit] Scheduler started — fires on last Friday of each month at 8:00 PM IST.');
}

module.exports = { sendMonthlyAudit, startScheduler, isLastFridayOfMonth, parseAuditConstraintReplies };
