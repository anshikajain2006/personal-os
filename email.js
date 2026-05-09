'use strict';

require('dotenv').config();
const nodemailer = require('nodemailer');

// ── Transport ─────────────────────────────────────────────────────────────────

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ── Reply-tag helpers ─────────────────────────────────────────────────────────

// Embedded in three ways so it survives any client's quoting strategy:
//   1. HTML comment  → survives rich-HTML quoting
//   2. data attribute on a hidden div → parseable if attributes survive
//   3. plain-text bracket form inside the hidden div text → survives plain-text quoting
const MARKER = 'reply-tag:';

function embedTag(tag) {
  return `
<div style="display:none;max-height:0;overflow:hidden;font-size:0;
            line-height:0;color:transparent;mso-hide:all;"
     aria-hidden="true"
     data-reply-tag="${tag}">
  <!-- ${MARKER}${tag} -->[${MARKER}${tag}]
</div>`;
}

function parseReplyTag(emailBody) {
  if (!emailBody) return null;

  // HTML comment form (richest fidelity)
  const commentMatch = emailBody.match(/<!--\s*reply-tag:([A-Za-z0-9_-]+)\s*-->/);
  if (commentMatch) return commentMatch[1];

  // data-attribute form
  const attrMatch = emailBody.match(/data-reply-tag="([A-Za-z0-9_-]+)"/);
  if (attrMatch) return attrMatch[1];

  // Plain-text bracket form (most likely to appear in quoted-text replies)
  const textMatch = emailBody.match(/\[reply-tag:([A-Za-z0-9_-]+)\]/);
  if (textMatch) return textMatch[1];

  return null;
}

// ── HTML shell ────────────────────────────────────────────────────────────────

function buildHtml(htmlBody, replyToTag) {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #0e0e0e;
      color: #d4d4d4;
      font-family: 'Courier New', Courier, 'Lucida Console', monospace;
      font-size: 14px;
      line-height: 1.7;
      padding: 32px 16px;
    }
    .shell {
      max-width: 640px;
      margin: 0 auto;
      background: #141414;
      border: 1px solid #2a2a2a;
      border-radius: 6px;
      overflow: hidden;
    }
    .titlebar {
      background: #1e1e1e;
      border-bottom: 1px solid #2a2a2a;
      padding: 10px 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
    .dot-red   { background: #ff5f57; }
    .dot-yellow{ background: #febc2e; }
    .dot-green { background: #28c840; }
    .prompt {
      margin-left: 10px;
      color: #5a5a5a;
      font-size: 12px;
      letter-spacing: 0.04em;
    }
    .body {
      padding: 28px 32px;
    }
    h1, h2, h3 {
      color: #7ee787;
      margin-bottom: 16px;
      font-weight: normal;
      letter-spacing: 0.02em;
    }
    h1 { font-size: 18px; border-bottom: 1px solid #2a2a2a; padding-bottom: 12px; }
    h2 { font-size: 15px; color: #58a6ff; }
    h3 { font-size: 14px; color: #e3b341; }
    p  { margin-bottom: 14px; }
    ul, ol { padding-left: 20px; margin-bottom: 14px; }
    li { margin-bottom: 6px; }
    strong { color: #f0f0f0; }
    em     { color: #a8a8a8; font-style: normal; }
    code, pre {
      background: #1e1e1e;
      color: #79c0ff;
      border-radius: 4px;
      font-family: inherit;
    }
    code { padding: 1px 6px; }
    pre  { padding: 14px 18px; margin-bottom: 14px; overflow-x: auto; }
    a { color: #58a6ff; text-decoration: none; }
    hr {
      border: none;
      border-top: 1px solid #2a2a2a;
      margin: 24px 0;
    }
    .tag-pill {
      display: inline-block;
      background: #1e1e1e;
      border: 1px solid #2a2a2a;
      border-radius: 4px;
      color: #5a5a5a;
      font-size: 11px;
      padding: 2px 8px;
      letter-spacing: 0.06em;
    }
    .footer {
      padding: 16px 32px 20px;
      border-top: 1px solid #1e1e1e;
      color: #3a3a3a;
      font-size: 11px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="titlebar">
      <span class="dot dot-red"></span>
      <span class="dot dot-yellow"></span>
      <span class="dot dot-green"></span>
      <span class="prompt">personal-os ~ ${replyToTag || 'message'}</span>
    </div>

    <div class="body">
      ${htmlBody}
    </div>

    <div class="footer">
      <span>&copy; ${year} personal-os</span>
      <span class="tag-pill">${replyToTag || ''}</span>
    </div>

    ${replyToTag ? embedTag(replyToTag) : ''}
  </div>
</body>
</html>`;
}

// ── sendEmail ─────────────────────────────────────────────────────────────────

async function sendEmail(subject, htmlBody, replyToTag = '') {
  if (!process.env.SMTP_USER || !process.env.SMTP_HOST) {
    throw new Error('SMTP config missing — check .env (SMTP_HOST, SMTP_USER, SMTP_PASS)');
  }
  if (!process.env.RECIPIENT_EMAIL) {
    throw new Error('RECIPIENT_EMAIL not set in .env');
  }

  const html = buildHtml(htmlBody, replyToTag);

  const info = await transporter.sendMail({
    from:    `"Personal OS" <${process.env.SMTP_USER}>`,
    to:      process.env.RECIPIENT_EMAIL,
    subject,
    html,
    // Plain-text fallback keeps the tag parseable even in plain-text replies
    text: `${subject}\n\n[reply-tag:${replyToTag}]\n\n(View in an HTML-capable client for full formatting.)`,
  });

  return info;
}

module.exports = { sendEmail, parseReplyTag };
