# Personal OS

A self-hosted personal operating system that runs on email. Claude generates your daily schedule, night brief, weekly review, and monthly audit — you reply to act on them. Everything is tracked in a local SQLite database.

## What it does

| Time | Email | What it contains |
|------|-------|-----------------|
| 7:00 AM IST | Morning Plan | Time-blocked schedule, follow-ups due today, active habit constraints |
| 9:00 PM IST | Night Brief | Task prioritisation (High / Watch / Later), book nudge, networking miss alert, ideas capture |
| Friday 8:00 PM IST | Weekly Review | What moved, what didn't, decisions needed, event discovery, networking cadence |
| Last Friday 8:00 PM IST | Monthly Audit | Project scores, drift flags, routine audit, 52 Builds tracker, network growth |
| Saturday 9:00 AM IST | Saturday Morning | Build ideas (if no build logged) + content ideas for the coming week — one combined email |

All emails are dark-mode HTML with a terminal aesthetic. Every email embeds a reply tag so your replies are routed back to the right handler automatically.

## Stack

- **Runtime**: Node.js
- **Database**: SQLite via `better-sqlite3`
- **AI**: Anthropic Claude (`claude-sonnet-4-6` for generation, `claude-haiku-4-5-20251001` for parsing)
- **Email**: Nodemailer (outbound) + webhook (inbound replies)
- **Scheduler**: `node-cron`
- **Server**: Express

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create `.env`

```bash
cp .env.example .env
```

Fill in:

```
ANTHROPIC_API_KEY=sk-ant-...
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx   # Gmail App Password — not your login password
RECIPIENT_EMAIL=you@gmail.com
PORT=3000                        # optional, defaults to 3000
```

For Gmail: enable 2-Step Verification → Google Account → Security → App passwords → generate one for Mail.

### 3. Configure email reply routing

When you reply to an email, that reply needs to reach `POST /your-server/webhook/reply`. You need a service that converts inbound email into an HTTP POST:

- **[Cloudmailin](https://cloudmailin.com)** — gives you an email address; anything sent there is POSTed to your webhook. Set `RECIPIENT_EMAIL` to your Cloudmailin address.
- **[Mailgun inbound routing](https://www.mailgun.com/products/receive-email/)** — route received mail to your webhook URL.
- **Zapier** — Gmail trigger → Webhooks action. Free tier has ~15 min delay.

### 4. Make the server publicly accessible

The webhook service above needs to reach your server from the internet.

- **Local dev**: `npx ngrok http 3000` — gives you a public URL for testing.
- **Production**: Deploy to [Railway](https://railway.app), [Render](https://render.com), or any VPS. The app runs with `node index.js`.

### 5. Start

```bash
node index.js
```

Or with auto-restart on crash:

```bash
npm install -g pm2
pm2 start index.js --name personal-os
pm2 save && pm2 startup
```

On first start, the database is created and seeded automatically with projects, tasks, and a reading list.

## Manual triggers

Run any job immediately without waiting for its scheduled time:

```bash
node index.js --run-now night-brief
node index.js --run-now morning-plan
node index.js --run-now weekly-review
node index.js --run-now monthly-audit
node index.js --run-now saturday-morning
```

## API

The server exposes a REST API for managing data. Base URL: `http://localhost:3000`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard` | Full system snapshot — projects, scores, today's log, scheduled jobs |
| POST | `/api/tasks` | Add a task `{ title, project_id?, priority?, deadline? }` |
| GET | `/api/books` | List all books |
| PATCH | `/api/books/:id` | Update book status `{ status: 'reading' \| 'done' \| 'unread' }` |
| GET | `/api/ideas` | List captured ideas (`?status=raw\|reviewed\|actioned`) |
| GET | `/api/constraints` | List habit constraints (`?status=active`) |
| POST | `/api/constraints` | Add a constraint `{ title, frequency, expires_at?, description? }` |
| PATCH | `/api/constraints/:id` | Update constraint status or frequency |
| POST | `/api/constraints/:id/complete` | Mark constraint done for today |
| POST | `/api/contacts` | Add a network contact `{ name, context?, met_via?, follow_up_due?, relationship_strength?, project_relevance?, notes? }` |
| GET | `/api/builds` | List all 52 Builds entries |
| POST | `/api/builds` | Add a build `{ title, week_number?, status?, description? }` |
| PATCH | `/api/builds/:id` | Update build `{ status, has_legs, elevated_to, built_at }` |
| PATCH | `/api/events/:id/attend` | Mark event attended `{ contacts_made?, notes? }` |
| GET | `/api/content-ideas` | List content ideas (`?week_of=YYYY-MM-DD`) |
| POST | `/webhook/reply` | Inbound email reply handler — called by your email routing service |

## Reply phrases

Reply to any email to act on it. The system parses natural language.

**Night Brief**
- `done [habit name]` — marks that habit complete for today
- `drop [habit name]` / `retire [habit name]` — retires the habit tracker
- `finished [book title]` — marks the book done, auto-starts the next one
- `yes — [project name]` — elevates a shipped build to a real project
- `no` — archives the shipped build
- Any idea text — AI extracts and logs it to the ideas inbox

**Weekly Review**
- `attend [event name]` — creates an "Attend: [event]" task in Personal Brand project
- `none` — logs missed networking outreach, creates a Monday task to reach out
- `reviewed` — clears the raw ideas inbox
- Any habit description (e.g. "cold shower daily for 2 weeks") — auto-creates a new constraint
- Any build commitment — creates a build entry for the current week

**Monthly Audit**
- `keep / retire / pause / modify [habit name]` — updates constraint status from the routine audit section

## File structure

```
├── index.js          # Entry point — cron scheduler + --run-now CLI
├── server.js         # Express server — API endpoints + webhook handler
├── db.js             # Schema, migrations, seed data, getCurrentBuildWeek()
├── email.js          # Nodemailer transport, HTML shell, reply-tag embedding/parsing
├── morningPlan.js    # 7 AM daily schedule generator
├── nightBrief.js     # 9 PM task brief + constraint maintenance
├── weeklyReview.js   # Friday review + event discovery + networking cadence
├── monthlyAudit.js   # Last-Friday audit + project scoring + routine review
├── buildWeek.js      # Saturday combined email — 52 Builds + content ideas
├── contentIdeas.js   # Content idea generation (called from buildWeek.js)
├── dashboard.html    # Web dashboard (served at GET /)
├── .env.example      # Environment variable template
└── personal_os.db    # SQLite database (created on first run, gitignored)
```

