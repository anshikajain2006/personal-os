'use strict';

require('dotenv').config({ path: '.env.example' });
const Anthropic = require('@anthropic-ai/sdk');
const db        = require('./db');
const { getCurrentBuildWeek } = require('./db');
const { sendEmail } = require('./email');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Date helpers ──────────────────────────────────────────────────────────────

function getNextMonday(d = new Date()) {
  const day = d.getDay();
  const daysUntil = day === 0 ? 1 : (8 - day) % 7 || 7;
  const next = new Date(d);
  next.setDate(d.getDate() + daysUntil);
  return next.toISOString().slice(0, 10);
}

// ── Build ideas HTML ──────────────────────────────────────────────────────────

function ideasToHtml(text, weekNum) {
  const lines = text.split('\n');
  let html    = `<h2 style="color:#7ee787;margin-top:0;margin-bottom:4px;">52 BUILDS — WEEK ${weekNum}</h2>`;
  html += `<p style="color:#5a5a5a;font-size:12px;margin-bottom:16px;">Pick one and reply. Build something this weekend.</p>`;

  let inIdea = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) { html += '<div style="height:4px"></div>'; continue; }

    const ideaHeader = line.match(/^IDEA\s+(\d+):\s*(.+)$/i);
    if (ideaHeader) {
      if (inIdea) html += '</div>';
      html += `<div style="margin:12px 0;padding:10px 14px;background:#111111;border-left:3px solid #e3b341;border-radius:2px;">`;
      html += `<h3 style="color:#e3b341;margin:0 0 6px 0;font-size:13px;">IDEA ${ideaHeader[1]}: ${ideaHeader[2]}</h3>`;
      inIdea = true;
      continue;
    }

    const fieldMatch = line.match(/^(What|Why this week|Scope|Could become):\s*(.+)$/i);
    if (fieldMatch && inIdea) {
      const COLORS = { 'What': '#c0c0c0', 'Why this week': '#7ee787', 'Scope': '#58a6ff', 'Could become': '#a78bfa' };
      html += (
        `<p style="margin:2px 0;font-size:12px;">` +
        `<strong style="color:${COLORS[fieldMatch[1]] || '#c0c0c0'}">${fieldMatch[1]}:</strong> ` +
        `<span style="color:#909090">${fieldMatch[2]}</span></p>`
      );
      continue;
    }

    html += `<p style="color:#5a5a5a;font-size:11px;">${line}</p>`;
  }

  if (inIdea) html += '</div>';
  return html;
}

// ── Content ideas HTML ────────────────────────────────────────────────────────

function contentToHtml(text, weekOf) {
  const lines = text.split('\n');
  let html    = `<h2 style="color:#58a6ff;margin-top:0;margin-bottom:4px;">CONTENT — WEEK OF ${weekOf}</h2>`;
  html += `<p style="color:#5a5a5a;font-size:12px;margin-bottom:16px;">3 slots: Mon (dad's LinkedIn) · Tue · Thu (yours). Pick your angles.</p>`;

  let inIdea  = false;
  let ideaNum = 0;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) { html += '<div style="height:4px"></div>'; continue; }

    const numMatch   = line.match(/^(\d+)\.\s*(.*)$/);
    const angleMatch = line.match(/^ANGLE:\s*(.+)$/i);

    if (angleMatch) {
      if (inIdea) html += '</div>';
      ideaNum++;
      html += `<div style="margin:12px 0;padding:10px 14px;background:#111111;border-left:3px solid #58a6ff;border-radius:2px;">`;
      html += `<h3 style="color:#58a6ff;margin:0 0 6px 0;font-size:13px;">${ideaNum}. ${angleMatch[1]}</h3>`;
      inIdea = true;
      continue;
    }

    if (numMatch && !inIdea && numMatch[2]) {
      ideaNum++;
      html += `<div style="margin:12px 0;padding:10px 14px;background:#111111;border-left:3px solid #58a6ff;border-radius:2px;">`;
      html += `<h3 style="color:#58a6ff;margin:0 0 6px 0;font-size:13px;">${ideaNum}. ${numMatch[2]}</h3>`;
      inIdea = true;
      continue;
    }

    const fieldMatch = line.match(/^(Hook|Core insight|Best for):\s*(.+)$/i);
    if (fieldMatch && inIdea) {
      const COLORS = { 'Hook': '#f0f0f0', 'Core insight': '#c0c0c0', 'Best for': '#a78bfa' };
      html += (
        `<p style="margin:2px 0;font-size:12px;">` +
        `<strong style="color:${COLORS[fieldMatch[1]] || '#c0c0c0'}">${fieldMatch[1]}:</strong> ` +
        `<span style="color:#909090">${fieldMatch[2]}</span></p>`
      );
      continue;
    }

    if (inIdea && line.trim()) html += `<p style="color:#5a5a5a;font-size:11px;">${line}</p>`;
  }

  if (inIdea) html += '</div>';
  return html;
}

