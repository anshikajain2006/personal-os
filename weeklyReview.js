'use strict';

const cron      = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');
const db        = require('./db');
const { sendEmail, parseReplyTag } = require('./email');

const { getCurrentBuildWeek } = require('./db');
const { createBuildFromReply } = require('./buildWeek');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Date helpers ──────────────────────────────────────────────────────────────

function getWeekStart() {
  const d = new Date();
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ── DB queries ────────────────────────────────────────────────────────────────

function queryWeeklyTaskActivity() {
  const since = daysAgoISO(7);
  return db.prepare(`
    SELECT
      t.id, t.title, t.priority, t.status, t.deadline,
      t.estimated_minutes, t.updated_at, t.created_at,
      COALESCE(p.name, 'Unassigned') AS project_name
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE date(t.updated_at) >= ?
       OR date(t.created_at) >= ?
    ORDER BY t.updated_at DESC
  `).all(since, since);
}

function queryStuckTasks() {
  const cutoff = daysAgoISO(7);
  return db.prepare(`
    SELECT
      t.id, t.title, t.priority, t.status, t.deadline,
      COALESCE(p.name, 'Unassigned') AS project_name
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.status NOT IN ('done', 'cancelled')
      AND date(t.updated_at) < ?
    ORDER BY
      CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC
  `).all(cutoff);
}

function getExistingReview(weekStart) {
  return db.prepare(
    `SELECT * FROM weekly_reviews WHERE week_start_date = ?`
  ).get(weekStart);
}

// ── Networking helpers ────────────────────────────────────────────────────────

function ensureNetworkingGoal(weekStart) {
  db.prepare(`
    INSERT INTO networking_goals (week_of, target_outreach, target_events)
    VALUES (?, 1, 0)
    ON CONFLICT(week_of) DO NOTHING
  `).run(weekStart);
}

async function searchUpcomingEvents() {
  const today = new Date().toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

  const messages = [{
    role: 'user',
    content: `Today is ${today}.

Search for upcoming tech, startup, AI, and entrepreneurship events in Kolkata and Chennai in the next 30 days. Also search for upcoming hackathons in India (online or offline) in the next 30 days.

The user is a 20-year-old CS undergrad and co-founder building an AI startup (Autumn) and running business development for a media company (Matrix Media Solutions).

For each event found, evaluate:
- Is it relevant to: AI/tech, startups, media, sales, founder community?
- Is it accessible from Kolkata or Chennai?
- Would it help with: Matrix clients, Autumn visibility, personal brand, or Lumiere-adjacent skills?

Return max 4 events in this exact format:

EVENT: [name]
Date: [date]
Location: [city / online]
Why go: [1 sentence connecting to their actual goals]
Relevance: [Matrix / Autumn / Brand / General networking]`,
  }];

  const tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  let finalText = '(No events found.)';
  const MAX_ITER = 5;

  for (let i = 0; i < MAX_ITER; i++) {
    let response;
    try {
      response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        tools,
        messages,
      });
    } catch (err) {
      console.error('[weeklyReview] searchUpcomingEvents API error:', err.message);
      break;
    }

    const textBlocks = response.content.filter(b => b.type === 'text');
    if (textBlocks.length) finalText = textBlocks.map(b => b.text).join('');

    if (response.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: response.content });

    const toolUses    = response.content.filter(b => b.type === 'tool_use');
    const toolResults = response.content.filter(b => b.type === 'tool_result');

    const userContent = toolResults.length > 0
      ? toolResults.map(b => ({ type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content }))
      : toolUses.map(tu => ({ type: 'tool_result', tool_use_id: tu.id, content: [{ type: 'text', text: 'Search executed.' }] }));

    messages.push({ role: 'user', content: userContent });
  }

  return finalText;
}

