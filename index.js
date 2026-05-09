'use strict';

console.log('[startup] beginning...');

try {

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const cron = require('node-cron');

const { nightBrief }                            = require('./nightBrief');
const { morningPlan }                           = require('./morningPlan');
const { sendWeeklyReview }                      = require('./weeklyReview');
const { sendMonthlyAudit, isLastFridayOfMonth } = require('./monthlyAudit');
const { generateContentIdeas }                  = require('./contentIdeas');
const { runSaturdayMorningJob }                 = require('./buildWeek');

// ── Helpers ───────────────────────────────────────────────────────────────────

const IST_MS = (5 * 60 + 30) * 60 * 1000;

function nextRunIST(hour, minute, weekday = null) {
  const nowIST = new Date(Date.now() + IST_MS);
  const t      = new Date(nowIST);
  t.setUTCHours(hour, minute, 0, 0);

  if (weekday === null) {
    if (t <= nowIST) t.setUTCDate(t.getUTCDate() + 1);
  } else {
    let diff = (weekday - t.getUTCDay() + 7) % 7;
    if (diff === 0 && t <= nowIST) diff = 7;
    t.setUTCDate(t.getUTCDate() + diff);
  }

  return new Date(t.getTime() - IST_MS);
}

function fmtIST(date) {
  return date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) + ' IST';
}

function safeRun(label, fn) {
  fn().catch(err => console.error(`[index] ${label} failed: ${err.message}`));
}

// ── CLI: --run-now <job> ──────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const flagIdx   = args.indexOf('--run-now');
const runNowJob = flagIdx !== -1 ? args[flagIdx + 1] : null;

const JOBS = {
  'night-brief':     nightBrief,
  'morning-plan':    morningPlan,
  'weekly-review':   sendWeeklyReview,
  'monthly-audit':   sendMonthlyAudit,
  'content-ideas':    generateContentIdeas,
  'saturday-morning': runSaturdayMorningJob,
};

if (runNowJob) {
  const fn = JOBS[runNowJob];
  if (!fn) {
    console.error(
      `[index] Unknown job: "${runNowJob}"\n` +
      `        Valid jobs: ${Object.keys(JOBS).join(', ')}`
    );
    process.exit(1);
  }

  console.log(`[index] --run-now ${runNowJob} …`);
  fn()
    .then(result => {
      if (result) console.log('[index] Result:\n' + JSON.stringify(result, null, 2));
      else        console.log('[index] Job returned no output (idempotent skip or no tasks).');
      process.exit(0);
    })
    .catch(err => {
      console.error('[index] Job error:', err.message);
      if (err.stack) console.error(err.stack);
      process.exit(1);
    });

// ── Normal startup ────────────────────────────────────────────────────────────
} else {
  require('./server');

  // ── Night brief — 9:00 PM IST ─────────────────────────────────────────────
  cron.schedule('0 21 * * *', () => {
    console.log('[index] Cron fired: night-brief');
    safeRun('night-brief', nightBrief);
  }, { timezone: 'Asia/Kolkata' });

  // ── Morning plan — 7:00 AM IST ────────────────────────────────────────────
  cron.schedule('0 7 * * *', () => {
    console.log('[index] Cron fired: morning-plan');
    safeRun('morning-plan', morningPlan);
  }, { timezone: 'Asia/Kolkata' });

  // ── Weekly review — every Friday 8:00 PM IST ──────────────────────────────
  // On the last Friday of the month the monthly audit also runs.
  cron.schedule('0 20 * * 5', () => {
    console.log('[index] Cron fired: weekly-review');
    safeRun('weekly-review', sendWeeklyReview);

    if (isLastFridayOfMonth()) {
      console.log('[index] Cron fired: monthly-audit (last Friday of month)');
      safeRun('monthly-audit', sendMonthlyAudit);
    }
  }, { timezone: 'Asia/Kolkata' });

  // ── Saturday morning — 9:00 AM IST ───────────────────────────────────────
  // Combined: build ideas (if no build logged) + content ideas (if none for next week).
  cron.schedule('0 9 * * 6', () => {
    console.log('[index] Cron fired: saturday-morning');
    safeRun('saturday-morning', runSaturdayMorningJob);
  }, { timezone: 'Asia/Kolkata' });

  // ── Startup summary ───────────────────────────────────────────────────────
  const nextNight    = fmtIST(nextRunIST(21, 0));
  const nextMorning  = fmtIST(nextRunIST(7, 0));
  const nextFriday   = fmtIST(nextRunIST(20, 0, 5));
  const nextSaturday = fmtIST(nextRunIST(8, 0, 6));

  console.log('[index] Scheduled jobs:');
  console.log(`  night-brief     → daily        21:00 IST  next: ${nextNight}`);
  console.log(`  morning-plan    → daily         7:00 IST  next: ${nextMorning}`);
  console.log(`  weekly-review   → every Fri    20:00 IST  next: ${nextFriday}`);
  console.log(`  monthly-audit   → last Fri     20:00 IST  next: (piggybacks weekly-review)`);
  console.log(`  saturday-morning → every Sat    9:00 IST  next: ${nextSaturday} (builds + content combined)`);
}

} catch (err) {
  console.error('[startup] FATAL ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
}