// ── AI parsing ────────────────────────────────────────────────────────────────

async function parseBuildFromText(text, weekNum) {
  if (!text || text.trim().length < 5) return null;

  const ideas    = db.prepare(`SELECT * FROM build_ideas WHERE week_number = ? ORDER BY id ASC LIMIT 5`).all(weekNum);
  const ideasCtx = ideas.length
    ? ideas.map((idea, i) => `${i + 1}. ${idea.title}: ${idea.description || ''}`).join('\n')
    : '(no system ideas were suggested this week)';

  let response;
  try {
    response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `Suggested build ideas this week:\n${ideasCtx}\n\nUser text: ${JSON.stringify(text.slice(0, 600))}\n\nIf the user is committing to build something (picked an idea or described their own), return ONLY valid JSON:\n{"title": "...", "description": "...", "idea_number": 1-5 or null, "project": "Matrix" or "Autumn" or "Personal Brand" or "Personal OS" or null}\nIf no build commitment found, return the word: null`,
      }],
    });
  } catch (err) {
    console.error('[buildWeek] parseBuildFromText error:', err.message);
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

function projectNameToId(name) {
  if (!name) return null;
  const row = db.prepare(`SELECT id FROM projects WHERE name LIKE ? LIMIT 1`).get(`%${name}%`);
  return row?.id || null;
}

// ── Core: create build from reply ─────────────────────────────────────────────

async function createBuildFromReply(text, weekNum) {
  const wk = weekNum ?? getCurrentBuildWeek();

  const existing = db.prepare(`SELECT id FROM builds WHERE week_number = ?`).get(wk);
  if (existing) return null;

  const parsed = await parseBuildFromText(text, wk);
  if (!parsed?.title) return null;

  const projectId = projectNameToId(parsed.project);

  if (parsed.idea_number) {
    const ideas  = db.prepare(`SELECT id FROM build_ideas WHERE week_number = ? ORDER BY id ASC LIMIT 5`).all(wk);
    const chosen = ideas[parsed.idea_number - 1];
    if (chosen) db.prepare(`UPDATE build_ideas SET chosen = 1 WHERE id = ?`).run(chosen.id);
  }

  const buildId = db.prepare(`
    INSERT INTO builds (week_number, title, description, idea_source, project_id, status)
    VALUES (?, ?, ?, ?, ?, 'ideating')
  `).run(wk, parsed.title, parsed.description || null,
    parsed.idea_number ? 'system-suggested' : 'self', projectId).lastInsertRowid;

  console.log(`[buildWeek] Build #${buildId} week ${wk}: "${parsed.title}" created from reply`);
  return { buildId, title: parsed.title, projectId };
}

// ── Core: handle "has legs" reply ─────────────────────────────────────────────

function handleLegsReply(replyText) {
  if (!replyText) return null;

  const build = db.prepare(`
    SELECT * FROM builds
    WHERE status = 'shipped' AND has_legs = 0
    ORDER BY built_at DESC LIMIT 1
  `).get();
  if (!build) return null;

  const lower    = replyText.toLowerCase();
  const yesMatch = replyText.match(/\byes\b[^a-z]*[—\-]\s*([a-zA-Z ]+)/i);

  if (yesMatch) {
    const projectName = yesMatch[1].trim();
    const projectId   = projectNameToId(projectName) || build.project_id;
    const deadline    = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    db.prepare(`UPDATE builds SET status = 'elevated', has_legs = 1, elevated_to = ? WHERE id = ?`).run(projectName, build.id);
    db.prepare(`INSERT INTO tasks (project_id, title, priority, deadline, status) VALUES (?, ?, 'medium', ?, 'todo')`)
      .run(projectId, `Evaluate "${build.title}" for integration`, deadline);
    db.prepare(`INSERT INTO ideas (project_id, idea_text, status) VALUES (?, ?, 'raw')`)
      .run(projectId, `52 Builds week ${build.week_number}: "${build.title}" — has legs, evaluate for ${projectName} integration`);

    console.log(`[buildWeek] Build #${build.id} "${build.title}" elevated → ${projectName}`);
    return { action: 'elevated', build, projectName };
  }

  if (/\bno\b/i.test(lower)) {
    db.prepare(`UPDATE builds SET status = 'archived' WHERE id = ?`).run(build.id);
    console.log(`[buildWeek] Build #${build.id} "${build.title}" archived`);
    return { action: 'archived', build };
  }

  return null;
}

// ── Saturday: build ideas section ────────────────────────────────────────────

async function generateBuildIdeasSection(weekNum) {
  const lastBuild  = db.prepare(`SELECT title FROM builds WHERE week_number = ? LIMIT 1`).get(weekNum - 1);
  const lastWeekCtx = lastBuild ? `Last week's build: ${lastBuild.title}` : 'No prior week logged yet.';

  const prompt = `The user is a 20-year-old CS undergrad and co-founder building 52 tools in 52 weeks. Suggest 5 build ideas for this week.

Their context:
- Matrix Media Solutions: needs sales tools, lead management, client reporting, intern coordination
- Autumn: WhatsApp photo editing bot, needs ops/marketing tools
- Personal Brand: LinkedIn posting, content scheduling
- Personal OS: habit tracking, book tracking
- General: they build with Claude/AI, ship fast, weekend builds

${lastWeekCtx}

For each idea:
IDEA [N]: [title]
What: [1 sentence]
Why this week: [connects to their actual current situation]
Scope: [simple = few hours / medium = 1-2 days / complex = full weekend]
Could become: [throwaway / Matrix tool / Autumn feature / standalone product]

Mix the 5 ideas: 2 simple, 2 medium, 1 complex.
At least 2 should directly solve a current Matrix or Autumn problem.`;

  const aiResponse = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1536,
    system: [{
      type: 'text',
      text: 'You are a build advisor for a young founder building 52 tools in 52 weeks. Suggest specific, shippable weekend builds that compound toward their actual goals.',
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: prompt }],
  });

  const text = aiResponse.content.filter(b => b.type === 'text').map(b => b.text).join('');

  const insert     = db.prepare(`INSERT INTO build_ideas (week_number, title, description, rationale) VALUES (?, ?, ?, ?)`);
  const ideaRegex  = /IDEA\s+\d+:\s*(.+?)\nWhat:\s*(.+?)(?:\n|$)(?:.*?Why this week:\s*(.+?)(?:\n|$))?/gi;
  let m;
  while ((m = ideaRegex.exec(text)) !== null) {
    insert.run(weekNum, m[1].trim(), m[2].trim(), m[3]?.trim() || null);
  }

  console.log(`[saturdayMorning] Build ideas generated: ${aiResponse.usage.input_tokens}→${aiResponse.usage.output_tokens} tokens`);
  return text;
}

