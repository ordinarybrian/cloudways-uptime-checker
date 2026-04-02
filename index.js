import "dotenv/config";
import fetch from "node-fetch";
import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Configuration ---
const CLOUDWAYS_API_BASE = "https://api.cloudways.com/api/v1";
const CLOUDWAYS_EMAIL = process.env.CLOUDWAYS_EMAIL;
const CLOUDWAYS_API_KEY = process.env.CLOUDWAYS_API_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const MUTED_PROJECT_IDS = (process.env.MUTED_PROJECT_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const DB_PATH = join(__dirname, "uptime.db");

// --- Database setup ---
function initDb() {
  const db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS checks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      domain       TEXT NOT NULL,
      app_label    TEXT NOT NULL,
      server_label TEXT NOT NULL,
      timestamp    TEXT NOT NULL,
      ok           INTEGER NOT NULL,
      status_code  INTEGER,
      error        TEXT
    );

    CREATE TABLE IF NOT EXISTS outages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      domain       TEXT NOT NULL,
      app_label    TEXT NOT NULL,
      server_label TEXT NOT NULL,
      timestamp    TEXT NOT NULL,
      all_errors   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_checks_domain_timestamp
      ON checks (domain, timestamp);
  `);

  return db;
}

// --- Prune old data ---
function pruneOldData(db) {
  const checksDeleted = db
    .prepare(
      `DELETE FROM checks WHERE timestamp < datetime('now', '-6 months')`,
    )
    .run();
  const outagesDeleted = db
    .prepare(
      `DELETE FROM outages WHERE timestamp < datetime('now', '-30 days')`,
    )
    .run();

  if (checksDeleted.changes > 0 || outagesDeleted.changes > 0) {
    console.log(
      `🗑️  Pruned ${checksDeleted.changes} old check(s) and ${outagesDeleted.changes} old outage(s).`,
    );
  }
}

// --- Save check results ---
function saveChecks(db, results) {
  const insert = db.prepare(`
    INSERT INTO checks (domain, app_label, server_label, timestamp, ok, status_code, error)
    VALUES (@domain, @app_label, @server_label, @timestamp, @ok, @status_code, @error)
  `);

  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run(row);
  });

  const timestamp = new Date().toISOString();
  insertMany(
    results.map((r) => ({
      domain: r.domain,
      app_label: r.appLabel,
      server_label: r.serverLabel,
      timestamp,
      ok: r.ok ? 1 : 0,
      status_code: r.status ?? null,
      error: r.error ?? null,
    })),
  );
}

// --- Save a confirmed outage ---
function saveOutage(db, failure) {
  const allErrors = failure.allErrors
    ? failure.allErrors.join(" | ")
    : (failure.error ?? `HTTP ${failure.status}`);

  db.prepare(
    `
    INSERT INTO outages (domain, app_label, server_label, timestamp, all_errors)
    VALUES (@domain, @app_label, @server_label, @timestamp, @all_errors)
  `,
  ).run({
    domain: failure.domain,
    app_label: failure.appLabel,
    server_label: failure.serverLabel,
    timestamp: new Date().toISOString(),
    all_errors: allErrors,
  });
}

// --- Calculate and log uptime summary ---
function logUptimeSummary(db) {
  const windows = [
    { label: "24 hours", interval: "-1 day" },
    { label: "7 days", interval: "-7 days" },
    { label: "30 days", interval: "-30 days" },
    { label: "6 months", interval: "-6 months" },
    { label: "all time", interval: null },
  ];

  const domains = db
    .prepare(`SELECT DISTINCT domain, app_label FROM checks ORDER BY domain`)
    .all();

  if (domains.length === 0) return;

  console.log("\n📊 Uptime Summary:");

  for (const { domain, app_label } of domains) {
    console.log(`\n  ${app_label} (${domain})`);

    for (const { label, interval } of windows) {
      const query = interval
        ? `SELECT COUNT(*) as total, SUM(ok) as successful FROM checks
           WHERE domain = ? AND timestamp > datetime('now', '${interval}')`
        : `SELECT COUNT(*) as total, SUM(ok) as successful FROM checks
           WHERE domain = ?`;

      const row = db.prepare(query).get(domain);

      if (!row.total) {
        console.log(`    ${label.padEnd(10)}: no data`);
      } else {
        const pct = ((row.successful / row.total) * 100).toFixed(2);
        console.log(
          `    ${label.padEnd(10)}: ${pct}% (${row.successful}/${row.total} checks)`,
        );
      }
    }
  }

  // Overall uptime across all domains
  console.log("\n  Overall (all domains)");
  for (const { label, interval } of windows) {
    const query = interval
      ? `SELECT COUNT(*) as total, SUM(ok) as successful FROM checks
         WHERE timestamp > datetime('now', '${interval}')`
      : `SELECT COUNT(*) as total, SUM(ok) as successful FROM checks`;

    const row = db.prepare(query).get();

    if (!row.total) {
      console.log(`    ${label.padEnd(10)}: no data`);
    } else {
      const pct = ((row.successful / row.total) * 100).toFixed(2);
      console.log(
        `    ${label.padEnd(10)}: ${pct}% (${row.successful}/${row.total} checks)`,
      );
    }
  }

  console.log("");
}

// --- Cloudways Auth: Get Bearer Token ---
async function getAuthToken() {
  const params = new URLSearchParams({
    email: CLOUDWAYS_EMAIL,
    api_key: CLOUDWAYS_API_KEY,
  });

  const res = await fetch(
    `${CLOUDWAYS_API_BASE}/oauth/access_token?${params}`,
    {
      method: "POST",
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Cloudways auth failed: ${res.status} ${res.statusText} — ${body}`,
    );
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
  return data.servers;
}