function eventsToHtml(text) {
  if (!text || /no events found/i.test(text) || text.trim().length < 20) {
    return `<p style="color:#5a5a5a;font-size:12px;">No upcoming events found this cycle.</p>`;
  }

  // Split on "EVENT:" blocks
  const blocks = text.split(/(?=^EVENT:)/im).filter(b => b.trim());
  if (!blocks.length) {
    // Fallback: plain paragraph
    return `<p style="color:#a0a0a0;font-size:13px;">${text.trim()}</p>`;
  }

  let html = '';
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const fields = {};
    for (const l of lines) {
      const m = l.match(/^(EVENT|Date|Location|Why go|Relevance):\s*(.+)/i);
      if (m) fields[m[1].toLowerCase().replace(' ', '_')] = m[2].trim();
    }
    if (!fields.event) continue;

    const relevanceColor = {
      matrix:  '#58a6ff',
      autumn:  '#a78bfa',
      brand:   '#e3b341',
    }[(fields.relevance || '').toLowerCase()] || '#7ee787';

    html += (
      `<div style="margin:10px 0;padding:10px 14px;border-left:3px solid #e3b341;` +
      `background:#1a1a1a;border-radius:2px;">` +
      `<p style="margin:0 0 4px 0;"><strong style="color:#e3b341">${fields.event}</strong>` +
      (fields.relevance
        ? ` <span style="color:${relevanceColor};font-size:11px;margin-left:8px;">[${fields.relevance}]</span>`
        : '') +
      `</p>` +
      (fields.date || fields.location
        ? `<p style="margin:0 0 3px 0;color:#808080;font-size:12px;">${[fields.date, fields.location].filter(Boolean).join(' · ')}</p>`
        : '') +
      (fields.why_go
        ? `<p style="margin:0;color:#c0c0c0;font-size:12px;">${fields.why_go}</p>`
        : '') +
      `</div>`
    );
  }
  return html || `<p style="color:#5a5a5a;font-size:12px;">No events matched your profile this cycle.</p>`;
}

