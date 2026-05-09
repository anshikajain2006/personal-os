'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const db        = require('./db');
const { sendEmail } = require('./email');
const { getWeekStart } = require('./weeklyReview');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a content strategist for a young founder and operator.

The user posts on LinkedIn:
- Monday: on their dad's LinkedIn account (business/leadership lens, older professional audience)
- Tuesday + Thursday: on their own LinkedIn account (tech founder meets business meets personal growth — authentic, specific, no fluff)

Given context about their 6 active projects, generate exactly 5 LinkedIn content ideas.

For each idea output these five fields in this exact order:
POST ANGLE: [short punchy title]
ACCOUNT: Dad's / Mine
DAY: Mon / Tue / Thu
HOOK: [first line of the post — the scroll-stopper sentence, max 15 words]
CORE IDEA: [1–2 sentences on what the post is actually about]

Number each idea 1–5. Output plain text only. No markdown, no asterisks, no backticks.`;

function buildPrompt(projects) {
  const projectContext = projects.map(p =>
    `${p.name} (priority ${p.priority_rank})\n  Goal: ${p.north_star || 'not set'}\n  Now: ${p.current_phase || 'unknown'}`
  ).join('\n\n');

  return (
    `My 6 active projects:\n\n${projectContext}\n\n` +
    `Personal brand north star: Top 0.5% rooms. 100K Instagram. Known at intersection of tech + business + founder life.\n\n` +
    `Generate 5 LinkedIn content ideas for next week (Mon/Tue/Thu posting days).`
  );
}

// ── HTML conversion ───────────────────────────────────────────────────────────

function ideasToHtml(text) {
  const lines = text.split('\n');
  let html = '<h1 style="color:#7ee787">Content Ideas — Next Week</h1>';

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) { html += '<div style="height:10px"></div>'; continue; }

    // Numbered idea header (e.g. "1." or "1. POST ANGLE:")
    if (/^\d+\./.test(line.trim())) {
      html += `<h2 style="color:#e3b341;margin-top:24px;margin-bottom:6px;">${line.trim()}</h2>`;
      continue;
    }

    // Labeled fields
    const fieldMatch = line.trim().match(/^(POST ANGLE|ACCOUNT|DAY|HOOK|CORE IDEA):\s*(.+)$/i);
    if (fieldMatch) {
      const [, label, value] = fieldMatch;
      const labelColor = {
        'POST ANGLE': '#58a6ff',
        'ACCOUNT':    '#c0c0c0',
        'DAY':        '#c0c0c0',
        'HOOK':       '#f0f0f0',
        'CORE IDEA':  '#a8a8a8',
      }[label.toUpperCase()] || '#c0c0c0';
      html += (
        `<p style="margin:3px 0 3px 8px;">` +
        `<strong style="color:${labelColor}">${label}:</strong> ` +
        `<span style="color:#c0c0c0">${value}</span></p>`
      );
      continue;
    }

    html += `<p style="color:#5a5a5a;font-size:12px;">${line}</p>`;
  }

  return html;
}

// ── Main export ───────────────────────────────────────────────────────────────

async function generateContentIdeas() {
  const weekStart = getWeekStart();
  const review    = db.prepare('SELECT * FROM weekly_reviews WHERE week_start_date = ?').get(weekStart);

  if (review?.content_ideas_sent) {
    console.log('[contentIdeas] Already sent this week — skipping.');
    return null;
  }

  if (review?.content_ideas_replied) {
    console.log('[contentIdeas] User provided content ideas in their reply — skipping auto-generation.');
    return null;
  }

  const projects = db.prepare(
    `SELECT * FROM projects WHERE status != 'archived' ORDER BY priority_rank ASC`
  ).all();

  const aiResponse = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'user', content: buildPrompt(projects) },
    ],
  });

  const ideasText = aiResponse.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  const displayDate = new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const subject  = `Content Ideas — Week of ${displayDate}`;
  const replyTag = `content-ideas-${weekStart}`;
  const htmlBody = ideasToHtml(ideasText);

  await sendEmail(subject, htmlBody, replyTag);

  if (review) {
    db.prepare(
      `UPDATE weekly_reviews SET content_ideas_sent = 1 WHERE week_start_date = ?`
    ).run(weekStart);
  }

  console.log(`[contentIdeas] Sent  : "${subject}" | tag: ${replyTag}`);
  console.log(`[contentIdeas] Tokens: in=${aiResponse.usage.input_tokens} out=${aiResponse.usage.output_tokens} cache_read=${aiResponse.usage.cache_read_input_tokens ?? 0}`);

  return { ideasText, replyTag, weekStart };
}

module.exports = { generateContentIdeas };
