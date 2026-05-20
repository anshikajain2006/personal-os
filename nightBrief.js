'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const db        = require('./db');
const { sendEmail } = require('./email');

const { getCurrentBuildWeek } = require('./db');
const { gatherDailyFlags, buildDailyFlagsHtml } = require('./dailyFlags');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── DB queries ────────────────────────────────────────────────────────────────

function queryActiveTasks() {
  return db.prepare(`
    SELECT
      t.id, t.title, t.description, t.priority, t.deadline,
      t.estimated_minutes, t.status,
      COALESCE(p.name, 'Unassigned') AS project_name
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.status NOT IN ('done', 'cancelled')
    ORDER BY
      CASE WHEN t.deadline IS NULL THEN 1 ELSE 0 END ASC,
      t.deadline ASC,
      CASE t.priority
        WHEN 'critical' THEN 0
        WHEN 'high'     THEN 1
        WHEN 'medium'   THEN 2
        WHEN 'low'      THEN 3
        ELSE 4
      END ASC
  `).all();
}

function groupByProject(tasks) {
  const groups = {};
  for (const task of tasks) {
    if (!groups[task.project_name]) groups[task.project_name] = [];
    groups[task.project_name].push(task);
  }
  return groups;
}

// ── Book helpers ──────────────────────────────────────────────────────────────

function queryRecentlyFinishedBook() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  return db.prepare(`
    SELECT * FROM books
    WHERE status = 'done'
      AND finished_at >= ?
    ORDER BY finished_at DESC
    LIMIT 1
  `).get(cutoff.toISOString().slice(0, 10)) || null;
}

function getNextBook(current) {
  return db.prepare(`
    SELECT * FROM books
    WHERE status IN ('unread', 'reading')
      AND order_rank > ?
    ORDER BY order_rank ASC
    LIMIT 1
  `).get(current.order_rank) || null;
}

// ── Constraint helpers ────────────────────────────────────────────────────────

// Auto-retire constraints that have passed their expires_at date.
function retireExpiredConstraints(today) {
  const n = db.prepare(`
    UPDATE constraints
    SET status = 'retired'
    WHERE status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at < ?
  `).run(today).changes;
  if (n > 0) console.log(`[nightBrief] ${n} expired constraint(s) auto-retired`);
}

// For active daily constraints not completed today, increment missed_streak.
// Only counts from the day AFTER started_at so a new constraint doesn't
// immediately register as missed.
function updateDailyConstraintStreaks(today) {
  db.prepare(`
    UPDATE constraints
    SET missed_streak = missed_streak + 1
    WHERE status = 'active'
      AND frequency = 'daily'
      AND date(started_at) < ?
      AND (last_completed_date IS NULL OR last_completed_date < ?)
  `).run(today, today);
}

function queryStrugglingConstraints() {
  return db.prepare(`
    SELECT * FROM constraints
    WHERE status = 'active'
      AND missed_streak >= 3
    ORDER BY missed_streak DESC
  `).all();
}

function queryLastWeekNetworkingMiss() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  const day  = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  const weekStr = d.toISOString().slice(0, 10);

  return db.prepare(`
    SELECT * FROM networking_goals
    WHERE week_of = ?
      AND actual_outreach < target_outreach
    LIMIT 1
  `).get(weekStr);
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

You are producing a nightly task brief. Additional rules:
- Be terse. No filler, no motivational language, no "Great work!"
- Sort tasks across three buckets:
    HIGH PRIORITY — critical/high priority tasks, OR any task with a deadline within 3 days
    WATCH LIST    — medium priority or deadline within 7 days
    LATER         — everything else
- If a bucket is empty, omit it entirely.
- Each bullet: • [task title] — [project] — due [date or "no deadline"]
- ONE QUESTION must be specific to what actually needs a decision or reply tonight.
- Output plain text only. No markdown, no asterisks, no backticks.
- Use exactly these section headers: HIGH PRIORITY / WATCH LIST / LATER / ONE QUESTION:`;

function buildUserPrompt(grouped) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  let taskBlock = '';
  for (const [project, tasks] of Object.entries(grouped)) {
    taskBlock += `\nPROJECT: ${project}\n`;
    for (const t of tasks) {
      const due = t.deadline || 'no deadline';
      const est = t.estimated_minutes ? ` ~${t.estimated_minutes}m` : '';
      taskBlock += `  [${t.priority.toUpperCase()}] ${t.title} — due ${due}${est}\n`;
      if (t.description) taskBlock += `    ${t.description}\n`;
    }
  }

  return (
    `Today is ${today}.\n` +
    `Active tasks (${Object.values(grouped).flat().length} total):` +
    taskBlock +
    `\nGenerate tonight's Night Brief in this format:\n\n` +
    `[${today.toUpperCase()}] NIGHT BRIEF\n\n` +
    `HIGH PRIORITY\n• ...\n\nWATCH LIST\n• ...\n\nLATER\n• ...\n\n` +
    `ONE QUESTION: [specific question]`
  );
}

