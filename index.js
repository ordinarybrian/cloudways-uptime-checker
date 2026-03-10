import "dotenv/config";
import fetch from "node-fetch";

// --- Configuration ---
const CLOUDWAYS_API_BASE = "https://api.cloudways.com/api/v1";
const CLOUDWAYS_EMAIL = process.env.CLOUDWAYS_EMAIL;
const CLOUDWAYS_API_KEY = process.env.CLOUDWAYS_API_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// --- Cloudways Auth: Get Bearer Token ---
async function getAuthToken() {
  const res = await fetch(`${CLOUDWAYS_API_BASE}/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: CLOUDWAYS_EMAIL,
      api_key: CLOUDWAYS_API_KEY,
    }),
  });

  if (!res.ok) {
    throw new Error(`Cloudways auth failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.access_token;
}

// --- Get all servers and their apps ---
async function getServersAndApps(token) {
  const res = await fetch(`${CLOUDWAYS_API_BASE}/server`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch servers: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.servers; // array of server objects, each with an `apps` array
}

// --- Extract primary CNAME domain for each app ---
function extractDomains(servers) {
  const domains = [];

  for (const server of servers) {
    for (const app of server.apps ?? []) {
      // Cloudways stores the primary CNAME under app.cname or app.application.cname
      const cname = app.cname ?? app.application?.cname;
      if (cname) {
        domains.push({
          serverLabel: server.label,
          appLabel: app.label,
          domain: cname,
        });
      }
    }
  }

  return domains;
}

// --- Check if a domain responds with HTTP 200 ---
async function checkDomain({ serverLabel, appLabel, domain }) {
  const url = `https://${domain}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      // Abort if no response within 10 seconds
      signal: AbortSignal.timeout(10_000),
    });

    return { serverLabel, appLabel, domain, status: res.status, ok: res.ok };
  } catch (err) {
    return {
      serverLabel,
      appLabel,
      domain,
      status: null,
      ok: false,
      error: err.message,
    };
  }
}

// --- Send a Slack alert ---
async function sendSlackAlert(failures) {
  if (!SLACK_WEBHOOK_URL) {
    console.warn("No SLACK_WEBHOOK_URL set — skipping Slack notification.");
    return;
  }

  const lines = failures.map(
    ({ serverLabel, appLabel, domain, status, error }) => {
      const statusText = status ? `HTTP ${status}` : `Error: ${error}`;
      return `• *${appLabel}* (${serverLabel}) — \`${domain}\` — ${statusText}`;
    },
  );

  const payload = {
    text: `:rotating_light: *Uptime Alert* — ${failures.length} site(s) are down:\n${lines.join("\n")}`,
  };

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error(`Slack notification failed: ${res.status} ${res.statusText}`);
  } else {
    console.log("Slack alert sent.");
  }
}

// --- Main ---
async function main() {
  console.log("Starting uptime check...");

  const token = await getAuthToken();
  console.log("Authenticated with Cloudways.");

  const servers = await getServersAndApps(token);
  console.log(`Found ${servers.length} server(s).`);

  const domainEntries = extractDomains(servers);
  console.log(`Found ${domainEntries.length} app domain(s) to check.`);

  // Check all domains in parallel
  const results = await Promise.all(domainEntries.map(checkDomain));

  // Report results
  for (const r of results) {
    const statusText = r.status ? `HTTP ${r.status}` : `Error: ${r.error}`;
    const icon = r.ok ? "✅" : "❌";
    console.log(`${icon} ${r.domain} — ${statusText}`);
  }

  const failures = results.filter((r) => !r.ok);

  if (failures.length === 0) {
    console.log("All sites are up!");
  } else {
    console.log(`${failures.length} site(s) are down. Sending Slack alert...`);
    await sendSlackAlert(failures);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
