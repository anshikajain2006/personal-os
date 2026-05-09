'use strict';

require('dotenv').config();
const express   = require('express');
const path      = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const db        = require('./db');
const { parseReplyTag }  = require('./email');
const { handleReply: handleWeeklyReply } = require('./weeklyReview');
const { parseAuditConstraintReplies }    = require('./monthlyAudit');
const { createBuildFromReply, handleLegsReply } = require('./buildWeek');
const { getCurrentBuildWeek } = require('./db');

const aiClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoNow() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function nextWeekdayAt(weekday, hour) {
  const d = new Date();
  d.setSeconds(0, 0);
  const daysAhead = (weekday - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function nextLastFridayOfMonth() {
  let candidate = new Date(nextWeekdayAt(5, 20));
  const now = new Date();
  if (now.getDay() === 5 && now.getHours() < 20) candidate = new Date(now);

  for (let i = 0; i < 6; i++) {
    const next = new Date(candidate);
    next.setDate(candidate.getDate() + 7);
    if (next.getMonth() !== candidate.getMonth()) {
      candidate.setHours(20, 0, 0, 0);
      return candidate.toISOString();
    }
    candidate = next;
  }
  return null;
}

// ── Ideas extraction ──────────────────────────────────────────────────────────

function inferProjectId(text) {
  const projects = db.prepare(`SELECT id, name FROM projects`).all();
  const lower    = text.toLowerCase();
  for (const p of projects) {
    const words = p.name.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    if (words.some(w => lower.includes(w))) return p.id;
  }
  return null;
}

function extractAndStoreIdeas(replyText, date) {
  if (!replyText) return;

  const cleaned = replyText
    .split('\n')
    .filter(l => !/\[reply-tag:/i.test(l) && !/<!--\s*reply-tag:/i.test(l))
    .join('\n')
    .trim();

  if (!cleaned) return;

  const candidates = cleaned
    .split(/\n+/)
    .map(l => l.replace(/^[-•*\d.]\s*/, '').trim())
    .filter(l => l.length > 5);

  if (!candidates.length) return;

  const insert = db.prepare(
    `INSERT INTO ideas (project_id, idea_text, status) VALUES (?, ?, 'raw')`
  );

  for (const idea of candidates) {
    insert.run(inferProjectId(idea), idea);
  }

  console.log(`[ideas] ${candidates.length} idea(s) stored from reply for ${date}`);
}

// ── Constraint retirement (from night brief reply) ────────────────────────────

// Looks for "drop [title]" or "retire [title]" patterns in a reply and
// updates matching active constraints to 'retired'.
function parseConstraintRetirement(body) {
  if (!body) return;
  const lower = body.toLowerCase();
  if (!/drop|retire/.test(lower)) return;

  const constraints = db.prepare(`SELECT id, title FROM constraints WHERE status = 'active'`).all();

  for (const c of constraints) {
    const words = c.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const titleMentioned = words.some(w => lower.includes(w));
    if (!titleMentioned) continue;

    // Check if "drop" or "retire" appears close to the title
    const idx     = lower.indexOf(words[0]);
    const context = lower.slice(Math.max(0, idx - 60), Math.min(lower.length, idx + 80));

    if (/drop|retire/.test(context)) {
      db.prepare(`UPDATE constraints SET status = 'retired' WHERE id = ?`).run(c.id);
      console.log(`[constraints] "${c.title}" retired via night brief reply`);
    }
  }
}

// Looks for "done [title]" pattern and marks matching active constraint complete for today.
function parseConstraintCompletion(body) {
  if (!body) return [];
  const lower = body.toLowerCase();
  if (!/\bdone\b/.test(lower)) return [];

  const constraints = db.prepare(`SELECT id, title FROM constraints WHERE status = 'active'`).all();
  const today       = new Date().toISOString().slice(0, 10);
  const completed   = [];

  for (const c of constraints) {
    const words = c.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (!words.length) continue;

    const titleMentioned = words.some(w => lower.includes(w));
    if (!titleMentioned) continue;

    const idx     = lower.indexOf(words[0]);
    const context = lower.slice(Math.max(0, idx - 60), Math.min(lower.length, idx + 80));

    if (/\bdone\b/.test(context)) {
      db.prepare(`
        UPDATE constraints SET last_completed_date = ?, missed_streak = 0 WHERE id = ?
      `).run(today, c.id);
      completed.push(c.title);
      console.log(`[constraints] "${c.title}" marked complete for ${today} via night brief reply`);
    }
  }

  return completed;
}

// ── GET / — web dashboard ─────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ── GET /api/dashboard ────────────────────────────────────────────────────────

app.get('/api/dashboard', (req, res) => {
  const latestAudit = db.prepare(
    `SELECT scores_json FROM monthly_audits ORDER BY month DESC LIMIT 1`
  ).get();
  const auditScores = {};
  if (latestAudit?.scores_json) {
    try { Object.assign(auditScores, JSON.parse(latestAudit.scores_json)); } catch {}
  }

  const projects = db.prepare(`
    SELECT
      p.id, p.name, p.status, p.priority_rank, p.north_star, p.current_phase, p.milestones,
      COUNT(t.id)                                                        AS total_tasks,
      SUM(CASE WHEN t.status IN ('done','archived') THEN 1 ELSE 0 END)  AS done_tasks,
      SUM(CASE WHEN t.status = 'in_progress'        THEN 1 ELSE 0 END)  AS in_progress,
      SUM(CASE WHEN t.status = 'blocked'            THEN 1 ELSE 0 END)  AS blocked,
      SUM(CASE WHEN t.deadline IS NOT NULL
               AND t.deadline < date('now')
               AND t.status NOT IN ('done','cancelled','archived')
               THEN 1 ELSE 0 END)                                       AS overdue
    FROM projects p
    LEFT JOIN tasks t ON t.project_id = p.id
    GROUP BY p.id
    ORDER BY p.priority_rank ASC
  `).all().map(p => ({
    ...p,
    completion_pct: p.total_tasks > 0
      ? Math.round((p.done_tasks / p.total_tasks) * 100)
      : 0,
    score: auditScores[p.name] ?? null,
  }));

  const todayStr = new Date().toISOString().slice(0, 10);
  const rawLog   = db.prepare(`SELECT * FROM daily_logs WHERE date = ?`).get(todayStr);
  const today_log = {
    date:              todayStr,
    night_brief_sent:  rawLog?.night_brief_sent  ?? 0,
    morning_plan_sent: rawLog?.morning_plan_sent ?? 0,
    replied_night:     rawLog?.user_reply_night  != null ? 1 : 0,
    replied_morning:   rawLog?.user_reply_morning != null ? 1 : 0,
  };

  const nextDaily = (hour) => {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    if (d <= new Date()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  };

  const scheduled = {
    night_brief:   { cron: 'daily at 9:00 PM IST', sent_today: today_log.night_brief_sent === 1, next: nextDaily(21) },
    morning_plan:  { cron: 'daily at 7:00 AM IST', sent_today: today_log.morning_plan_sent === 1, next: nextDaily(7) },
    weekly_review: { cron: 'every Friday at 8:00 PM IST',              next: nextWeekdayAt(5, 20) },
    monthly_audit: { cron: 'last Friday of month at 8:00 PM IST',      next: nextLastFridayOfMonth() },
    saturday_morning: { cron: 'every Saturday at 9:00 AM IST (builds + content combined)', next: nextWeekdayAt(6, 9) },
  };

  const currentBook  = db.prepare(`SELECT * FROM books WHERE status = 'reading' ORDER BY order_rank ASC LIMIT 1`).get() || null;
  const recentIdeas  = db.prepare(`
    SELECT i.*, p.name AS project_name FROM ideas i
    LEFT JOIN projects p ON i.project_id = p.id
    ORDER BY i.captured_at DESC LIMIT 10
  `).all();
  const activeConstraints = db.prepare(`SELECT * FROM constraints WHERE status = 'active' ORDER BY started_at ASC`).all();

  return res.json({
    generated_at: new Date().toISOString(),
    projects,
    today_log,
    scheduled,
    current_book:        currentBook,
    recent_ideas:        recentIdeas,
    active_constraints:  activeConstraints,
  });
});

// ── POST /api/tasks ───────────────────────────────────────────────────────────

const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);

app.post('/api/tasks', (req, res) => {
  const { project_id, title, priority = 'medium', deadline } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  if (!VALID_PRIORITIES.has(priority)) {
    return res.status(400).json({
      error: `priority must be one of: ${[...VALID_PRIORITIES].join(', ')}`,
    });
  }

  const result = db.prepare(`
    INSERT INTO tasks (project_id, title, priority, deadline, status)
    VALUES (?, ?, ?, ?, 'todo')
  `).run(project_id || null, title.trim(), priority, deadline || null);

  console.log(`[api] task #${result.lastInsertRowid} added: "${title.trim()}" [${priority}]`);
  return res.json({ ok: true, id: result.lastInsertRowid });
});

// ── GET /api/books ────────────────────────────────────────────────────────────

app.get('/api/books', (req, res) => {
  return res.json(db.prepare(`SELECT * FROM books ORDER BY order_rank ASC`).all());
});

// ── PATCH /api/books/:id ──────────────────────────────────────────────────────

app.patch('/api/books/:id', (req, res) => {
  const id     = Number(req.params.id);
  const { status } = req.body;

  if (!['unread', 'reading', 'done'].includes(status)) {
    return res.status(400).json({ error: "status must be 'unread', 'reading', or 'done'" });
  }

  const book = db.prepare(`SELECT * FROM books WHERE id = ?`).get(id);
  if (!book) return res.status(404).json({ error: 'book not found' });

  const today = new Date().toISOString().slice(0, 10);

  if (status === 'done') {
    db.prepare(`UPDATE books SET status = 'done', finished_at = ? WHERE id = ?`).run(today, id);
  } else if (status === 'reading') {
    db.prepare(`UPDATE books SET status = 'reading', started_at = COALESCE(started_at, ?) WHERE id = ?`).run(today, id);
  } else {
    db.prepare(`UPDATE books SET status = 'unread' WHERE id = ?`).run(id);
  }

  console.log(`[api] book #${id} "${book.title}" → ${status}`);
  return res.json({ ok: true, book: db.prepare(`SELECT * FROM books WHERE id = ?`).get(id) });
});

// ── GET /api/ideas ────────────────────────────────────────────────────────────

app.get('/api/ideas', (req, res) => {
  const { status } = req.query;
  const ideas = status
    ? db.prepare(`
        SELECT i.*, p.name AS project_name FROM ideas i
        LEFT JOIN projects p ON i.project_id = p.id
        WHERE i.status = ? ORDER BY i.captured_at DESC
      `).all(status)
    : db.prepare(`
        SELECT i.*, p.name AS project_name FROM ideas i
        LEFT JOIN projects p ON i.project_id = p.id
        ORDER BY i.captured_at DESC LIMIT 50
      `).all();
  return res.json(ideas);
});

// ── GET /api/constraints ──────────────────────────────────────────────────────

app.get('/api/constraints', (req, res) => {
  const { status } = req.query;
  const rows = status
    ? db.prepare(`SELECT * FROM constraints WHERE status = ? ORDER BY started_at ASC`).all(status)
    : db.prepare(`SELECT * FROM constraints ORDER BY started_at ASC`).all();
  return res.json(rows);
});

// ── POST /api/constraints ─────────────────────────────────────────────────────

app.post('/api/constraints', (req, res) => {
  const { title, description, frequency = 'daily', expires_at, project_id } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }

  const posProject = db.prepare(
    `SELECT id FROM projects WHERE name = 'Personal Operating System' LIMIT 1`
  ).get();

  const result = db.prepare(`
    INSERT INTO constraints (title, description, frequency, expires_at, status, project_id)
    VALUES (?, ?, ?, ?, 'active', ?)
  `).run(
    title.trim(),
    description || null,
    frequency,
    expires_at || null,
    project_id || posProject?.id || null,
  );

  console.log(`[api] constraint #${result.lastInsertRowid} added: "${title.trim()}" [${frequency}]`);
  return res.json({ ok: true, id: result.lastInsertRowid });
});

// ── PATCH /api/constraints/:id ────────────────────────────────────────────────

app.patch('/api/constraints/:id', (req, res) => {
  const id = Number(req.params.id);
  const c  = db.prepare(`SELECT * FROM constraints WHERE id = ?`).get(id);
  if (!c) return res.status(404).json({ error: 'constraint not found' });

  const { status, frequency, missed_streak } = req.body;
  const valid_statuses = new Set(['active', 'paused', 'retired']);

  if (status && !valid_statuses.has(status)) {
    return res.status(400).json({ error: "status must be 'active', 'paused', or 'retired'" });
  }

  const updates = [];
  const params  = [];

  if (status)         { updates.push('status = ?');        params.push(status); }
  if (frequency)      { updates.push('frequency = ?');     params.push(frequency); }
  if (missed_streak !== undefined) { updates.push('missed_streak = ?'); params.push(Number(missed_streak)); }

  if (!updates.length) return res.status(400).json({ error: 'nothing to update' });

  params.push(id);
  db.prepare(`UPDATE constraints SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  console.log(`[api] constraint #${id} updated`);
  return res.json({ ok: true, constraint: db.prepare(`SELECT * FROM constraints WHERE id = ?`).get(id) });
});

// ── POST /api/constraints/:id/complete ───────────────────────────────────────
// Marks a constraint as completed for today, resetting its missed_streak.

app.post('/api/constraints/:id/complete', (req, res) => {
  const id = Number(req.params.id);
  const c  = db.prepare(`SELECT * FROM constraints WHERE id = ?`).get(id);
  if (!c) return res.status(404).json({ error: 'constraint not found' });

  const today = new Date().toISOString().slice(0, 10);

  db.prepare(`
    UPDATE constraints
    SET last_completed_date = ?, missed_streak = 0
    WHERE id = ?
  `).run(today, id);

  console.log(`[api] constraint #${id} "${c.title}" completed for ${today}`);
  return res.json({ ok: true, constraint: db.prepare(`SELECT * FROM constraints WHERE id = ?`).get(id) });
});

// ── POST /api/contacts ────────────────────────────────────────────────────────

const VALID_MET_VIA      = new Set(['event', 'online', 'warm', 'cold-outreach']);
const VALID_RELEVANCE    = new Set(['Matrix', 'Autumn', 'Lumiere', 'Brand', 'General']);

app.post('/api/contacts', (req, res) => {
  const {
    name, context, met_at, met_via,
    follow_up_due, relationship_strength = 1,
    project_relevance, notes,
  } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (met_via && !VALID_MET_VIA.has(met_via)) {
    return res.status(400).json({ error: `met_via must be one of: ${[...VALID_MET_VIA].join(', ')}` });
  }
  const strength = Number(relationship_strength);
  if (!Number.isInteger(strength) || strength < 1 || strength > 5) {
    return res.status(400).json({ error: 'relationship_strength must be an integer 1–5' });
  }

  const result = db.prepare(`
    INSERT INTO network_contacts
      (name, context, met_at, met_via, follow_up_due,
       relationship_strength, project_relevance, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(),
    context      || null,
    met_at       || null,
    met_via      || null,
    follow_up_due || null,
    strength,
    project_relevance || null,
    notes        || null,
  );

  console.log(`[api] contact #${result.lastInsertRowid} added: "${name.trim()}"`);
  return res.json({ ok: true, id: result.lastInsertRowid });
});

// ── PATCH /api/events/:id/attend ──────────────────────────────────────────────

app.patch('/api/events/:id/attend', (req, res) => {
  const id    = Number(req.params.id);
  const event = db.prepare(`SELECT * FROM events_log WHERE id = ?`).get(id);
  if (!event) return res.status(404).json({ error: 'event not found' });

  const { contacts_made = 0, notes } = req.body;

  const updates = ['attended = 1', 'contacts_made = ?'];
  const params  = [Number(contacts_made)];

  if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }

  params.push(id);
  db.prepare(`UPDATE events_log SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  console.log(`[api] event #${id} "${event.event_name}" marked attended, contacts_made=${contacts_made}`);
  return res.json({ ok: true, event: db.prepare(`SELECT * FROM events_log WHERE id = ?`).get(id) });
});

// ── GET /api/content-ideas ────────────────────────────────────────────────────

app.get('/api/content-ideas', (req, res) => {
  const { week_of } = req.query;
  const rows = week_of
    ? db.prepare(`SELECT * FROM content_ideas WHERE week_of = ? ORDER BY id ASC`).all(week_of)
    : db.prepare(`SELECT * FROM content_ideas ORDER BY week_of DESC, id ASC LIMIT 20`).all();
  return res.json(rows);
});

// ── GET /api/builds ───────────────────────────────────────────────────────────

app.get('/api/builds', (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, p.name AS project_name
    FROM builds b
    LEFT JOIN projects p ON b.project_id = p.id
    ORDER BY b.week_number DESC
  `).all();
  return res.json(rows);
});

// ── POST /api/builds ──────────────────────────────────────────────────────────

app.post('/api/builds', (req, res) => {
  const { week_number, title, description, idea_source = 'self', project_id, status = 'ideating' } = req.body;

  if (!title?.trim()) return res.status(400).json({ error: 'title is required' });

  const wk = week_number ?? getCurrentBuildWeek();
  const validStatuses = new Set(['ideating', 'building', 'shipped', 'archived', 'elevated']);
  if (!validStatuses.has(status)) {
    return res.status(400).json({ error: `status must be one of: ${[...validStatuses].join(', ')}` });
  }

  const result = db.prepare(`
    INSERT INTO builds (week_number, title, description, idea_source, project_id, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(wk, title.trim(), description || null, idea_source, project_id || null, status);

  console.log(`[api] build #${result.lastInsertRowid} added: "${title.trim()}" week ${wk}`);
  return res.json({ ok: true, id: result.lastInsertRowid });
});

// ── PATCH /api/builds/:id ─────────────────────────────────────────────────────

app.patch('/api/builds/:id', (req, res) => {
  const id = Number(req.params.id);
  const build = db.prepare(`SELECT * FROM builds WHERE id = ?`).get(id);
  if (!build) return res.status(404).json({ error: 'build not found' });

  const { status, has_legs, elevated_to, built_at, description } = req.body;
  const validStatuses = new Set(['ideating', 'building', 'shipped', 'archived', 'elevated']);

  if (status && !validStatuses.has(status)) {
    return res.status(400).json({ error: `status must be one of: ${[...validStatuses].join(', ')}` });
  }

  const updates = [];
  const params  = [];

  if (status !== undefined)      { updates.push('status = ?');      params.push(status); }
  if (has_legs !== undefined)    { updates.push('has_legs = ?');    params.push(Number(has_legs)); }
  if (elevated_to !== undefined) { updates.push('elevated_to = ?'); params.push(elevated_to); }
  if (built_at !== undefined)    { updates.push('built_at = ?');    params.push(built_at); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }

  if (!updates.length) return res.status(400).json({ error: 'nothing to update' });

  params.push(id);
  db.prepare(`UPDATE builds SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  console.log(`[api] build #${id} updated`);
  return res.json({ ok: true, build: db.prepare(`SELECT * FROM builds WHERE id = ?`).get(id) });
});

// ── Book completion parsing ───────────────────────────────────────────────────

function parseBookCompletion(replyText) {
  if (!replyText) return null;
  if (!/finished|done with|completed/i.test(replyText)) return null;

  const readingBooks = db.prepare(`SELECT * FROM books WHERE status = 'reading' ORDER BY order_rank ASC`).all();
  if (!readingBooks.length) return null;

  const lower = replyText.toLowerCase();

  for (const book of readingBooks) {
    const words = book.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (!words.some(w => lower.includes(w))) continue;

    const idx     = lower.indexOf(words[0]);
    const context = lower.slice(Math.max(0, idx - 50), Math.min(lower.length, idx + 60));
    if (!/finished|done with|completed/i.test(context)) continue;

    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`UPDATE books SET status = 'done', finished_at = ? WHERE id = ?`).run(today, book.id);

    const nextBook = db.prepare(`
      SELECT * FROM books
      WHERE status IN ('unread', 'reading') AND order_rank > ?
      ORDER BY order_rank ASC LIMIT 1
    `).get(book.order_rank);

    if (nextBook) {
      db.prepare(`UPDATE books SET status = 'reading', started_at = COALESCE(started_at, ?) WHERE id = ?`).run(today, nextBook.id);
      console.log(`[books] "${book.title}" finished → "${nextBook.title}" started`);
    } else {
      console.log(`[books] "${book.title}" finished — no next book queued`);
    }

    return { finished: book, next: nextBook || null };
  }

  return null;
}

// ── AI idea extraction (night brief replies) ──────────────────────────────────

async function aiExtractIdeas(replyText, date) {
  const cleaned = replyText
    .split('\n')
    .filter(l => !/\[reply-tag:/i.test(l) && !/<!--\s*reply-tag:/i.test(l))
    .join('\n')
    .trim();

  if (!cleaned || cleaned.length < 30) return;
  if (/^(yes|no|ok|okay|done|thanks|noted|sure|got it|shipped|finished)[\s.,!?]*$/i.test(cleaned)) return;

  let response;
  try {
    response = await aiClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `The user replied to their night brief. Extract any new ideas mentioned.
For each idea, identify: the idea text, and which project it most likely belongs to.
Projects: Matrix Media Solutions, Autumn, Personal Brand, Personal OS, 52 Builds, New.
Return ONLY valid JSON array: [{"idea_text": "...", "project_name": "..."}]
If no ideas found, return: []

Reply: ${JSON.stringify(cleaned.slice(0, 800))}`,
      }],
    });
  } catch (err) {
    console.error('[ideas] aiExtractIdeas error:', err.message);
    return;
  }

  const raw = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();

  let ideas;
  try {
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) return;
    ideas = JSON.parse(match[0]);
  } catch {
    return;
  }

  if (!Array.isArray(ideas) || !ideas.length) return;

  const projects = db.prepare('SELECT id, name FROM projects').all();
  let count = 0;
  for (const item of ideas) {
    if (!item.idea_text) continue;
    const project = projects.find(p =>
      item.project_name &&
      p.name.toLowerCase().includes((item.project_name || '').toLowerCase().split(' ')[0])
    );
    db.prepare(`INSERT INTO ideas (project_id, idea_text, status) VALUES (?, ?, 'raw')`).run(project?.id || null, item.idea_text);
    count++;
  }

  if (count > 0) console.log(`[ideas] ${count} idea(s) AI-extracted from night brief reply for ${date}`);
}

// ── POST /webhook/reply ───────────────────────────────────────────────────────

app.post('/webhook/reply', async (req, res) => {
  const { body, received_at } = req.body;

  if (!body) {
    return res.status(400).json({ error: 'body is required' });
  }

  const tag = parseReplyTag(body);
  if (!tag) {
    return res.status(422).json({ error: 'no reply tag found in body' });
  }

  // ── night-brief-YYYY-MM-DD ────────────────────────────────────────────────
  if (tag.startsWith('night-brief-')) {
    const date = tag.replace('night-brief-', '');
    db.prepare(`
      INSERT INTO daily_logs (date, user_reply_night)
      VALUES (?, ?)
      ON CONFLICT(date) DO UPDATE SET user_reply_night = excluded.user_reply_night
    `).run(date, body);

    parseConstraintRetirement(body);
    const completedConstraints = parseConstraintCompletion(body);

    // Book completion detection
    const bookResult = parseBookCompletion(body);
    if (bookResult) {
      console.log(`[webhook] book "${bookResult.finished.title}" marked done${bookResult.next ? ` → starting "${bookResult.next.title}"` : ''}`);
    }

    // "Has legs" reply for a shipped build
    const legsResult = handleLegsReply(body);
    if (legsResult) {
      console.log(`[webhook] build "${legsResult.build.title}" → ${legsResult.action}`);
    }

    // AI idea extraction (async, non-blocking to response)
    aiExtractIdeas(body, date).catch(err => console.error('[ideas] extraction failed:', err.message));

    if (completedConstraints.length) console.log(`[webhook] constraints completed: ${completedConstraints.join(', ')}`);
    console.log(`[webhook] night-brief reply stored for ${date}`);
    return res.json({ ok: true, tag, type: 'night-brief', date, legsResult: legsResult || undefined, bookResult: bookResult || undefined, completedConstraints });
  }

  // ── morning-plan-YYYY-MM-DD ───────────────────────────────────────────────
  if (tag.startsWith('morning-plan-')) {
    const date = tag.replace('morning-plan-', '');
    db.prepare(`
      INSERT INTO daily_logs (date, user_reply_morning)
      VALUES (?, ?)
      ON CONFLICT(date) DO UPDATE SET user_reply_morning = excluded.user_reply_morning
    `).run(date, body);

    console.log(`[webhook] morning-plan reply stored for ${date}`);
    return res.json({ ok: true, tag, type: 'morning-plan', date });
  }

  // ── weekly-review-YYYY-Www ────────────────────────────────────────────────
  if (tag.startsWith('weekly-review-')) {
    let result;
    try {
      result = await handleWeeklyReply(body);
    } catch (err) {
      console.error('[webhook] weekly-review handler error:', err.message);
      return res.status(500).json({ error: 'handler error: ' + err.message });
    }
    if (!result) {
      return res.status(404).json({ error: `no weekly review found for tag: ${tag}` });
    }
    console.log(`[webhook] weekly-review reply processed for ${result.weekStart}, ${result.bumped.length} task(s) bumped`);
    return res.json({ ok: true, tag, type: 'weekly-review', ...result });
  }

  // ── saturday-morning-YYYY-MM-DD ──────────────────────────────────────────
  if (tag.startsWith('saturday-morning-')) {
    const date    = tag.replace('saturday-morning-', '');
    const weekNum = getCurrentBuildWeek();
    let newBuild  = null;
    try {
      newBuild = await createBuildFromReply(body, weekNum);
    } catch (err) {
      console.error('[webhook] saturday-morning build parse error:', err.message);
    }
    console.log(`[webhook] saturday-morning reply for ${date}${newBuild ? ` — build: "${newBuild.title}"` : ''}`);
    return res.json({ ok: true, tag, type: 'saturday-morning', date, newBuild: newBuild || null });
  }

  // ── build-ideas-[weekNum] ─────────────────────────────────────────────────
  if (tag.startsWith('build-ideas-')) {
    const weekNum = parseInt(tag.replace('build-ideas-', ''), 10);
    let newBuild = null;
    try {
      newBuild = await createBuildFromReply(body, weekNum);
    } catch (err) {
      console.error('[webhook] build-ideas reply error:', err.message);
    }
    console.log(`[webhook] build-ideas reply for week ${weekNum}${newBuild ? ` — build logged: "${newBuild.title}"` : ' — no build detected'}`);
    return res.json({ ok: true, tag, type: 'build-ideas', weekNum, newBuild: newBuild || null });
  }

  // ── content-ideas-YYYY-MM-DD ──────────────────────────────────────────────
  if (tag.startsWith('content-ideas-')) {
    const weekStart = tag.replace('content-ideas-', '');
    extractAndStoreIdeas(body, weekStart);
    console.log(`[webhook] content-ideas reply stored for week ${weekStart}`);
    return res.json({ ok: true, tag, type: 'content-ideas', weekStart });
  }

  // ── monthly-audit-YYYY-MM ─────────────────────────────────────────────────
  if (tag.startsWith('monthly-audit-')) {
    const month = tag.replace('monthly-audit-', '');
    const audit = db.prepare('SELECT id FROM monthly_audits WHERE month = ?').get(month);
    if (!audit) {
      return res.status(404).json({ error: `no monthly audit found for month: ${month}` });
    }

    db.prepare(`
      UPDATE monthly_audits
      SET reset_notes = ?, replied_at = datetime('now')
      WHERE month = ?
    `).run(body, month);

    // Parse constraint updates from the reply
    const auditableConstraints = db.prepare(`
      SELECT * FROM constraints
      WHERE status = 'active'
        AND date(started_at) <= date('now', '-28 days')
    `).all();

    let constraintUpdates = [];
    if (auditableConstraints.length > 0) {
      try {
        constraintUpdates = await parseAuditConstraintReplies(body, auditableConstraints);
        for (const u of constraintUpdates) {
          // Fuzzy match on title
          const match = auditableConstraints.find(c =>
            c.title.toLowerCase().includes(u.title.toLowerCase().split(' ')[0]) ||
            u.title.toLowerCase().includes(c.title.toLowerCase().split(' ')[0])
          );
          if (!match) continue;

          if (u.action === 'retire') {
            db.prepare(`UPDATE constraints SET status = 'retired' WHERE id = ?`).run(match.id);
            console.log(`[monthlyAudit] "${match.title}" retired via audit reply`);
          } else if (u.action === 'pause') {
            db.prepare(`UPDATE constraints SET status = 'paused' WHERE id = ?`).run(match.id);
            console.log(`[monthlyAudit] "${match.title}" paused via audit reply`);
          } else if (u.action === 'modify' && u.new_frequency) {
            db.prepare(`UPDATE constraints SET frequency = ? WHERE id = ?`).run(u.new_frequency, match.id);
            console.log(`[monthlyAudit] "${match.title}" frequency → ${u.new_frequency}`);
          }
        }
      } catch (err) {
        console.error('[webhook] monthly-audit constraint parsing error:', err.message);
      }
    }

    console.log(`[webhook] monthly-audit reply stored for ${month}, ${constraintUpdates.length} constraint update(s)`);
    return res.json({ ok: true, tag, type: 'monthly-audit', month, constraintUpdates });
  }

  return res.status(422).json({ error: `unrecognised tag prefix: ${tag}` });
});

// ── GET /dashboard (legacy JSON) ──────────────────────────────────────────────

app.get('/dashboard', (req, res) => {
  const projects = db.prepare(`
    SELECT
      p.id, p.name, p.status, p.priority_rank,
      COUNT(t.id)                                                        AS total_tasks,
      SUM(CASE WHEN t.status IN ('done','archived') THEN 1 ELSE 0 END)  AS done_tasks,
      SUM(CASE WHEN t.status = 'in_progress'        THEN 1 ELSE 0 END)  AS in_progress,
      SUM(CASE WHEN t.status = 'blocked'            THEN 1 ELSE 0 END)  AS blocked,
      SUM(CASE WHEN t.deadline IS NOT NULL
               AND t.deadline < date('now')
               AND t.status NOT IN ('done','cancelled','archived')
               THEN 1 ELSE 0 END)                                       AS overdue
    FROM projects p
    LEFT JOIN tasks t ON t.project_id = p.id
    GROUP BY p.id
    ORDER BY p.priority_rank ASC
  `).all().map(p => ({
    ...p,
    completion_pct: p.total_tasks > 0
      ? Math.round((p.done_tasks / p.total_tasks) * 100)
      : 0,
  }));

  const dailyLogs = db.prepare(`
    SELECT
      date,
      night_brief_sent, morning_plan_sent,
      CASE WHEN user_reply_night   IS NOT NULL THEN 1 ELSE 0 END AS replied_night,
      CASE WHEN user_reply_morning IS NOT NULL THEN 1 ELSE 0 END AS replied_morning
    FROM daily_logs
    ORDER BY date DESC LIMIT 7
  `).all();

  const logByDate = Object.fromEntries(dailyLogs.map(r => [r.date, r]));
  const last7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    return logByDate[key] || { date: key, night_brief_sent: 0, morning_plan_sent: 0, replied_night: 0, replied_morning: 0 };
  });

  const latestWeekly  = db.prepare(`SELECT week_start_date, sent_at, replied_at, content_ideas_replied, content_ideas_sent FROM weekly_reviews ORDER BY week_start_date DESC LIMIT 1`).get() || null;
  const latestMonthly = db.prepare(`SELECT month, scores_json, drift_flags, sent_at, replied_at FROM monthly_audits ORDER BY month DESC LIMIT 1`).get() || null;

  if (latestMonthly?.scores_json) {
    try { latestMonthly.scores_json = JSON.parse(latestMonthly.scores_json); } catch {}
  }

  return res.json({
    generated_at:   new Date().toISOString(),
    projects,
    daily_logs:     last7,
    latest_weekly:  latestWeekly,
    latest_monthly: latestMonthly,
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[server] Running on http://localhost:${PORT}`);
  console.log(`[server] Endpoints:`);
  console.log(`          GET   http://localhost:${PORT}/`);
  console.log(`          GET   http://localhost:${PORT}/api/dashboard`);
  console.log(`          POST  http://localhost:${PORT}/api/tasks`);
  console.log(`          GET   http://localhost:${PORT}/api/books`);
  console.log(`          PATCH http://localhost:${PORT}/api/books/:id`);
  console.log(`          GET   http://localhost:${PORT}/api/ideas`);
  console.log(`          GET   http://localhost:${PORT}/api/constraints`);
  console.log(`          POST  http://localhost:${PORT}/api/constraints`);
  console.log(`          PATCH http://localhost:${PORT}/api/constraints/:id`);
  console.log(`          POST  http://localhost:${PORT}/api/constraints/:id/complete`);
  console.log(`          GET   http://localhost:${PORT}/api/builds`);
  console.log(`          POST  http://localhost:${PORT}/api/builds`);
  console.log(`          PATCH http://localhost:${PORT}/api/builds/:id`);
  console.log(`          POST  http://localhost:${PORT}/api/contacts`);
  console.log(`          PATCH http://localhost:${PORT}/api/events/:id/attend`);
  console.log(`          GET   http://localhost:${PORT}/api/content-ideas`);
  console.log(`          POST  http://localhost:${PORT}/webhook/reply`);
  console.log(`          GET   http://localhost:${PORT}/dashboard  (legacy json)`);
});

module.exports = app;