// ── Plain-text → HTML conversion ──────────────────────────────────────────────

function briefToHtml(text) {
  const lines = text.split('\n');
  let html = '';
  let inList = false;

  const closeList = () => {
    if (inList) { html += '</div>'; inList = false; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line) {
      closeList();
      html += '<div style="height:10px"></div>';
      continue;
    }

    if (/NIGHT BRIEF/.test(line)) {
      closeList();
      html += `<h1>${line}</h1>`;
      continue;
    }

    if (/^(HIGH PRIORITY|WATCH LIST|LATER)$/.test(line.trim())) {
      closeList();
      const color = {
        'HIGH PRIORITY': '#ff6b6b',
        'WATCH LIST':    '#e3b341',
        'LATER':         '#58a6ff',
      }[line.trim()] || '#7ee787';
      html += `<h2 style="color:${color};margin-top:20px;margin-bottom:6px;">${line.trim()}</h2>`;
      html += '<div style="padding-left:4px">';
      inList = true;
      continue;
    }

    if (line.trimStart().startsWith('•')) {
      const content = line.trimStart().slice(1).trim();
      const parts  = content.split('—');
      const title  = `<strong>${parts[0].trim()}</strong>`;
      const rest   = parts.slice(1).map(s => s.trim()).join(' — ');
      html += `<p style="margin:5px 0 5px 8px;line-height:1.5;">• ${title}${rest ? ' — ' + rest : ''}</p>`;
      continue;
    }

    if (/^ONE QUESTION:/i.test(line.trim())) {
      closeList();
      const q = line.trim().replace(/^ONE QUESTION:\s*/i, '');
      html += `<hr style="border-color:#2a2a2a;margin:20px 0">`;
      html += `<p style="color:#7ee787"><strong>ONE QUESTION:</strong> ${q}</p>`;
      continue;
    }

    closeList();
    html += `<p>${line}</p>`;
  }

  closeList();
  return html;
}

// ── Daily log helpers ─────────────────────────────────────────────────────────

function ensureLogEntry(date) {
  db.prepare(`
    INSERT INTO daily_logs (date) VALUES (?)
    ON CONFLICT(date) DO NOTHING
  `).run(date);
}

function markBriefSent(date) {
  db.prepare(`
    UPDATE daily_logs SET night_brief_sent = 1 WHERE date = ?
  `).run(date);
}

// ── Main export ───────────────────────────────────────────────────────────────

