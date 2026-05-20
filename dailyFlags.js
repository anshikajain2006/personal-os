'use strict';

const db = require('./db');

// ── Week helper ───────────────────────────────────────────────────────────────

function getMonWeekStart(today) {
  const [y, m, d] = today.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const day  = date.getDay(); // 0=Sun, 1=Mon ... 6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

// ── Daily queries ─────────────────────────────────────────────────────────────

function queryAutumnTopTask() {
  return db.prepare(`
    SELECT t.title, t.priority, t.deadline
    FROM tasks t
    JOIN projects p ON t.project_id = p.id
    WHERE p.name LIKE '%Autumn%'
      AND t.status NOT IN ('done', 'cancelled', 'archived')
    ORDER BY
      CASE t.priority
        WHEN 'critical' THEN 0
        WHEN 'high'     THEN 1
        WHEN 'medium'   THEN 2
        WHEN 'low'      THEN 3
        ELSE 4
      END ASC,
      CASE WHEN t.deadline IS NULL THEN 1 ELSE 0 END ASC,
      t.deadline ASC
    LIMIT 1
  `).get();
}

function queryInstagramPostThisWeek(weekOf) {
  return db.prepare(`
    SELECT id, title, chosen, posted FROM content_ideas
    WHERE week_of = ?
      AND account = 'self'
      AND (chosen = 1 OR posted = 1)
    LIMIT 1
  `).get(weekOf);
}

function queryLinkedInActivityThisWeek(weekOf) {
  return db.prepare(`
    SELECT t.title
    FROM tasks t
    JOIN projects p ON t.project_id = p.id
    WHERE p.name LIKE '%Personal Brand%'
      AND LOWER(t.title) LIKE '%linkedin%'
      AND t.status = 'done'
      AND date(t.updated_at) >= ?
    LIMIT 1
  `).get(weekOf);
}

function queryMatrixOutstandingTasks() {
  return db.prepare(`
    SELECT t.title, t.priority, t.deadline
    FROM tasks t
    JOIN projects p ON t.project_id = p.id
    WHERE p.name LIKE '%Matrix%'
      AND t.status NOT IN ('done', 'cancelled', 'archived')
      AND t.priority IN ('critical', 'high')
    ORDER BY
      CASE t.priority WHEN 'critical' THEN 0 ELSE 1 END ASC,
      CASE WHEN t.deadline IS NULL THEN 1 ELSE 0 END ASC,
      t.deadline ASC
    LIMIT 3
  `).all();
}

function queryLumiereOutstandingTasks() {
  return db.prepare(`
    SELECT t.title, t.priority
    FROM tasks t
    JOIN projects p ON t.project_id = p.id
    WHERE p.name LIKE '%Lumiere%'
      AND t.status NOT IN ('done', 'cancelled', 'archived')
    ORDER BY
      CASE t.priority
        WHEN 'critical' THEN 0
        WHEN 'high'     THEN 1
        WHEN 'medium'   THEN 2
        ELSE 3
      END ASC
    LIMIT 3
  `).all();
}

// ── Monday-only queries ───────────────────────────────────────────────────────

function queryInstagramLastWeekPost(lastWeekOf) {
  return db.prepare(`
    SELECT title FROM content_ideas
    WHERE week_of = ?
      AND account = 'self'
      AND posted = 1
    LIMIT 1
  `).get(lastWeekOf);
}

function queryContactsAddedThisWeek(weekOf) {
  return db.prepare(`
    SELECT COUNT(*) as count FROM network_contacts
    WHERE date(created_at) >= ?
  `).get(weekOf);
}

function queryFounderConversationThisWeek(weekOf) {
  return db.prepare(`
    SELECT name FROM network_contacts
    WHERE date(last_contacted) >= ?
    ORDER BY last_contacted DESC
    LIMIT 1
  `).get(weekOf);
}

function queryAutumnBlocker() {
  return db.prepare(`
    SELECT t.title, t.description
    FROM tasks t
    JOIN projects p ON t.project_id = p.id
    WHERE p.name LIKE '%Autumn%'
      AND t.status = 'blocked'
    ORDER BY
      CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END ASC
    LIMIT 1
  `).get();
}

function queryIdeasCapturedThisWeek(weekOf) {
  return db.prepare(`
    SELECT COUNT(*) as count FROM ideas
    WHERE date(captured_at) >= ?
      AND status != 'dropped'
  `).get(weekOf);
}

// ── Assemble flags object ─────────────────────────────────────────────────────

function gatherDailyFlags(today) {
  const weekOf   = getMonWeekStart(today);
  const [y, m, d] = today.split('-').map(Number);
  const isMonday = new Date(y, m - 1, d).getDay() === 1;

  const flags = {
    weekOf,
    isMonday,
    autumnTopTask:    queryAutumnTopTask(),
    instagramPost:    queryInstagramPostThisWeek(weekOf),
    linkedInActivity: queryLinkedInActivityThisWeek(weekOf),
    matrixTasks:      queryMatrixOutstandingTasks(),
    lumiereTasks:     queryLumiereOutstandingTasks(),
  };

  if (isMonday) {
    const prev = new Date(y, m - 1, d - 7);
    const lastWeekOf = getMonWeekStart([
      prev.getFullYear(),
      String(prev.getMonth() + 1).padStart(2, '0'),
      String(prev.getDate()).padStart(2, '0'),
    ].join('-'));

    flags.instagramLastWeek   = queryInstagramLastWeekPost(lastWeekOf);
    flags.contactsAdded       = queryContactsAddedThisWeek(weekOf);
    flags.founderConversation = queryFounderConversationThisWeek(weekOf);
    flags.autumnBlocker       = queryAutumnBlocker();
    flags.ideasThisWeek       = queryIdeasCapturedThisWeek(weekOf);
  }

  return flags;
}

// ── HTML renderer ─────────────────────────────────────────────────────────────

function buildDailyFlagsHtml(flags) {
  const rows = [];
  const row  = (label, text, color) => rows.push({ label, text, color });

  // Autumn — always surface the #1 task
  if (flags.autumnTopTask) {
    const due = flags.autumnTopTask.deadline ? ` · due ${flags.autumnTopTask.deadline}` : '';
    row('Autumn', `[${flags.autumnTopTask.priority}] ${flags.autumnTopTask.title}${due}`, '#a78bfa');
  } else {
    row('Autumn', 'No open tasks found — is this right?', '#e3b341');
  }

  // Instagram — only flag if nothing chosen or scheduled
  if (!flags.instagramPost) {
    row('Instagram', "This week's post is not written or scheduled.", '#ff6b6b');
  }

  // LinkedIn — only flag if no task completed this week
  if (!flags.linkedInActivity) {
    row('LinkedIn', 'No LinkedIn task marked done this week.', '#ff6b6b');
  }

  // Matrix — only flag if critical/high tasks outstanding
  if (flags.matrixTasks.length > 0) {
    const list = flags.matrixTasks.map(t => t.title).join(' · ');
    row('Matrix', `${flags.matrixTasks.length} BD/restructuring outstanding: ${list}`, '#e3b341');
  }

  // Lumiere — only flag if tasks outstanding
  if (flags.lumiereTasks.length > 0) {
    const list = flags.lumiereTasks.map(t => `[${t.priority}] ${t.title}`).join(' · ');
    row('Lumiere', list, '#58a6ff');
  }

  // Monday additions
  if (flags.isMonday) {
    if (!flags.instagramLastWeek) {
      row('Instagram (last wk)', 'No post went out last week.', '#ff6b6b');
    }
    if (!flags.contactsAdded?.count) {
      row('Jobs pipeline', 'No new contact added this week — add one to the target list.', '#e3b341');
    }
    if (!flags.founderConversation) {
      row('Founder convos', 'No warm founder conversation logged this week.', '#e3b341');
    }
    const blockerText = flags.autumnBlocker
      ? `${flags.autumnBlocker.title}${flags.autumnBlocker.description ? ' — ' + flags.autumnBlocker.description : ''}`
      : 'No blocker logged — confirm Mayank is unblocked.';
    row('Autumn blocker', blockerText, '#a78bfa');
    if (!flags.ideasThisWeek?.count) {
      row('Product ideas', 'No new idea captured this week — add one.', '#888');
    }
  }

  if (rows.length === 0) return '';

  let html = `<hr style="border-color:#2a2a2a;margin:20px 0">`;
  html += `<p style="color:#555;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;margin:0 0 8px 0;">Daily Flags</p>`;
  html += `<div style="display:flex;flex-direction:column;gap:4px;">`;

  for (const r of rows) {
    html += (
      `<div style="display:flex;gap:10px;padding:7px 10px;background:#141414;` +
      `border-left:3px solid ${r.color};border-radius:2px;">` +
      `<span style="color:${r.color};font-weight:600;font-size:12px;min-width:130px;flex-shrink:0;">${r.label}</span>` +
      `<span style="color:#c0c0c0;font-size:13px;line-height:1.4;">${r.text}</span>` +
      `</div>`
    );
  }

  html += `</div>`;
  return html;
}

module.exports = { gatherDailyFlags, buildDailyFlagsHtml };