function parseAndSaveEvents(text, weekStart) {
  if (!text || text.trim().length < 20) return;

  const blocks = text.split(/(?=^EVENT:)/im).filter(b => b.trim());
  let saved = 0;

  for (const block of blocks) {
    const lines  = block.trim().split('\n');
    const fields = {};
    for (const l of lines) {
      const m = l.match(/^(EVENT|Date|Location|Why go|Relevance):\s*(.+)/i);
      if (m) fields[m[1].toLowerCase().replace(' ', '_')] = m[2].trim();
    }
    if (!fields.event) continue;
    if (db.prepare(`SELECT id FROM events_log WHERE event_name = ? LIMIT 1`).get(fields.event)) continue;

    const eventType = /hackathon/i.test(fields.event + (fields.why_go || ''))
      ? 'hackathon'
      : /meetup/i.test(fields.event)
      ? 'meetup'
      : 'networking';

    db.prepare(`
      INSERT INTO events_log (event_name, event_date, location, event_type, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      fields.event,
      fields.date   || null,
      fields.location || null,
      eventType,
      fields.why_go || null,
    );
    saved++;
  }

  if (saved > 0) console.log(`[weeklyReview] Saved ${saved} new event(s) to events_log`);
}

function parseEventAttendance(replyText) {
  const matches = [...replyText.matchAll(/\battend\s+(.+?)(?:\.|,|\n|$)/gi)];
  if (!matches.length) return 0;

  const personalBrand = db.prepare(
    `SELECT id FROM projects WHERE name LIKE '%Personal Brand%' LIMIT 1`
  ).get();

  let added = 0;
  for (const m of matches) {
    const eventName = m[1].trim();
    if (!eventName || eventName.length < 3) continue;

    const event = db.prepare(
      `SELECT * FROM events_log WHERE event_name LIKE ? LIMIT 1`
    ).get(`%${eventName.slice(0, 20)}%`);

    if (!event) {
      db.prepare(
        `INSERT INTO events_log (event_name, event_type) VALUES (?, 'networking')`
      ).run(eventName);
    }

    db.prepare(`
      INSERT INTO tasks (project_id, title, priority, deadline, status)
      VALUES (?, ?, 'medium', ?, 'todo')
    `).run(
      personalBrand?.id || null,
      `Attend: ${eventName}`,
      event?.event_date || null,
    );

    added++;
    console.log(`[weeklyReview] Attend task created: "${eventName}"`);
  }
  return added;
}

async function parseNetworkingUpdate(replyText, weekStart) {
  const isNone = /\bnone\b/i.test(replyText) &&
    !/\b(reached out|messaged|contacted|connected|met|coffee|chat)\b/i.test(replyText);

  if (isNone) {
    db.prepare(
      `UPDATE networking_goals SET actual_outreach = 0 WHERE week_of = ?`
    ).run(weekStart);

    // Create a Monday task so the miss gets actioned
    const nextMonday = new Date();
    const dayOfWeek  = nextMonday.getDay();
    nextMonday.setDate(nextMonday.getDate() + (dayOfWeek === 0 ? 1 : 8 - dayOfWeek));
    const mondayStr = nextMonday.toISOString().slice(0, 10);

    const personalBrand = db.prepare(
      `SELECT id FROM projects WHERE name LIKE '%Personal Brand%' LIMIT 1`
    ).get();

    db.prepare(`
      INSERT INTO tasks (project_id, title, priority, deadline, status)
      VALUES (?, 'Reach out to 1 person this week', 'high', ?, 'todo')
    `).run(personalBrand?.id || null, mondayStr);

    console.log(`[weeklyReview] Networking missed — "Reach out" task created for ${mondayStr}`);

    const contact = db.prepare(`
      SELECT * FROM network_contacts
      WHERE follow_up_due IS NOT NULL AND follow_up_due <= date('now', '+7 days')
      ORDER BY follow_up_due ASC LIMIT 1
    `).get() || db.prepare(
      `SELECT * FROM network_contacts ORDER BY last_contacted ASC NULLS FIRST LIMIT 1`
    ).get();

    if (contact) {
      console.log(`[weeklyReview] Warm suggestion: "${contact.name}"`);
    }
    return { missed: true, suggested: contact?.name || null };
  }

  if (/\b(reached out|messaged|contacted|connected with|met|coffee|chat|outreach|follow.?up)\b/i.test(replyText)) {
    db.prepare(
      `UPDATE networking_goals SET actual_outreach = actual_outreach + 1 WHERE week_of = ?`
    ).run(weekStart);
    console.log(`[weeklyReview] Networking update: outreach recorded for week ${weekStart}`);
    return { missed: false };
  }

  return null;
}

// ── Priority bump logic ───────────────────────────────────────────────────────

const PRIORITY_UP = { low: 'medium', medium: 'high', high: 'critical', critical: 'critical' };

function bumpStuckTasksByMention(mentionText) {
  if (!mentionText) return [];

  const allOpen = db.prepare(`
    SELECT id, title, priority FROM tasks
    WHERE status NOT IN ('done','cancelled')
  `).all();

  const bumped = [];
  const updatePriority = db.prepare(
    `UPDATE tasks SET priority = ?, updated_at = datetime('now') WHERE id = ?`
  );

  for (const task of allOpen) {
    const titleWords = task.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const mentioned  = titleWords.some(w => mentionText.toLowerCase().includes(w));

    if (mentioned) {
      const newPriority = PRIORITY_UP[task.priority] || task.priority;
      if (newPriority !== task.priority) {
        updatePriority.run(newPriority, task.id);
        bumped.push({ id: task.id, title: task.title, from: task.priority, to: newPriority });
      }
    }
  }

  return bumped;
}

// ── New constraint parsing ────────────────────────────────────────────────────

// Quick signal check before spending API tokens.
const HABIT_SIGNALS = /\b(habit|routine|daily|every day|every morning|every night|cold shower|workout|gym|read\b|pages|meditate|journal|walk|run|stretch|fast|constraint|want to start|going to start|starting)\b/i;

// Uses Claude Haiku to extract a new habit/constraint from free-text.
// Returns { title, frequency, expires_at, description } or null.
async function parseNewConstraint(text) {
  if (!text || text.length < 5) return null;
  if (!HABIT_SIGNALS.test(text)) return null;

  let response;
  try {
    response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `Extract a new habit or constraint the user wants to START tracking from this text.
Only extract if they are clearly stating intent to add a new habit/routine.
If found, return ONLY valid JSON: {"title": "...", "frequency": "daily" or "weekly-MON" or "weekly-MON,WED,FRI" etc, "expires_at": "YYYY-MM-DD" or null, "description": "..." or null}
If no new habit found, return the word: null

Text: ${JSON.stringify(text.slice(0, 600))}`,
      }],
    });
  } catch (err) {
    console.error('[weeklyReview] parseNewConstraint API error:', err.message);
    return null;
  }

  const raw = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (/^null$/i.test(raw)) return null;

  try {
    const match = raw.match(/\{[\s\S]+?\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    return parsed.title ? parsed : null;
  } catch {
    return null;
  }
}

// Inserts a parsed constraint into the DB and creates a linked recurring task.
function createConstraintFromParsed(parsed) {
  const posProject = db.prepare(
    `SELECT id FROM projects WHERE name = 'Personal Operating System' LIMIT 1`
  ).get();
  const projectId = posProject?.id || null;
  const today     = new Date().toISOString().slice(0, 10);

  const constraintId = db.prepare(`
    INSERT INTO constraints (title, description, frequency, started_at, expires_at, status, project_id)
    VALUES (?, ?, ?, ?, ?, 'active', ?)
  `).run(
    parsed.title,
    parsed.description || null,
    parsed.frequency   || 'daily',
    today,
    parsed.expires_at  || null,
    projectId,
  ).lastInsertRowid;

  db.prepare(`
    INSERT INTO tasks (project_id, title, priority, recurrence, status)
    VALUES (?, ?, 'medium', ?, 'todo')
  `).run(projectId, parsed.title, parsed.frequency || 'daily');

  console.log(`[weeklyReview] New constraint added: "${parsed.title}" (${parsed.frequency || 'daily'}), id: ${constraintId}`);
  return constraintId;
}

// ── Prompt construction ───────────────────────────────────────────────────────

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

Generate a weekly review for Anshhika. Cover exactly these five sections, in this order:

1. WINS THIS WEEK
What actually moved forward across Matrix, Lumiere, Corelinq, Instagram, LinkedIn, and jobs pipeline. Only real wins — tasks completed, conversations had, things shipped.

2. SLIPPAGE
What was planned but didn't happen, and why. Be honest. No softening. Name what was avoided.

3. NORTH STAR CHECK
Does what she did this week compound toward generational wealth and the life she is building? What was signal vs noise?
One sentence verdict.

4. NEXT WEEK PRIORITIES
Ranked by impact. Maximum 5 items across all tracks. Not more than 5. Each one must connect to a north star.

5. ONE THING
If she could only do one thing next week that moves the needle most, what is it? One sentence, no hedging.

Format: clean, direct, no fluff, no motivational language. Treat her like a founder reviewing her own company.
Output plain text only. No markdown, no asterisks, no backticks.
Use exactly these section headers: WINS THIS WEEK / SLIPPAGE / NORTH STAR CHECK / NEXT WEEK PRIORITIES / ONE THING`;

function buildUserPrompt(active, stuck) {
  const weekOf = new Date().toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

  const completed  = active.filter(t => t.status === 'done');
  const inProgress = active.filter(t => t.status === 'in_progress');
  const blocked    = active.filter(t => t.status === 'blocked');
  const newTasks   = active.filter(t => {
    return date(t.created_at) >= daysAgoISO(7) && t.status !== 'done';
  });

  function taskLine(t) {
    const due = t.deadline ? ` — due ${t.deadline}` : '';
    return `  • [${t.priority.toUpperCase()}] ${t.title} (${t.project_name})${due}`;
  }

  let block = `Week of ${weekOf}\n\n`;

  block += `COMPLETED THIS WEEK (${completed.length}):\n`;
  block += completed.length ? completed.map(taskLine).join('\n') : '  (none)';
  block += '\n\n';

  block += `IN PROGRESS (${inProgress.length}):\n`;
  block += inProgress.length ? inProgress.map(taskLine).join('\n') : '  (none)';
  block += '\n\n';

  block += `BLOCKED (${blocked.length}):\n`;
  block += blocked.length ? blocked.map(taskLine).join('\n') : '  (none)';
  block += '\n\n';

  block += `STUCK (not touched in 7+ days, ${stuck.length} tasks):\n`;
  block += stuck.length ? stuck.map(taskLine).join('\n') : '  (none)';
  block += '\n\n';

  block += `NEW TASKS ADDED THIS WEEK (${newTasks.length}):\n`;
  block += newTasks.length ? newTasks.map(taskLine).join('\n') : '  (none)';

  return (
    block +
    `\n\nGenerate the Weekly Review using exactly this format:\n\n` +
    `[WEEK OF ${weekOf.toUpperCase()}] WEEKLY REVIEW\n\n` +
    `WINS THIS WEEK\n[wins]\n\n` +
    `SLIPPAGE\n[what didn't happen]\n\n` +
    `NORTH STAR CHECK\n[one sentence verdict]\n\n` +
    `NEXT WEEK PRIORITIES\n• ...\n• ...\n• ...\n\n` +
    `ONE THING\n[one sentence]`
  );
}

function date(isoDatetime) {
  return isoDatetime ? isoDatetime.slice(0, 10) : '';
}

// ── Plain-text → HTML conversion ──────────────────────────────────────────────

const SECTION_COLORS = {
  'WINS THIS WEEK':       '#7ee787',
  'SLIPPAGE':             '#ff6b6b',
  'NORTH STAR CHECK':     '#a78bfa',
  'NEXT WEEK PRIORITIES': '#e3b341',
  'ONE THING':            '#58a6ff',
};

function reviewToHtml(text) {
  const lines = text.split('\n');
  let html = '';
  let inSection = false;

  const closeSection = () => {
    if (inSection) { html += '</div>'; inSection = false; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line) {
      html += '<div style="height:8px"></div>';
      continue;
    }

    if (/WEEKLY REVIEW/.test(line)) {
      closeSection();
      html += `<h1>${line}</h1>`;
      continue;
    }

    const sectionKey = Object.keys(SECTION_COLORS).find(k => line.trim() === k);
    if (sectionKey) {
      closeSection();
      html += `<h2 style="color:${SECTION_COLORS[sectionKey]};margin-top:22px;margin-bottom:8px;">${sectionKey}</h2>`;
      html += `<div style="padding-left:4px;color:#c0c0c0;line-height:1.75;">`;
      inSection = true;
      continue;
    }

    if (inSection) {
      if (line.trimStart().startsWith('•')) {
        const content = line.trimStart().slice(1).trim();
        html += `<p style="margin:4px 0;">• ${content}</p>`;
      } else {
        html += `<p style="margin:4px 0">${line}</p>`;
      }
    } else {
      html += `<p style="color:#5a5a5a;font-size:12px;">${line}</p>`;
    }
  }

  closeSection();
  return html;
}

// ── Reply detection helpers ───────────────────────────────────────────────────

function replyHasContentIdeas(text) {
  if (!text || text.trim().length < 30) return false;
  return (
    /post about|write about|linkedin|content idea|topic[: ]|angle[: ]/i.test(text) ||
    /^\s*\d+\./m.test(text)
  );
}

// ── Reply handler ─────────────────────────────────────────────────────────────

async function handleReply(emailBody) {
  const tag = parseReplyTag(emailBody);
  if (!tag || !tag.startsWith('weekly-review-')) return null;

  const weekStart = tag.replace('weekly-review-', '');
  const review    = db.prepare(
    `SELECT * FROM weekly_reviews WHERE week_start_date = ?`
  ).get(weekStart);

  if (!review) {
    console.warn(`[weeklyReview] No review found for week ${weekStart}`);
    return null;
  }

  const replyText = emailBody
    .split('\n')
    .filter(l => !/\[reply-tag:/i.test(l) && !/<!--\s*reply-tag:/i.test(l))
    .join('\n')
    .trim();

  const paragraphs       = replyText.split(/\n{2,}/);
  const what_moved       = paragraphs[0] || replyText;
  const what_didnt       = paragraphs[1] || null;
  const decisions_needed = paragraphs[2] || null;
  const hasIdeas         = replyHasContentIdeas(replyText);

  db.prepare(`
    UPDATE weekly_reviews
    SET what_moved            = ?,
        what_didnt            = ?,
        decisions_needed      = ?,
        content_ideas_replied = ?,
        replied_at            = datetime('now')
    WHERE week_start_date = ?
  `).run(what_moved, what_didnt, decisions_needed, hasIdeas ? 1 : 0, weekStart);

  const allReplyText = [what_moved, what_didnt, decisions_needed].filter(Boolean).join(' ');
  const bumped = bumpStuckTasksByMention(allReplyText);

  if (bumped.length) {
    console.log(`[weeklyReview] Priority bumped for ${bumped.length} task(s):`);
    for (const b of bumped) console.log(`  "${b.title}": ${b.from} → ${b.to}`);
  } else {
    console.log('[weeklyReview] Reply stored. No tasks matched for priority bump.');
  }

  // Check for a new habit/constraint to add
  let newConstraintId = null;
  try {
    const parsed = await parseNewConstraint(replyText);
    if (parsed) {
      newConstraintId = createConstraintFromParsed(parsed);
    }
  } catch (err) {
    console.error('[weeklyReview] Constraint parsing error:', err.message);
  }

  // Ideas inbox review acknowledgement
  if (/\breviewed\b/i.test(replyText)) {
    const updated = db.prepare(`UPDATE ideas SET status = 'reviewed' WHERE status = 'raw'`).run().changes;
    if (updated > 0) console.log(`[weeklyReview] ${updated} raw idea(s) marked reviewed`);
  }

  // Check for a build idea in the reply
  let newBuild = null;
  try {
    const buildWeekNum = getCurrentBuildWeek();
    newBuild = await createBuildFromReply(replyText, buildWeekNum);
  } catch (err) {
    console.error('[weeklyReview] Build reply parsing error:', err.message);
  }

  // Check for event attendance intent
  let attendedEvents = 0;
  try {
    attendedEvents = parseEventAttendance(replyText);
  } catch (err) {
    console.error('[weeklyReview] Event attendance parsing error:', err.message);
  }

  // Check for networking update
  let networkingUpdate = null;
  try {
    networkingUpdate = await parseNetworkingUpdate(replyText, weekStart);
  } catch (err) {
    console.error('[weeklyReview] Networking update error:', err.message);
  }

  console.log(`[weeklyReview] content_ideas_replied: ${hasIdeas ? 'yes' : 'no'}`);
  if (newConstraintId) console.log(`[weeklyReview] New constraint created: id ${newConstraintId}`);
  if (newBuild) console.log(`[weeklyReview] Build logged: "${newBuild.title}"`);
  if (attendedEvents > 0) console.log(`[weeklyReview] Event tasks created: ${attendedEvents}`);
  if (networkingUpdate) {
    console.log(`[weeklyReview] Networking: ${networkingUpdate.missed ? 'missed' : 'recorded'}${networkingUpdate.suggested ? ', suggested: ' + networkingUpdate.suggested : ''}`);
  }

  return { weekStart, what_moved, what_didnt, decisions_needed, bumped, newConstraintId, newBuild, attendedEvents, networkingUpdate };
}

// ── Core send function ────────────────────────────────────────────────────────

async function sendWeeklyReview() {
  const weekStart = getWeekStart();

  if (getExistingReview(weekStart)) {
    console.log(`[weeklyReview] Already sent for week ${weekStart} — skipping.`);
    return null;
  }

  const active = queryWeeklyTaskActivity();
  const stuck  = queryStuckTasks();

  if (active.length === 0 && stuck.length === 0) {
    console.log('[weeklyReview] No task activity this week — skipping.');
    return null;
  }

  const aiResponse = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'user', content: buildUserPrompt(active, stuck) },
    ],
  });

  const reviewText = aiResponse.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  const winsMatch       = reviewText.match(/WINS THIS WEEK\n([\s\S]*?)(?=\nSLIPPAGE\n|$)/i);
  const slippageMatch   = reviewText.match(/SLIPPAGE\n([\s\S]*?)(?=\nNORTH STAR CHECK\n|$)/i);
  const prioritiesMatch = reviewText.match(/NEXT WEEK PRIORITIES\n([\s\S]*?)(?=\nONE THING\n|$)/i);

  const what_moved       = winsMatch?.[1]?.trim()       || null;
  const what_didnt       = slippageMatch?.[1]?.trim()   || null;
  const decisions_needed = prioritiesMatch?.[1]?.trim() || null;

  const displayDate = new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const subject  = `Weekly Review — ${displayDate}`;
  const replyTag = `weekly-review-${weekStart}`;

  // Event discovery (runs alongside HTML construction)
  let eventsText = '(No events found.)';
  try {
    eventsText = await searchUpcomingEvents();
    parseAndSaveEvents(eventsText, weekStart);
  } catch (err) {
    console.error('[weeklyReview] Event search failed:', err.message);
  }

  let htmlBody = reviewToHtml(reviewText);

  // Content section
  htmlBody += `
    <hr style="border-color:#2a2a2a;margin:24px 0">
    <h2 style="color:#58a6ff;margin-top:0;margin-bottom:8px;">CONTENT — next week's posts</h2>
    <p style="color:#c0c0c0;">You have 3 slots: <strong>Mon</strong> (dad's LinkedIn) &bull; <strong>Tue</strong> (yours) &bull; <strong>Thu</strong> (yours).</p>
    <p style="color:#c0c0c0;">Any ideas? Reply with them or say nothing — I'll research Saturday morning.</p>`;

  // Ideas inbox
  const unreviewedIdeas = db.prepare(`SELECT COUNT(*) AS n FROM ideas WHERE status = 'raw'`).get().n;
  if (unreviewedIdeas > 0) {
    htmlBody += `
      <hr style="border-color:#2a2a2a;margin:24px 0">
      <h2 style="color:#a78bfa;margin-top:0;margin-bottom:8px;">IDEAS INBOX — ${unreviewedIdeas} unreviewed</h2>
      <p style="color:#c0c0c0;">${unreviewedIdeas} idea${unreviewedIdeas !== 1 ? 's' : ''} sitting in your inbox. Review them this weekend?</p>
      <p style="color:#5a5a5a;font-size:12px;">Reply "reviewed" when done, or flag specific ones to action.</p>`;
  }

  // New habit/constraint prompt
  htmlBody += `
    <hr style="border-color:#2a2a2a;margin:24px 0">
    <h2 style="color:#a78bfa;margin-top:0;margin-bottom:8px;">NEXT WEEK — NEW HABIT?</h2>
    <p style="color:#c0c0c0;">Any new habit or constraint to add to your routine?</p>
    <p style="color:#5a5a5a;font-size:12px;">Reply like: "cold shower daily — 2 weeks" and I'll add it to your tracker automatically.</p>`;

  // 52 Builds section
  const buildWeekNum = getCurrentBuildWeek();
  const currentBuild = db.prepare(
    `SELECT * FROM builds WHERE week_number = ? LIMIT 1`
  ).get(buildWeekNum);

  htmlBody += `
    <hr style="border-color:#2a2a2a;margin:24px 0">
    <h2 style="color:#e3b341;margin-top:0;margin-bottom:8px;">52 BUILDS — WEEK ${buildWeekNum}</h2>`;

  if (currentBuild) {
    const statusColor = currentBuild.status === 'shipped' ? '#7ee787'
      : currentBuild.status === 'building' ? '#58a6ff'
      : '#e3b341';
    htmlBody += `<p style="color:#c0c0c0;">This week: <strong style="color:${statusColor}">${currentBuild.title}</strong> — <span style="color:${statusColor}">${currentBuild.status}</span></p>`;
    htmlBody += `<p style="color:#5a5a5a;font-size:12px;">Update status, or reply below if you want to change course.</p>`;
  } else {
    htmlBody += `<p style="color:#c0c0c0;">What are you building this week? Reply with your idea.</p>`;
    htmlBody += `<p style="color:#5a5a5a;font-size:12px;">If you say nothing, I'll send you 5 options Saturday morning.</p>`;
  }

  // Events section
  htmlBody += `
    <hr style="border-color:#2a2a2a;margin:24px 0">
    <h2 style="color:#e3b341;margin-top:0;margin-bottom:8px;">EVENTS THIS MONTH — worth your time</h2>
    ${eventsToHtml(eventsText)}
    <p style="color:#5a5a5a;font-size:12px;">Reply "attend [event name]" to add it as a task.</p>`;

  // Networking section
  htmlBody += `
    <hr style="border-color:#2a2a2a;margin:24px 0">
    <h2 style="color:#7ee787;margin-top:0;margin-bottom:8px;">NETWORK THIS WEEK</h2>
    <p style="color:#c0c0c0;">Target: 1 new person reached out to. Follow up within 24 hrs.</p>
    <p style="color:#c0c0c0;">Reply with who you reached out to and how it went, or <strong>none</strong> if you didn't.</p>`;

  ensureNetworkingGoal(weekStart);
  await sendEmail(subject, htmlBody, replyTag);

  db.prepare(`
    INSERT INTO weekly_reviews
      (week_start_date, what_moved, what_didnt, decisions_needed, sent_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(weekStart, what_moved, what_didnt, decisions_needed);

  console.log(`[weeklyReview] Sent  : "${subject}" | tag: ${replyTag}`);
  console.log(`[weeklyReview] Tokens: in=${aiResponse.usage.input_tokens} out=${aiResponse.usage.output_tokens} cache_read=${aiResponse.usage.cache_read_input_tokens ?? 0}`);

  return { reviewText, replyTag, weekStart };
}

// ── Cron scheduler ────────────────────────────────────────────────────────────

function startScheduler() {
  cron.schedule('0 20 * * 5', () => {
    console.log('[weeklyReview] Cron triggered — running weekly review...');
    sendWeeklyReview().catch(err => {
      console.error('[weeklyReview] Error during scheduled run:', err.message);
    });
  }, {
    timezone: 'Asia/Kolkata',
  });

  console.log('[weeklyReview] Scheduler started — fires every Friday at 8:00 PM IST.');
}

module.exports = { sendWeeklyReview, handleReply, startScheduler, getWeekStart };