async function nightBrief() {
  const today = new Date().toISOString().slice(0, 10);
  ensureLogEntry(today);

  // ── Constraint maintenance (runs nightly before the brief) ──────────────────
  retireExpiredConstraints(today);
  updateDailyConstraintStreaks(today);
  const struggling     = queryStrugglingConstraints();
  const networkingMiss = queryLastWeekNetworkingMiss();

  const tasks = queryActiveTasks();
  if (tasks.length === 0) {
    console.log('[nightBrief] No active tasks — nothing to send.');
    return null;
  }

  const grouped = groupByProject(tasks);

  const aiResponse = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'user', content: buildUserPrompt(grouped) },
    ],
  });

  const briefText = aiResponse.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // ── Assemble HTML ────────────────────────────────────────────────────────────

  let htmlBody = '';

  // Book completion banner (if a book was finished in the last 7 days)
  const finishedBook = queryRecentlyFinishedBook();
  if (finishedBook) {
    const nextBook = getNextBook(finishedBook);
    const nextPart = nextBook
      ? `Next up: <strong>${nextBook.title}</strong>${nextBook.author ? ' by ' + nextBook.author : ''}. Starting tomorrow?`
      : 'No next book queued — time to pick one.';
    htmlBody += `
      <div style="background:#1a2e1e;border:1px solid #2d5a3d;border-radius:4px;
                  padding:12px 16px;margin-bottom:20px;line-height:1.6;">
        <strong style="color:#7ee787">You finished "${finishedBook.title}".</strong>
        <span style="color:#c0c0c0"> ${nextPart}</span>
      </div>`;
  }

  // Split brief at ONE QUESTION to inject daily flags between task buckets and the closing question
  const flags        = gatherDailyFlags(today);
  const questionMatch = briefText.match(/^ONE QUESTION:.*$/im);
  let briefMain    = briefText;
  let questionHtml = '';
  if (questionMatch) {
    const qIdx = briefText.indexOf(questionMatch[0]);
    briefMain    = briefText.slice(0, qIdx).trimEnd();
    const q      = questionMatch[0].replace(/^ONE QUESTION:\s*/i, '').trim();
    questionHtml = (
      `<hr style="border-color:#2a2a2a;margin:20px 0">` +
      `<p style="color:#7ee787"><strong>ONE QUESTION:</strong> ${q}</p>`
    );
  }

  htmlBody += briefToHtml(briefMain);
  htmlBody += buildDailyFlagsHtml(flags);
  htmlBody += questionHtml;

  // Struggling constraint warnings
  if (struggling.length > 0) {
    htmlBody += `<hr style="border-color:#2a2a2a;margin:20px 0">`;
    for (const c of struggling) {
      htmlBody += `<p style="color:#e3b341">Heads up: <strong>${c.title}</strong> has been missed ${c.missed_streak} day${c.missed_streak !== 1 ? 's' : ''}. Still tracking it? Reply "drop ${c.title}" to retire.</p>`;
    }
  }

  // 52 Builds status line
  const buildWeekNum = getCurrentBuildWeek();

  const activeBuild = db.prepare(`
    SELECT * FROM builds WHERE week_number = ? AND status = 'building' LIMIT 1
  `).get(buildWeekNum);

  if (activeBuild) {
    htmlBody += `<hr style="border-color:#2a2a2a;margin:20px 0">`;
    htmlBody += `<p style="color:#58a6ff"><strong>Build week ${buildWeekNum}:</strong> ${activeBuild.title} — still in progress</p>`;
  }

  // Has legs? prompt for recently shipped builds
  const shippedBuild = db.prepare(`
    SELECT * FROM builds
    WHERE status = 'shipped' AND has_legs = 0
      AND (built_at IS NULL OR date(built_at) >= date('now', '-7 days'))
    ORDER BY built_at DESC LIMIT 1
  `).get();

  if (shippedBuild) {
    htmlBody += `<hr style="border-color:#2a2a2a;margin:20px 0">`;
    htmlBody += `<p style="color:#7ee787"><strong>You shipped week ${shippedBuild.week_number}: ${shippedBuild.title}.</strong> Does it have legs?</p>`;
    htmlBody += `<p style="color:#999999;font-size:12px;">Reply "yes — [project]" to elevate or "no" to archive.</p>`;
  }

  // Networking miss nudge
  if (networkingMiss) {
    htmlBody += `<hr style="border-color:#2a2a2a;margin:20px 0">`;
    htmlBody += `<p style="color:#e3b341">Networking: you missed last week's outreach. Who's one person — warm or cold — you could message today?</p>`;
  }

  // Currently reading nudge
  const currentlyReading = db.prepare(
    `SELECT * FROM books WHERE status = 'reading' ORDER BY order_rank ASC LIMIT 1`
  ).get();
  if (currentlyReading) {
    htmlBody += `<p style="color:#7ee787;margin:12px 0;"><strong>Currently reading:</strong> <span style="color:#c0c0c0">${currentlyReading.title}</span> — 10 pages today?</p>`;
  }

  // Ideas capture footer (last line)
  htmlBody += `
    <hr style="border-color:#2a2a2a;margin:24px 0">
    <p style="color:#7ee787"><strong>&#128161; Any new ideas to capture?</strong> <span style="color:#999999;font-size:12px;">(for any project — reply and I'll log it)</span></p>`;

  const displayDate = new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const subject  = `Night Brief — ${displayDate}`;
  const replyTag = `night-brief-${today}`;

  await sendEmail(subject, htmlBody, replyTag);
  markBriefSent(today);

  console.log(`[nightBrief] Sent  : "${subject}" | tag: ${replyTag}`);
  console.log(`[nightBrief] Tokens: in=${aiResponse.usage.input_tokens} out=${aiResponse.usage.output_tokens} cache_read=${aiResponse.usage.cache_read_input_tokens ?? 0}`);
  if (struggling.length > 0) {
    console.log(`[nightBrief] Struggling constraints: ${struggling.map(c => c.title).join(', ')}`);
  }

  return { briefText, replyTag, date: today, strugglingConstraints: struggling.length };
}

module.exports = { nightBrief };
