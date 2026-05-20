'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

// DB_PATH env var lets Railway (or any host) point the DB at a persistent volume.
// Fallback: same directory as this file (works locally).
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'personal_os.db');

const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

console.log(`[db] Opening database at: ${DB_PATH}`);
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Base schema ───────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active', 'paused', 'completed', 'archived')),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    title             TEXT    NOT NULL,
    description       TEXT,
    priority          TEXT    NOT NULL DEFAULT 'medium'
                              CHECK(priority IN ('low', 'medium', 'high', 'critical')),
    deadline          TEXT,
    estimated_minutes INTEGER,
    status            TEXT    NOT NULL DEFAULT 'todo'
                              CHECK(status IN ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_logs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    date                  TEXT    NOT NULL UNIQUE,
    night_brief_sent      INTEGER NOT NULL DEFAULT 0 CHECK(night_brief_sent IN (0,1)),
    morning_plan_sent     INTEGER NOT NULL DEFAULT 0 CHECK(morning_plan_sent IN (0,1)),
    user_reply_night      TEXT,
    user_reply_morning    TEXT
  );

  CREATE TABLE IF NOT EXISTS weekly_reviews (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start_date  TEXT    NOT NULL UNIQUE,
    what_moved       TEXT,
    what_didnt       TEXT,
    decisions_needed TEXT,
    sent_at          TEXT,
    replied_at       TEXT
  );

  CREATE TABLE IF NOT EXISTS monthly_audits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    month       TEXT    NOT NULL UNIQUE,
    scores_json TEXT,
    drift_flags TEXT,
    reset_notes TEXT,
    sent_at     TEXT,
    replied_at  TEXT
  );
`);

// ── Migration: add 'archived' to tasks.status ─────────────────────────────────
{
  const schema = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`
  ).get();
  if (schema && !schema.sql.includes("'archived'")) {
    db.exec(`
      ALTER TABLE tasks RENAME TO tasks_v1;

      CREATE TABLE tasks (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        title             TEXT    NOT NULL,
        description       TEXT,
        priority          TEXT    NOT NULL DEFAULT 'medium'
                                  CHECK(priority IN ('low', 'medium', 'high', 'critical')),
        deadline          TEXT,
        estimated_minutes INTEGER,
        status            TEXT    NOT NULL DEFAULT 'todo'
                                  CHECK(status IN ('todo', 'in_progress', 'blocked', 'done',
                                                   'cancelled', 'archived')),
        created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO tasks SELECT * FROM tasks_v1;
      DROP TABLE tasks_v1;
    `);
  }
}

// ── Migration: add recurrence column to tasks ─────────────────────────────────
{
  const schema = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`
  ).get();
  if (schema && !schema.sql.includes('recurrence')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN recurrence TEXT`);
  }
}

// ── Migration: add project metadata columns ───────────────────────────────────
{
  const schema = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'`
  ).get();
  if (schema) {
    if (!schema.sql.includes('north_star'))    db.exec(`ALTER TABLE projects ADD COLUMN north_star    TEXT`);
    if (!schema.sql.includes('current_phase')) db.exec(`ALTER TABLE projects ADD COLUMN current_phase TEXT`);
    if (!schema.sql.includes('priority_rank')) db.exec(`ALTER TABLE projects ADD COLUMN priority_rank INTEGER DEFAULT 99`);
    if (!schema.sql.includes('milestones'))    db.exec(`ALTER TABLE projects ADD COLUMN milestones    TEXT`);
  }
}

// ── Migration: add content_ideas columns to weekly_reviews ───────────────────
{
  const schema = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='weekly_reviews'`
  ).get();
  if (schema && !schema.sql.includes('content_ideas_replied')) {
    db.exec(`ALTER TABLE weekly_reviews ADD COLUMN content_ideas_replied INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE weekly_reviews ADD COLUMN content_ideas_sent    INTEGER NOT NULL DEFAULT 0`);
  }
}

// ── New tables ────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    author      TEXT,
    order_rank  INTEGER NOT NULL DEFAULT 99,
    status      TEXT    NOT NULL DEFAULT 'unread'
                        CHECK(status IN ('unread', 'reading', 'done')),
    started_at  TEXT,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS ideas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    idea_text   TEXT    NOT NULL,
    captured_at TEXT    NOT NULL DEFAULT (datetime('now')),
    status      TEXT    NOT NULL DEFAULT 'raw'
                        CHECK(status IN ('raw', 'reviewed', 'actioned', 'dropped'))
  );

  CREATE TABLE IF NOT EXISTS constraints (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    title               TEXT    NOT NULL,
    description         TEXT,
    frequency           TEXT    NOT NULL DEFAULT 'daily',
    started_at          TEXT    NOT NULL DEFAULT (date('now')),
    expires_at          TEXT,
    status              TEXT    NOT NULL DEFAULT 'active'
                                CHECK(status IN ('active', 'paused', 'retired')),
    missed_streak       INTEGER NOT NULL DEFAULT 0,
    last_completed_date TEXT,
    project_id          INTEGER REFERENCES projects(id) ON DELETE SET NULL
  );
`);

