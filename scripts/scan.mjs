/**
 * Blox Fruits Server Scanner
 * Runs in a tight loop via GitHub Actions (every 171 seconds).
 * Tracks servers for up to 4 hours, then removes them.
 * Auto-removes dead servers on every full scan.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT        = join(__dirname, "..");
const DATA_DIR    = join(ROOT, "data");
const STATE_FILE  = join(DATA_DIR, "state.json");
const SERVERS_FILE = join(DATA_DIR, "servers.json");

const PLACE_ID = 2753915549;

// Maximum age before a server is dropped from tracking (4 hours)
const MAX_TRACK_AGE_SEC = 14400;

// ── Event definitions ──────────────────────────────────────────────────────
// offset   = seconds after server start until the FIRST occurrence
// interval = seconds between repeating occurrences
// sea      = which sea the event applies to (for display/filtering)
// webhookEnv = environment variable name for the Discord webhook for this event
const EVENTS = {
  PirateRaid: {
    label: "⚔️ Pirate / Castle Raid",
    sea: "Sea 3",
    offset: 0,
    interval: 4500,   // 75 minutes, cycles from server start
    webhookEnv: "DISCORD_WEBHOOK_PIRATE_RAID",
  },
  FactoryRaid: {
    label: "🏭 Factory Raid",
    sea: "Sea 2",
    offset: 0,
    interval: 5400,   // 90 minutes, cycles from server start
    webhookEnv: "DISCORD_WEBHOOK_FACTORY_RAID",
  },
  FruitSpawn: {
    label: "🍎 Fruit Spawn",
    sea: "All seas",
    offset: 0,
    interval: () => {
      const day = new Date().getUTCDay(); // 0 = Sun, 6 = Sat
      return day === 0 || day === 6 ? 2700 : 3600; // 45 min weekends / 60 min weekdays
    },
    webhookEnv: "DISCORD_WEBHOOK_FRUIT_SPAWN",
  },
  LegendarySword: {
    label: "🗡️ Legendary Sword Dealer",
    sea: "Sea 2",
    offset: 14400,    // first spawn at ~4 hours
    interval: 14400,  // repeats every 4 hours
    webhookEnv: "DISCORD_WEBHOOK_LEGENDARY_SWORD",
  },
  FistOfDarkness: {
    label: "✊ Fist of Darkness",
    sea: "Sea 2",
    offset: 14400,    // first appears in random chest at ~4 hours
    interval: 14400,
    webhookEnv: "DISCORD_WEBHOOK_FIST_DARKNESS",
  },
  GodChalice: {
    label: "🏆 God Chalice",
    sea: "Sea 3",
    offset: 14400,    // first appears in random chest at ~4 hours
    interval: 14400,
    webhookEnv: "DISCORD_WEBHOOK_GOD_CHALICE",
  },
};

// How many pages to scan (100 servers per page). 6 pages = up to 600 servers.
const MAX_PAGES     = 6;
const PAGE_DELAY_MS = 2000;
// Top N servers to include per event in the output file
const TOP_N         = 15;

// ── State helpers ──────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { isFirstScan: true, servers: {}, lastScanAt: null };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    console.warn("state.json unreadable — starting fresh");
    return { isFirstScan: true, servers: {}, lastScanAt: null };
  }
}

function saveState(state) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function saveServers(data) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SERVERS_FILE, JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Roblox API ─────────────────────────────────────────────────────────────

async function fetchPage(cursor, pageNum) {
  let url = `https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public?limit=100`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

  console.log(`  Fetching page ${pageNum}…`);

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `https://www.roblox.com/games/${PLACE_ID}/`,
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (res.status === 429) {
    console.log(`  Rate limited on page ${pageNum} — stopping early`);
    return { servers: [], nextCursor: null, rateLimited: true };
  }

  if (!res.ok) {
    throw new Error(`Roblox API returned ${res.status} on page ${pageNum}`);
  }

  const data = await res.json();
  const servers = data.data ?? [];
  console.log(`  Page ${pageNum}: ${servers.length} servers`);
  return { servers, nextCursor: data.nextPageCursor ?? null, rateLimited: false };
}

async function fetchAllServers() {
  const all = [];
  let cursor = null;
  let rateLimited = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchPage(cursor, page + 1);
    all.push(...result.servers);
    if (result.rateLimited) { rateLimited = true; break; }
    if (!result.nextCursor) break;
    await sleep(PAGE_DELAY_MS);
    cursor = result.nextCursor;
  }

  return { servers: all, rateLimited };
}

// ── Event math ─────────────────────────────────────────────────────────────

function calcTimeUntilEvent(age, offset, interval) {
  if (age < offset) {
    return Math.round(offset - age);
  }
  return Math.round(interval - ((age - offset) % interval));
}

function buildEventResults(state, nowSec) {
  const results = {};

  for (const [key, cfg] of Object.entries(EVENTS)) {
    const interval = typeof cfg.interval === "function" ? cfg.interval() : cfg.interval;
    const offset = cfg.offset;
    const list = [];

    for (const [jobId, entry] of Object.entries(state.servers)) {
      if (entry.status !== "tracked" || entry.firstSeen == null) continue;
      if ((entry.fps ?? 60) < 20) continue;

      const age = nowSec - entry.firstSeen;
      const timeUntilEvent = calcTimeUntilEvent(age, offset, interval);

      list.push({
        jobId,
        timeUntilEvent,
        estimatedAge: Math.round(age),
        playing: entry.playing ?? 0,
        fps: Math.round((entry.fps ?? 60) * 10) / 10,
      });
    }

    list.sort((a, b) => a.timeUntilEvent - b.timeUntilEvent);
    results[key] = list.slice(0, TOP_N);
  }

  return results;
}

// ── Discord notification ───────────────────────────────────────────────────

// Track which servers we already alerted on per event (to avoid spam)
// We persist this in state so it survives between scans
function getAlertedKey(eventKey, jobId) {
  return `${eventKey}:${jobId}`;
}

async function sendEventAlert(webhookUrl, eventKey, cfg, servers, state) {
  const alerted = state.alertedJobs ?? (state.alertedJobs = {});
  const toAlert = servers.filter(s => {
    const key = getAlertedKey(eventKey, s.jobId);
    // Alert if within 10 min and not already alerted for this event cycle
    return s.timeUntilEvent <= 600 && !alerted[key];
  });

  if (toAlert.length === 0) return;

  const timeStr = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  });

  const lines = [
    `**${cfg.label}** (${cfg.sea}) — ${timeStr} UTC`,
    `${toAlert.length} server${toAlert.length > 1 ? "s" : ""} within 10 minutes:`,
    "",
  ];

  for (const s of toAlert.slice(0, 5)) {
    const m = Math.floor(s.timeUntilEvent / 60);
    const sec = s.timeUntilEvent % 60;
    lines.push(`\`${s.jobId}\` → **${m}m ${sec}s** | ${s.playing} players | age ${Math.round(s.estimatedAge / 60)}m`);
    // Mark as alerted so we don't spam the same server again this cycle
    alerted[getAlertedKey(eventKey, s.jobId)] = true;
  }

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: lines.join("\n").slice(0, 2000) }),
    });
    console.log(`  Discord [${eventKey}]: alerted ${toAlert.length} server(s)`);
  } catch (err) {
    console.warn(`  Discord [${eventKey}] failed:`, err.message);
  }
}

// Clean up alerted entries for servers that are no longer tracked
function pruneAlertedJobs(state) {
  if (!state.alertedJobs) return;
  for (const key of Object.keys(state.alertedJobs)) {
    const jobId = key.split(":")[1];
    if (!state.servers[jobId]) {
      delete state.alertedJobs[key];
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Blox Fruits Scanner ===");
  console.log(`Time: ${new Date().toISOString()}`);

  const state = loadState();
  const isFirst = state.isFirstScan;
  state.isFirstScan = false;

  if (isFirst) {
    console.log("First scan — building baseline. All current servers marked as unknown age.");
  } else {
    console.log(`Scanning (${Object.keys(state.servers).length} servers in state)`);
  }

  console.log("Fetching server list from Roblox…");

  let liveServers, rateLimited;
  try {
    ({ servers: liveServers, rateLimited } = await fetchAllServers());
  } catch (err) {
    console.error("Fetch failed:", err.message);
    process.exit(1);
  }

  console.log(`Total fetched: ${liveServers.length} servers${rateLimited ? " (rate-limited)" : ""}`);

  const nowSec   = Date.now() / 1000;
  const nowIso   = new Date().toISOString();
  const seenIds  = new Set();
  let newCount   = 0;
  let diedCount  = 0;
  let agedOut    = 0;

  // ── Process live servers ──
  for (const s of liveServers) {
    seenIds.add(s.id);
    const existing = state.servers[s.id];

    if (existing) {
      // Update live stats
      existing.playing = s.playing;
      existing.fps     = s.fps;
    } else if (isFirst) {
      // First scan — just record as unknown age (baseline)
      state.servers[s.id] = {
        firstSeen:   null,
        firstSeenTs: null,
        status:      "unknown",
        playing:     s.playing,
        fps:         s.fps,
      };
    } else {
      // New server discovered after baseline — start tracking
      state.servers[s.id] = {
        firstSeen:   nowSec,
        firstSeenTs: nowIso,
        status:      "tracked",
        playing:     s.playing,
        fps:         s.fps,
      };
      newCount++;
    }
  }

  // ── Remove dead and aged-out servers ──
  // Only prune dead servers when we got a reasonably full scan (not rate-limited early)
  const canPruneDead = liveServers.length >= 100;

  for (const [jobId, entry] of Object.entries(state.servers)) {
    // Server died (no longer in API response)
    if (canPruneDead && !seenIds.has(jobId)) {
      delete state.servers[jobId];
      diedCount++;
      continue;
    }

    // Server has been tracked for 4+ hours — all events have completed, drop it
    if (entry.status === "tracked" && entry.firstSeen != null) {
      const age = nowSec - entry.firstSeen;
      if (age > MAX_TRACK_AGE_SEC) {
        delete state.servers[jobId];
        agedOut++;
      }
    }
  }

  // Clean up alert state for removed servers
  pruneAlertedJobs(state);

  state.lastScanAt = nowIso;

  const totalKnown   = Object.keys(state.servers).length;
  const totalTracked = Object.values(state.servers).filter(e => e.status === "tracked").length;
  const totalUnknown = totalKnown - totalTracked;

  console.log(
    `+${newCount} new | -${diedCount} dead | -${agedOut} aged out | tracked: ${totalTracked} | unknown: ${totalUnknown}`
  );

  // ── Build event results ──
  const eventResults = buildEventResults(state, nowSec);

  // ── Discord notifications (per-event webhooks) ──
  if (!isFirst) {
    const notifyPromises = [];
    for (const [key, cfg] of Object.entries(EVENTS)) {
      const webhookUrl = process.env[cfg.webhookEnv];
      if (webhookUrl && eventResults[key]?.length > 0) {
        notifyPromises.push(sendEventAlert(webhookUrl, key, cfg, eventResults[key], state));
      }
    }
    if (notifyPromises.length > 0) {
      await Promise.all(notifyPromises);
    }
  }

  // ── Build event metadata for the frontend ──
  const eventMeta = {};
  for (const [key, cfg] of Object.entries(EVENTS)) {
    eventMeta[key] = { label: cfg.label, sea: cfg.sea };
  }

  const publicData = {
    updatedAt:    nowIso,
    totalKnown,
    totalTracked,
    totalUnknown,
    newThisScan:  newCount,
    diedThisScan: diedCount,
    eventMeta,
    events:       eventResults,
  };

  saveState(state);
  saveServers(publicData);

  console.log("Done. state.json and servers.json saved.");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