// --- Extract primary CNAME domain for each app ---
function extractDomains(servers) {
  const domains = [];

  for (const server of servers) {
    for (const app of server.apps ?? []) {
      if (MUTED_PROJECT_IDS.includes(app.project_id)) {
        console.log(
          `  🔇  ${app.label} is muted (project ${app.project_id}), skipping.`,
        );
        continue;
      }
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

// --- Single request attempt ---
async function attemptRequest(url) {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, ok: res.ok, error: null };
}

// --- Check a domain with up to 3 attempts, each 5s apart.
//     - Alerts immediately if attempts 1+2 fail with the same error/status.
//     - If attempt 2 differs, tries a 3rd time and alerts regardless of error type. ---
async function checkDomain({ serverLabel, appLabel, domain }) {
  const url = `https://${domain}`;
  const attempts = [];

  for (let i = 0; i < 3; i++) {
    if (i > 0) {
      const prev = attempts[i - 1];
      console.log(
        `  ⚠️  ${domain} failed (${prev.error ?? `HTTP ${prev.status}`}), retrying in 5s... (attempt ${i + 1}/3)`,
      );
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }

    try {
      attempts.push(await attemptRequest(url));
    } catch (err) {
      attempts.push({ status: null, ok: false, error: err.message });
    }

    const current = attempts[i];

    // Success at any point — done
    if (current.ok) {
      return { serverLabel, appLabel, domain, ...current };
    }

    // After attempt 2: alert if errors are identical, otherwise try a 3rd time
    if (i === 1) {
      const prev = attempts[0];
      const sameError =
        prev.error && current.error && prev.error === current.error;
      const sameStatus =
        prev.status && current.status && prev.status === current.status;

      if (sameError || sameStatus) {
        return {
          serverLabel,
          appLabel,
          domain,
          ...current,
          allErrors: attempts.map((a) => a.error ?? `HTTP ${a.status}`),
        };
      }

      console.log(
        `  ↩️  ${domain} — inconsistent failures on attempts 1+2, trying once more...`,
      );
    }
  }

  // All 3 attempts failed — alert regardless of error consistency
  return {
    serverLabel,
    appLabel,
    domain,
    ...attempts[2],
    allErrors: attempts.map((a) => a.error ?? `HTTP ${a.status}`),
  };
}

// --- Send a Slack alert ---
async function sendSlackAlert(failures) {
  if (!SLACK_WEBHOOK_URL) {
    console.warn("No SLACK_WEBHOOK_URL set — skipping Slack notification.");
    return;
  }

  const lines = failures.map(
    ({ serverLabel, appLabel, domain, status, error, allErrors }) => {
      let statusText;
      if (allErrors?.length) {
        statusText = allErrors
          .map((e, i) => `Attempt ${i + 1}: ${e}`)
          .join(" | ");
      } else {
        statusText = status ? `HTTP ${status}` : `Error: ${error}`;
      }
      return `• *${appLabel}* (${serverLabel}) — \`${domain}\`\n  ${statusText}`;
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

  const db = initDb();
  pruneOldData(db);

  const token = await getAuthToken();
  console.log("Authenticated with Cloudways.");

  const servers = await getServersAndApps(token);
  console.log(`Found ${servers.length} server(s).`);

  const domainEntries = extractDomains(servers);
  console.log(`Found ${domainEntries.length} app domain(s) to check.`);

  // Check all domains in parallel
  const results = await Promise.all(domainEntries.map(checkDomain));

  // Save all check results to the database
  saveChecks(db, results);

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
    for (const failure of failures) {
      saveOutage(db, failure);
    }
    await sendSlackAlert(failures);
  }

  // Print uptime summary
  logUptimeSummary(db);

  db.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