// ── Saturday: content ideas section ──────────────────────────────────────────

async function generateContentIdeasSection(weekOf) {
  const projects       = db.prepare(`SELECT * FROM projects WHERE status != 'archived' ORDER BY priority_rank ASC LIMIT 6`).all();
  const projectContext = projects.map(p => `${p.name}: ${p.current_phase || 'active'}`).join('; ');

  const weekNum     = getCurrentBuildWeek();
  const currentBuild = db.prepare(`SELECT * FROM builds WHERE week_number = ? LIMIT 1`).get(weekNum);
  const buildCtx    = currentBuild
    ? `This week's 52 Build: ${currentBuild.title}${currentBuild.description ? ' — ' + currentBuild.description.slice(0, 80) : ''}`
    : 'No 52 Build logged yet this week.';

  const prompt = `Suggest 5 LinkedIn content ideas for a 20-year-old CS undergrad who is also a co-founder and business development lead.

Their projects this week: ${projectContext}
Their audience: founders, students, hiring managers
Their aesthetic: tech-founder meets business, Indian context, building in public, no cringe motivation content
Their 52 build this week: ${buildCtx}

For each idea:
ANGLE: [title]
Hook: [opening line, max 12 words, scroll-stopper]
Core insight: [what makes this worth reading, 1-2 sentences]
Best for: [Mon dad account — professional/business tone] or [Tue/Thu — your voice, builder/founder tone]

Number each idea 1–5. Plain text only.`;

  const aiResponse = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [{
      type: 'text',
      text: 'You are a content strategist for a young Indian founder building in public. Avoid generic motivational content. Be specific, real, and tied to their actual work.',
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: prompt }],
  });

  const text   = aiResponse.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const insert = db.prepare(`INSERT INTO content_ideas (week_of, title, hook, core_insight, account) VALUES (?, ?, ?, ?, ?)`);

  const sections = text.split(/(?=\n\d+\.\s|\nANGLE:)/i).filter(Boolean);
  for (const section of sections) {
    const angleMatch   = section.match(/ANGLE:\s*(.+?)(?:\n|$)/i);
    const hookMatch    = section.match(/Hook:\s*(.+?)(?:\n|$)/i);
    const insightMatch = section.match(/Core insight:\s*(.+?)(?:\n|$)/i);
    const bestForMatch = section.match(/Best for:\s*(.+?)(?:\n|$)/i);
    if (!angleMatch) continue;
    const account = /dad/i.test(bestForMatch?.[1] || '') ? 'dad' : 'self';
    insert.run(weekOf, angleMatch[1].trim(), hookMatch?.[1]?.trim() || null, insightMatch?.[1]?.trim() || null, account);
  }

  console.log(`[saturdayMorning] Content ideas generated for week of ${weekOf}: ${aiResponse.usage.input_tokens}→${aiResponse.usage.output_tokens} tokens`);
  return text;
}

