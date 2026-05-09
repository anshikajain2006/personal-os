'use strict';

require('dotenv').config({ path: '.env.example' });
const Anthropic = require('@anthropic-ai/sdk');
const db        = require('./db');
const { sendEmail } = require('./email');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── DB queries ────────────────────────────────────────────────────────────────

function fetchLastNightLog(today) {
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yd = yesterday.toISOString().slice(0, 10);

  return (
    db.prepare(`SELECT * FROM daily_logs WHERE date = ? LIMIT 1`).get(yd) ||
    db.prepare(`SELECT * FROM daily_logs WHERE date = ? LIMIT 1`).get(today) ||
    null
  );
}

function queryTodayTasks() {
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

function queryActiveConstraints() {
  return db.prepare(`
    SELECT * FROM constraints
    WHERE status = 'active'
    ORDER BY started_at ASC
  `).all();
}

function queryFollowUpsDue(today) {
  return db.prepare(`
    SELECT * FROM network_contacts
    WHERE follow_up_due = ?
    ORDER BY relationship_strength DESC
  `).all(today);
}

// ── Prompt construction ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a goal-alignment engine building a daily schedule, not a task dispatcher.

The user's goal hierarchy (order = priority):
#1 Matrix Media Solutions — ₹20L/month profit, active CEO in 2 years
#2 Lumiere Internship — exit with full-time offer, June 4 start
#3 Autumn — launch + 1 user/day, ₹20L/month each in 5 years
#4 Personal Brand — top 0.5% rooms, 100K Instagram
#5 Personal OS — gym/reading/skincare non-negotiables
#6 Krea + Actuarial — dormant, context only

Every schedule you produce must:
1. Reserve the highest-cognition blocks (9 PM onwards) for tasks that compound toward #1–#3
2. Flag if any high-priority goal has zero time allocated today
3. Never bury a north-star task under admin
4. If follow-ups are due, slot them in the morning low-cognition blocks — never skip them

Networking strategy — weekly non-negotiable:
- Layer 1 (warm network): update existing contacts on what you are building
- Layer 2 (events): 1 hackathon or startup event per month, Kolkata + Chennai + online India
- Layer 3 (online→offline): post 8 weeks, engage DMs, 1 coffee per week with someone new
- Weekly target: 1 new person reached out to, follow up within 24 hrs
- Current visibility: zero — every networking action is compounding from scratch

Key facts about this user:
- Peak cognition is late at night (9 PM onwards). Schedule deep work, writing, complex decisions, and creative tasks in evening blocks.
- Morning and early afternoon are lower-cognition windows. Schedule admin, email triage, short meetings, and routine tasks there.
- The schedule should feel achievable, not aspirational — do not overload it.
- Be terse. No filler. No "You've got this!" or motivational language.

Output format rules:
- Header line: [DATE] MORNING PLAN
- Section PROTECT AT ALL COSTS: 1–2 bullets, the non-negotiable outcomes for today.
- Section YOUR CONSTRAINTS THIS WEEK: bullet list of active habit constraints, one per line: "• [title] — [frequency]". Omit this section entirely if no constraints are provided in the prompt.
- Section YOUR DAY: time-blocked schedule from ~8:00 AM to ~11:00 PM. Use 30- or 60- or 90-minute blocks. Format each line exactly as: HH:MM AM/PM — [task or block label] (N min)
- Section TOTAL ESTIMATED: one line — "X hrs Y min across N tasks"
- If the user left a reply from last night, incorporate any changes or priorities they mentioned.
- Output plain text only. No markdown, no asterisks, no backticks.`;

function buildUserPrompt(tasks, nightLog, constraints, followUps = []) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const buckets = { critical: [], high: [], medium: [], low: [] };
  for (const t of tasks) {
    (buckets[t.priority] || buckets.low).push(t);
  }

  let taskBlock = '';
  for (const [level, items] of Object.entries(buckets)) {
    if (!items.length) continue;
    taskBlock += `\n[${level.toUpperCase()}]\n`;
    for (const t of items) {
      const due = t.deadline ? `due ${t.deadline}` : 'no deadline';
      const est = t.estimated_minutes ? ` ~${t.estimated_minutes}m` : '';
      const cogNote = (level === 'critical' || level === 'high') ? ' [DEEP WORK]' : '';
      taskBlock += `  • ${t.title} — ${t.project_name} — ${due}${est}${cogNote}\n`;
      if (t.description) taskBlock += `    ${t.description}\n`;
    }
  }

  const totalTasks   = tasks.length;
  const totalMinutes = tasks.reduce((s, t) => s + (t.estimated_minutes || 0), 0);
  const totalHrs     = Math.floor(totalMinutes / 60);
  const totalMins    = totalMinutes % 60;
  const totalStr     = totalMinutes
    ? `${totalHrs}h ${totalMins}m of estimated work`
    : 'no time estimates provided';

  const replySection = nightLog?.user_reply_night
    ? `\nUSER REPLY FROM LAST NIGHT:\n${nightLog.user_reply_night.trim()}\n`
    : '\n(No reply from last night.)\n';

  const constraintsSection = constraints.length
    ? `\nACTIVE CONSTRAINTS:\n${constraints.map(c => `• ${c.title} — ${c.frequency}`).join('\n')}\n`
    : '\n(No active constraints.)\n';

  const followUpsSection = followUps.length
    ? `\nFOLLOW-UPS DUE TODAY:\n${followUps.map(c => `• ${c.name}${c.context ? ' — ' + c.context : ''}`).join('\n')}\n`
    : '';

  return (
    `Today is ${today}.\n` +
    `${totalStr} across ${totalTasks} open tasks.\n` +
    replySection +
    constraintsSection +
    followUpsSection +
    `\nTask inventory:${taskBlock}\n` +
    `Generate the Morning Plan in this exact format:\n\n` +
    `[${today.toUpperCase()}] MORNING PLAN\n\n` +
    `PROTECT AT ALL COSTS\n• ...\n\n` +
    `YOUR CONSTRAINTS THIS WEEK\n• [title] — [frequency]\n\n` +
    `YOUR DAY\n` +
    `8:00 AM — [task] (N min)\n` +
    `...\n` +
    `9:00 PM — [deep work block] (90 min)\n\n` +
    `TOTAL ESTIMATED: X hrs Y min across N tasks`
  );
}

// ── Plain-text → HTML conversion ──────────────────────────────────────────────

const SECTION_COLORS = {
  'PROTECT AT ALL COSTS':       '#ff6b6b',
  'YOUR CONSTRAINTS THIS WEEK': '#a78bfa',
  'YOUR DAY':                   '#7ee787',
  'TOTAL ESTIMATED':            '#58a6ff',
};

function planToHtml(text) {
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

    if (/MORNING PLAN/.test(line)) {
      closeSection();
      html += `<h1>${line}</h1>`;
      continue;
    }

    const sectionKey = Object.keys(SECTION_COLORS).find(k => line.trim() === k);
    if (sectionKey) {
      closeSection();
      const color = SECTION_COLORS[sectionKey];
      html += `<h2 style="color:${color};margin-top:22px;margin-bottom:6px;">${sectionKey}</h2>`;
      html += `<div style="padding-left:4px">`;
      inSection = true;
      continue;
    }

    if (/^TOTAL ESTIMATED:/i.test(line.trim())) {
      closeSection();
      const val = line.trim().replace(/^TOTAL ESTIMATED:\s*/i, '');
      html += `<hr style="border-color:#2a2a2a;margin:18px 0">`;
      html += `<p style="color:#58a6ff"><strong>TOTAL ESTIMATED:</strong> ${val}</p>`;
      continue;
    }

    // Bullet items (PROTECT AT ALL COSTS or YOUR CONSTRAINTS THIS WEEK)
    if (line.trimStart().startsWith('•')) {
      const content = line.trimStart().slice(1).trim();
      const parts   = content.split('—');
      const title   = `<strong>${parts[0].trim()}</strong>`;
      const rest    = parts.slice(1).map(s => s.trim()).join(' — ');
      html += `<p style="margin:5px 0 5px 8px;line-height:1.5;">• ${title}${rest ? ' — ' + rest : ''}</p>`;
      continue;
    }

    // Time-block lines: "9:00 PM — Deep work: Auth rewrite (90 min)"
    const timeMatch = line.trim().match(/^(\d{1,2}:\d{2}\s*[AP]M)\s*[—–-]\s*(.+?)(?:\s*\((\d+\s*min)\))?$/i);
    if (timeMatch) {
      const [, time, label, duration] = timeMatch;
      const isDeep = /deep work|writing|design|architect|refactor|review|research/i.test(label);
      const timeColor  = isDeep ? '#e3b341' : '#d4d4d4';
      const labelColor = isDeep ? '#f0f0f0' : '#a8a8a8';
      const durStr     = duration ? `<span style="color:#5a5a5a"> (${duration})</span>` : '';
      html += (
        `<p style="margin:4px 0;font-size:13px;">` +
        `<span style="color:${timeColor};min-width:80px;display:inline-block;">${time}</span>` +
        ` <span style="color:#3a3a3a">—</span> ` +
        `<span style="color:${labelColor}">${label.trim()}</span>${durStr}` +
        `</p>`
      );
      continue;
    }

    closeSection();
    html += `<p style="color:#5a5a5a;font-size:12px;">${line}</p>`;
  }

  closeSection();
  return html;
}

// ── Daily log helpers ─────────────────────────────────────────────────────────

function ensureLogEntry(date) {
  db.prepare(`
    INSERT INTO daily_logs (date) VALUES (?)
    ON CONFLICT(date) DO NOTHING
  `).run(date);
}

function markPlanSent(date) {
  db.prepare(`
    UPDATE daily_logs SET morning_plan_sent = 1 WHERE date = ?
  `).run(date);
}

// ── Main export ───────────────────────────────────────────────────────────────

async function morningPlan() {
  const today = new Date().toISOString().slice(0, 10);
  ensureLogEntry(today);

  const tasks       = queryTodayTasks();
  const nightLog    = fetchLastNightLog(today);
  const constraints = queryActiveConstraints();
  const followUps   = queryFollowUpsDue(today);

  if (tasks.length === 0) {
    console.log('[morningPlan] No active tasks — nothing to send.');
    return null;
  }

  const aiResponse = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1536,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'user', content: buildUserPrompt(tasks, nightLog, constraints, followUps) },
    ],
  });

  const planText = aiResponse.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  const displayDate = new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const subject  = `Morning Plan — ${displayDate}`;
  const replyTag = `morning-plan-${today}`;
  const htmlBody = planToHtml(planText);

  await sendEmail(subject, htmlBody, replyTag);
  markPlanSent(today);

  console.log(`[morningPlan] Sent  : "${subject}" | tag: ${replyTag}`);
  console.log(`[morningPlan] Constraints in brief: ${constraints.length}`);
  console.log(`[morningPlan] Follow-ups due today: ${followUps.length}`);
  console.log(`[morningPlan] Tokens: in=${aiResponse.usage.input_tokens} out=${aiResponse.usage.output_tokens} cache_read=${aiResponse.usage.cache_read_input_tokens ?? 0}`);

  return { planText, replyTag, date: today };
}

module.exports = { morningPlan };