// ── Networking tables ─────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS network_contacts (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL,
    context               TEXT,
    met_at                TEXT,
    met_via               TEXT    CHECK(met_via IN ('event','online','warm','cold-outreach')),
    last_contacted        TEXT,
    follow_up_due         TEXT,
    relationship_strength INTEGER NOT NULL DEFAULT 1,
    project_relevance     TEXT,
    notes                 TEXT,
    created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_name    TEXT    NOT NULL,
    event_date    TEXT,
    location      TEXT,
    event_type    TEXT    CHECK(event_type IN ('hackathon','meetup','conference','networking')),
    attended      INTEGER NOT NULL DEFAULT 0,
    contacts_made INTEGER NOT NULL DEFAULT 0,
    notes         TEXT
  );

  CREATE TABLE IF NOT EXISTS networking_goals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    week_of         TEXT    NOT NULL UNIQUE,
    target_outreach INTEGER NOT NULL DEFAULT 1,
    actual_outreach INTEGER NOT NULL DEFAULT 0,
    target_events   INTEGER NOT NULL DEFAULT 0,
    actual_events   INTEGER NOT NULL DEFAULT 0
  );
`);

// ── Content ideas table ───────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS content_ideas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    week_of      TEXT    NOT NULL,
    title        TEXT    NOT NULL,
    hook         TEXT,
    core_insight TEXT,
    account      TEXT    NOT NULL DEFAULT 'self' CHECK(account IN ('dad', 'self')),
    suggested_at TEXT    NOT NULL DEFAULT (datetime('now')),
    chosen       INTEGER NOT NULL DEFAULT 0,
    posted       INTEGER NOT NULL DEFAULT 0
  );
`);

// ── 52 Builds tables ──────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS builds (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    week_number  INTEGER NOT NULL,
    title        TEXT    NOT NULL,
    description  TEXT,
    idea_source  TEXT    NOT NULL DEFAULT 'self',
    project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    status       TEXT    NOT NULL DEFAULT 'ideating'
                         CHECK(status IN ('ideating','building','shipped','archived','elevated')),
    has_legs     INTEGER NOT NULL DEFAULT 0,
    elevated_to  TEXT,
    built_at     TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS build_ideas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    week_number  INTEGER NOT NULL,
    title        TEXT    NOT NULL,
    description  TEXT,
    rationale    TEXT,
    suggested_at TEXT    NOT NULL DEFAULT (datetime('now')),
    chosen       INTEGER NOT NULL DEFAULT 0
  );
`);

// Auto-update updated_at on tasks
db.exec(`
  CREATE TRIGGER IF NOT EXISTS tasks_updated_at
  AFTER UPDATE ON tasks
  FOR EACH ROW
  BEGIN
    UPDATE tasks SET updated_at = datetime('now') WHERE id = OLD.id;
  END;