// ── Main: Saturday morning combined job ──────────────────────────────────────

async function runSaturdayMorningJob() {
  const weekNum    = getCurrentBuildWeek();
  const nextMonday = getNextMonday();

  const buildExists       = !!db.prepare(`SELECT id FROM builds WHERE week_number = ?`).get(weekNum);
  const buildIdeasExist   = !!db.prepare(`SELECT id FROM build_ideas WHERE week_number = ?`).get(weekNum);
  const contentIdeasExist = !!db.prepare(`SELECT id FROM content_ideas WHERE week_of = ?`).get(nextMonday);

  const needsBuildIdeas   = !buildExists && !buildIdeasExist;
  const needsContentIdeas = !contentIdeasExist;

  if (!needsBuildIdeas && !needsContentIdeas) {
    console.log(`[saturdayMorning] Nothing to generate for week ${weekNum} — skipping.`);
    return null;
  }

  let buildHtml   = '';
  let contentHtml = '';

  if (needsBuildIdeas) {
    const text = await generateBuildIdeasSection(weekNum);
    buildHtml  = ideasToHtml(text, weekNum);
  }

  if (needsContentIdeas) {
    const text  = await generateContentIdeasSection(nextMonday);
    contentHtml = contentToHtml(text, nextMonday);
  }

  const divider = buildHtml && contentHtml ? `<hr style="border-color:#1e1e1e;margin:32px 0">` : '';

  const htmlBody = (
    `<h1 style="color:#4dcc80;font-size:15px;letter-spacing:2px;margin-bottom:24px;">SATURDAY MORNING</h1>` +
    buildHtml + divider + contentHtml +
    `<hr style="border-color:#2a2a2a;margin:24px 0">` +
    `<p style="color:#5a5a5a;font-size:11px;">Reply with your picks. Or just build and post.</p>`
  );

  const displayDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const subject     = `Saturday Morning — ${displayDate}`;
  const replyTag    = `saturday-morning-${new Date().toISOString().slice(0, 10)}`;

  await sendEmail(subject, htmlBody, replyTag);

  console.log(`[saturdayMorning] Sent "${subject}" | tag: ${replyTag}`);
  console.log(`[saturdayMorning] builds: ${needsBuildIdeas ? 'sent' : 'skipped'} | content: ${needsContentIdeas ? 'sent' : 'skipped'}`);

  return { weekNum, nextMonday, sentBuildIdeas: needsBuildIdeas, sentContentIdeas: needsContentIdeas, replyTag };
}

module.exports = { runSaturdayMorningJob, createBuildFromReply, handleLegsReply, ideasToHtml };
