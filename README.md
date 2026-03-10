# Cloudways Uptime Checker

A lightweight Node.js script that monitors all apps on your Cloudways account and sends a Slack alert if any site goes down.

## How it works

1. Authenticates with the Cloudways API
2. Fetches all servers and their apps
3. Extracts the primary domain for each app
4. Sends an HTTP request to each domain
5. Alerts a Slack channel if any site returns a non-200 response or fails SSL verification

## Requirements

- Node.js 18+
- A Cloudways account with API access
- A Slack incoming webhook URL

## Setup

### 1. Clone the repo and install dependencies

```bash
git clone https://github.com/yourusername/uptime-checker.git
cd uptime-checker
npm install
```

### 2. Create a `.env` file

```bash
cp .env.example .env
```

Then fill in your values:

```
CLOUDWAYS_EMAIL=you@example.com
CLOUDWAYS_API_KEY=your_api_key
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

- **Cloudways API key** — found under Account → API in the Cloudways dashboard
- **Slack webhook** — create one at [api.slack.com/apps](https://api.slack.com/apps) under Incoming Webhooks

### 3. Run manually to test

```bash
node index.js
```

You should see output like:

```
Starting uptime check...
Authenticated with Cloudways.
Found 3 server(s).
Found 12 app domain(s) to check.
✅ example.com — HTTP 200
✅ another-site.com — HTTP 200
All sites are up!
```

## Automated Monitoring with Cron (macOS / Linux)

### 1. Find your Node.js path

```bash
which node
```

### 2. Open your crontab

```bash
crontab -e
```

### 3. Add a cron job

```
*/5 * * * * cd /path/to/uptime-checker && export $(cat .env | xargs) && /path/to/node index.js >> /tmp/uptime-checker.log 2>&1
```

Replace `/path/to/uptime-checker` with your project folder and `/path/to/node` with the output of `which node`.

### 4. Monitor the log

```bash
tail -f /tmp/uptime-checker.log
```

**Common cron intervals:**

| Expression | Frequency |
|---|---|
| `*/5 * * * *` | Every 5 minutes |
| `*/15 * * * *` | Every 15 minutes |
| `*/30 * * * *` | Every 30 minutes |
| `0 * * * *` | Every hour |

> **Note for macOS users:** Cron won't fire while your Mac is asleep. For always-on monitoring, consider running this on a Linux VPS instead.

## Slack Alerts

When a site is down, you'll receive a message like:

> 🚨 **Uptime Alert** — 1 site(s) are down:
> • **my-app** (my-server) — `example.com` — HTTP 503

## `.env.example`

```
CLOUDWAYS_EMAIL=
CLOUDWAYS_API_KEY=
SLACK_WEBHOOK_URL=
```

## .gitignore

Make sure your `.env` file is never committed:

```
.env
node_modules/
```