`);

// ── seedData ──────────────────────────────────────────────────────────────────
// Only runs on a fresh database (projects table empty).
// To re-seed: delete personal_os.db and restart.

function seedData() {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM projects`).get().n;
  if (count > 0) {
    console.log(`[db] Projects table has ${count} row(s) — skipping seed.`);
    return;
  }
  console.log('[db] Empty database detected — running seed...');

  db.transaction(() => {
    const insertProject = db.prepare(`
      INSERT INTO projects (name, status, north_star, current_phase, priority_rank, milestones)
      VALUES (?, 'active', ?, ?, ?, ?)
    `);

    const p = {};

    p.matrix = insertProject.run(
      'Matrix Media Solutions',
      'Active CEO by year 2. ₹20L/month profit in 12 months, ₹30-40L stretch goal.',
      'Pre-revenue restructuring. Lead sequences start May 4. Building own client base.',
      1,
      'First own client signed | Lead portal built | One vertical fully restructured | ₹12L/month by Aug | ₹20L/month by May 2026'
    ).lastInsertRowid;

    p.autumn = insertProject.run(
      'Autumn (Co-founder)',
      '₹20L/month each (me + Mayank) in 5 years across multiple products: Autumn, Tyushan, Lodestone, pipeline.',
      'Autumn launching in ~2 weeks. My lane: operations, marketing, sales, testing.',
      3,
      'Autumn launch | 1 new user/day | Next product decided by May 16 | Tyushan/Lodestone MVP started'
    ).lastInsertRowid;

    p.lumiere = insertProject.run(
      'Lumiere Internship',
      'Leave with full-time offer. Part-time offer minimum. Be the person they fight to keep.',
      'Pre-internship. Starts June 4. Role TBD.',
      2,
      'Day 1 strong start | First deliverable shipped | Mid-internship check-in | Offer conversation initiated | Exit with offer'
    ).lastInsertRowid;

    p.brand = insertProject.run(
      'Personal Brand',
      'Top 0.5% rooms. 100K Instagram. Known at intersection of tech + business + founder life.',
      "Zero. Building from scratch. Posting schedule: Mon (dad's LinkedIn), Tue + Thu (my LinkedIn).",
      4,
      '12 weeks consistent posting | First post hits 1K impressions | 500 LinkedIn followers | First inbound from content'
    ).lastInsertRowid;

    p.pos = insertProject.run(
      'Personal Operating System',
      'Non-negotiable identity stack: gym 3x/week, 10 pages/day, skincare morning + night.',
      'Active. Tracking streaks as identity signals not failures.',
      5,
      '4-week gym streak | 30-day reading streak | Morning routine locked in'
    ).lastInsertRowid;

    p.krea = insertProject.run(
      'Krea + Actuarial',
      'Degree completed April 2027. Actuarial as optionality hedge.',
      'Dormant. No current commitments. Tasks added as they appear.',
      6,
      'No active milestones yet'
    ).lastInsertRowid;

    // ── Tasks ──────────────────────────────────────────────────────────────────

    const insertTask = db.prepare(`
      INSERT INTO tasks (project_id, title, priority, deadline, recurrence, status)
      VALUES (?, ?, ?, ?, ?, 'todo')
    `);

    // Matrix
    insertTask.run(p.matrix, 'Send outreach sequences',                    'high',     null,         'weekly-MON');
    insertTask.run(p.matrix, 'Follow up on leads',                         'high',     null,         'weekly-WED');
    insertTask.run(p.matrix, 'Capture new ideas for Matrix (do not drop)', 'medium',   null,         'weekly-SUN');
    insertTask.run(p.matrix, 'Check intern progress on lead gen',          'high',     null,         'weekly-MON');
    insertTask.run(p.matrix, 'Build lead management portal',               'high',     '2025-08-01', null);
    insertTask.run(p.matrix, 'Sign first own client',                      'critical', '2025-07-01', null);

    // Autumn
    insertTask.run(p.autumn, 'Autumn launch QA and testing',              'critical', '2025-05-16', null);
    insertTask.run(p.autumn, 'Decide next product: Tyushan or Lodestone', 'high',     '2025-05-16', null);
    insertTask.run(p.autumn, 'Daily operations check post-launch',        'medium',   null,         'daily');
    insertTask.run(p.autumn, '1 new user acquisition action',             'high',     null,         'daily');

    // Lumiere
    insertTask.run(p.lumiere, 'Research Lumiere/Veritas AI — understand what they do', 'medium', '2025-05-25', null);
    insertTask.run(p.lumiere, 'Prep mindset: read Black Box Thinking before June 4',        'medium', '2025-06-03', null);

    // Personal Brand
    insertTask.run(p.brand, "Write + post LinkedIn (dad's account)",         'high',   null, 'weekly-MON');
    insertTask.run(p.brand, 'Write + post LinkedIn (my account) — Tuesday',  'high',   null, 'weekly-TUE');
    insertTask.run(p.brand, 'Write + post LinkedIn (my account) — Thursday', 'high',   null, 'weekly-THU');
    insertTask.run(p.brand, 'Content idea check-in',                         'medium', null, 'weekly-FRI');

    // Personal OS
    insertTask.run(p.pos, 'Gym session',              'medium', null, 'weekly-MON,WED,FRI');
    insertTask.run(p.pos, 'Read 10 pages',            'medium', null, 'daily');
    insertTask.run(p.pos, 'Morning skincare routine', 'low',    null, 'daily');
    insertTask.run(p.pos, 'Night skincare routine',   'low',    null, 'daily');

    // ── Books ──────────────────────────────────────────────────────────────────

    const insertBook = db.prepare(`
      INSERT INTO books (title, author, order_rank, status, started_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const today = new Date().toISOString().slice(0, 10);

    insertBook.run('Pitch',                            'Danny Fontaine',              1,  'reading', today);
    insertBook.run('The Hard Thing About Hard Things', 'Ben Horowitz',                2,  'unread',  null);
    insertBook.run('CEO Excellence',                   'Carolyn Dewar et al',         3,  'unread',  null);
    insertBook.run('The Tipping Point',                'Malcolm Gladwell',            4,  'unread',  null);
    insertBook.run('Black Box Thinking',               'Matthew Syed',                5,  'unread',  null);
    insertBook.run('The Deals of Warren Buffett',      'Glen Arnold',                 6,  'unread',  null);
    insertBook.run('One Up on Wall Street',            'Peter Lynch',                 7,  'unread',  null);
    insertBook.run('Total Leadership',                 'Stewart Friedman',            8,  'unread',  null);
    insertBook.run('The India Way',                    'Peter Cappelli et al',        9,  'unread',  null);
    insertBook.run('Culture Build',                    null,                          10, 'unread',  null);
    insertBook.run('Palace of Illusions',              'Chitra Banerjee Divakaruni', 11, 'unread',  null);
    insertBook.run("Ramayana from Sita's POV",         null,                          12, 'unread',  null);
  })();

  console.log('[db] Seed data inserted: 6 projects, 20 tasks, 12 books.');
}

seedData();

// ── Week-1 build seed ─────────────────────────────────────────────────────────
// Runs once, only if builds table is empty.

function seedBuilds() {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM builds`).get().n;
  if (count > 0) return;

  const matrixProject = db.prepare(
    `SELECT id FROM projects WHERE name LIKE '%Matrix%' LIMIT 1`
  ).get();

  db.prepare(`
    INSERT INTO builds (week_number, title, description, idea_source, project_id, status)
    VALUES (1, 'Matrix Sales Agent',
      'Claude-powered agent that knows Matrix services and ICP. Helps prep for sales calls, suggests follow-up sequences, drafts outreach.',
      'self', ?, 'building')
  `).run(matrixProject?.id || null);

  console.log('[db] Builds seed: week 1 "Matrix Sales Agent" inserted.');
}

seedBuilds();

// ── getCurrentBuildWeek ───────────────────────────────────────────────────────
// Weeks count from 2025-05-05. Week 1 = May 5–11 2025.

function getCurrentBuildWeek(now = new Date()) {
  const start = new Date('2025-05-05T00:00:00.000Z');
  return Math.max(1, Math.floor((now - start) / (7 * 24 * 60 * 60 * 1000)) + 1);
}

// ── Immediate action task seeds ───────────────────────────────────────────────
// Inserts priority tasks on every startup if not already open. Safe to re-run.

function seedActionTasks() {
  const deadlinePlus14 = new Date();
  deadlinePlus14.setDate(deadlinePlus14.getDate() + 14);
  const deadline14 = deadlinePlus14.toISOString().slice(0, 10);

  const brandId  = db.prepare(`SELECT id FROM projects WHERE name LIKE '%Personal Brand%' LIMIT 1`).get()?.id || null;
  const autumnId = db.prepare(`SELECT id FROM projects WHERE name LIKE '%Autumn%' LIMIT 1`).get()?.id        || null;

  const alreadyOpen = db.prepare(
    `SELECT 1 FROM tasks WHERE title = ? AND status NOT IN ('done','cancelled','archived') LIMIT 1`
  );
  const insert = db.prepare(`
    INSERT INTO tasks (project_id, title, priority, deadline, recurrence, status)
    VALUES (?, ?, ?, ?, ?, 'todo')
  `);

  const tasks = [
    [brandId,  'Update LinkedIn headline: BD + restructuring at Matrix · building AI products at Corelinq · CS @ Krea', 'critical', null,       null    ],
    [brandId,  'Write Instagram reintroduction carousel — 4 slides, sets entire account tone',                          'critical', null,       null    ],
    [autumnId, 'Diagnose Autumn blocker with Mayank',                                                                   'critical', null,       null    ],
    [autumnId, 'Identify 5 people to interview for Insurance OS validation',                                            'high',     deadline14, null    ],
    [brandId,  'Curate 30-50 photos from gallery for Instagram content',                                                'high',     deadline14, null    ],
    [brandId,  'Write and pin one LinkedIn post showing a real business outcome',                                       'high',     deadline14, null    ],
    [autumnId, 'Weekly Mayank sync on Autumn progress',                                                                 'high',     null,       'weekly'],
  ];

  let inserted = 0;
  for (const [projectId, title, priority, deadline, recurrence] of tasks) {
    if (!alreadyOpen.get(title)) {
      insert.run(projectId, title, priority, deadline, recurrence);
      inserted++;
    }
  }

  if (inserted > 0) console.log(`[db] Action tasks seeded: ${inserted} new task(s) inserted.`);
}

seedActionTasks();

module.exports = db;
module.exports.getCurrentBuildWeek = getCurrentBuildWeek;
