/**
 * Blox Fruits Server Scanner
 * - Runs every 171 seconds inside a GitHub Actions loop job.
 * - Tracks servers for up to 4 hours, then drops them.
 * - Sends a Discord alert 5 min before each event, then EDITS that
 *   same message every scan cycle so the countdown stays live.
 * - Fires a separate "EVENT NOW" message the moment time hits 0.
 * - Each event posts to its own webhook / channel.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname   = dirname(fileURLToPath(import.meta.url));
const ROOT        = join(__dirname, "..");
const DATA_DIR    = join(ROOT, "data");
const STATE_FILE  = join(DATA_DIR, "state.json");
const SERVERS_FILE = join(DATA_DIR, "servers.json");

const PLACE_ID = 2753915549;

// Drop servers older than 4 hours
const MAX_TRACK_AGE_SEC = 14400;

// Send first ping when this many seconds remain
const ALERT_THRESHOLD_SEC = 300;   // 5 minutes

// ── Event definitions ──────────────────────────────────────────────────────
const EVENTS = {
  PirateRaid: {
    label:      "⚔️ Pirate / Castle Raid",
    emoji:      "⚔️",
    sea:        "Sea 3",
    color:      0xDC3C3C,
    offset:     0,
    interval:   4500,     // 75 min
    webhookEnv: "DISCORD_WEBHOOK_PIRATE_RAID",
  },
  FactoryRaid: {
    label:      "🏭 Factory Raid",
    emoji:      "🏭",
    sea:        "Sea 2",
    color:      0xDC8232,
    offset:     0,
    interval:   5400,     // 90 min
    webhookEnv: "DISCORD_WEBHOOK_FACTORY_RAID",
  },
  FruitSpawn: {
    label:      "🍎 Fruit Spawn",
    emoji:      "🍎",
    sea:        "All Seas",
    color:      0x32BE50,
    offset:     0,
    interval:   () => {
      const day = new Date().getUTCDay();
      return (day === 0 || day === 6) ? 2700 : 3600; // 45 min weekends / 60 min weekdays
    },
    webhookEnv: "DISCORD_WEBHOOK_FRUIT_SPAWN",
  },
  LegendarySword: {
    label:      "🗡️ Legendary Sword Dealer",
    emoji:      "🗡️",
    sea:        "Sea 2",
    color:      0x3C82DC,
    offset:     14400,    // first at ~4 hr
    interval:   14400,
    webhookEnv: "DISCORD_WEBHOOK_LEGENDARY_SWORD",
  },
  FistOfDarkness: {
    label:      "✊ Fist of Darkness",
    emoji:      "✊",
    sea:        "Sea 2",
    color:      0x8C3CDB,
    offset:     14400,
    interval:   14400,
    webhookEnv: "DISCORD_WEBHOOK_FIST_DARKNESS",
  },
  GodChalice: {
    label:      "🏆 God Chalice",
    emoji:      "🏆",
    sea:        "Sea 3",
    color:      0xDCB932,
    offset:     14400,
    interval:   14400,
    webhookEnv: "DISCORD_WEBHOOK_GOD_CHALICE",
  },
};

// Scan config
const MAX_PAGES     = 6;
const PAGE_DELAY_MS = 2000;
const TOP_N         = 15;

// ── State helpers ──────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { isFirstScan: true, servers: {}, lastScanAt: null, alertedJobs: {}, liveMessages: {} };
  }
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    s.alertedJobs   ??= {};
    s.liveMessages  ??= {};
    return s;
  } catch {
    console.warn("state.json unreadable — starting fresh");
    return { isFirstScan: true, servers: {}, lastScanAt: null, alertedJobs: {}, liveMessages: {} };
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
  return new Promise(r => setTimeout(r, ms));
}

// ── Roblox API ─────────────────────────────────────────────────────────────

async function fetchPage(cursor, pageNum) {
  let url = `https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public?limit=100`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

  console.log(`  Fetching page ${pageNum}…`);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept":     "application/json",
    },
  });

  if (res.status === 429) {
    console.warn(`  Rate-limited on page ${pageNum}.`);
    return { servers: [], nextCursor: null, rateLimited: true };
  }
  if (!res.ok) {
    throw new Error(`Roblox API ${res.status} on page ${pageNum}`);
  }

  const data = await res.json();
  const servers = (data.data ?? []).map(s => ({
    id:      s.id,
    playing: s.playing ?? 0,
    fps:     s.fps     ?? 60,
  }));

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
  if (age < offset) return Math.round(offset - age);
  return Math.round(interval - ((age - offset) % interval));
}

function buildEventResults(state, nowSec) {
  const results = {};

  for (const [key, cfg] of Object.entries(EVENTS)) {
    const interval = typeof cfg.interval === "function" ? cfg.interval() : cfg.interval;
    const list = [];

    for (const [jobId, entry] of Object.entries(state.servers)) {
      if (entry.status !== "tracked" || entry.firstSeen == null) continue;
      if ((entry.fps ?? 60) < 20) continue;

      const age            = nowSec - entry.firstSeen;
      const timeUntilEvent = calcTimeUntilEvent(age, cfg.offset, interval);

      list.push({
        jobId,
        timeUntilEvent,
        estimatedAge: Math.round(age),
        playing:      entry.playing ?? 0,
        fps:          Math.round((entry.fps ?? 60) * 10) / 10,
      });
    }

    list.sort((a, b) => a.timeUntilEvent - b.timeUntilEvent);
    results[key] = list.slice(0, TOP_N);
  }

  return results;
}

// ── Discord helpers ─────────────────────────────────────────────────────────

/**
 * Parse a Discord webhook URL into { id, token, base }
 * URL shape: https://discord.com/api/webhooks/{id}/{token}
 */
function parseWebhook(url) {
  const parts = url.replace(/\/$/, "").split("/");
  const token = parts.pop();
  const id    = parts.pop();
  return { id, token, base: `https://discord.com/api/webhooks/${id}/${token}` };
}

function fmtCountdown(sec) {
  if (sec <= 0) return "**NOW!** 🚨";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `**${m}m ${String(s).padStart(2,"0")}s**`;
}

function buildAlertEmbed(cfg, servers, nowSec) {
  const topServers = servers.slice(0, 5);
  const lowestTime = topServers[0]?.timeUntilEvent ?? 0;

  const fields = topServers.map((s, i) => ({
    name:   `Server ${i + 1}`,
    value:  [
      `\`\`${s.jobId}\`\``,
      `⏱ ${fmtCountdown(s.timeUntilEvent)}  |  👥 ${s.playing} players  |  🕐 age ${Math.round(s.estimatedAge / 60)}m`,
    ].join("\n"),
    inline: false,
  }));

  return {
    title:       `${cfg.emoji}  ${cfg.label}`,
    description: `**${cfg.sea}** — event in ${fmtCountdown(lowestTime)}\n${servers.length} server${servers.length !== 1 ? "s" : ""} tracked`,
    color:       cfg.color,
    fields,
    footer: { text: `Blox Fruits Tracker  •  Updated ${new Date(nowSec * 1000).toUTCString()}` },
    timestamp: new Date(nowSec * 1000).toISOString(),
  };
}

/** POST a new webhook message; returns message id or null */
async function sendWebhookMessage(webhookUrl, payload) {
  const { base } = parseWebhook(webhookUrl);
  try {
    const res = await fetch(`${base}?wait=true`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.warn(`  Discord POST ${res.status}: ${txt.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    return data.id ?? null;
  } catch (err) {
    console.warn(`  Discord POST failed: ${err.message}`);
    return null;
  }
}

/** PATCH (edit) an existing webhook message */
async function editWebhookMessage(webhookUrl, messageId, payload) {
  const { base } = parseWebhook(webhookUrl);
  try {
    const res = await fetch(`${base}/messages/${messageId}`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.warn(`  Discord PATCH ${res.status}: ${txt.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`  Discord PATCH failed: ${err.message}`);
    return false;
  }
}

/** DELETE a webhook message (used after "NOW" fires) */
async function deleteWebhookMessage(webhookUrl, messageId) {
  const { base } = parseWebhook(webhookUrl);
  try {
    await fetch(`${base}/messages/${messageId}`, { method: "DELETE" });
  } catch { /* ignore */ }
}

// ── Main Discord notification logic ────────────────────────────────────────

async function handleDiscordNotifications(eventKey, cfg, servers, state, nowSec) {
  const webhookUrl = process.env[cfg.webhookEnv];
  if (!webhookUrl) return;   // secret not configured — skip silently

  const alerted      = state.alertedJobs;
  const liveMessages = state.liveMessages;

  // Servers whose countdown is within alert threshold and are actually tracked
  const alertable = servers.filter(s => s.timeUntilEvent <= ALERT_THRESHOLD_SEC);

  // ── 1. Edit existing live messages with updated countdown ──────────────
  for (const [msgKey, msgData] of Object.entries(liveMessages)) {
    if (!msgKey.startsWith(eventKey + ":")) continue;
    const jobId  = msgKey.slice(eventKey.length + 1);
    const server = servers.find(s => s.jobId === jobId);

    if (!server || server.timeUntilEvent > ALERT_THRESHOLD_SEC + 300) {
      // Server gone or event just rolled over — clean up message
      await deleteWebhookMessage(webhookUrl, msgData.messageId);
      delete liveMessages[msgKey];
      delete alerted[msgKey];
      console.log(`  Discord [${eventKey}]: cleaned up message for ${jobId}`);
      continue;
    }

    if (server.timeUntilEvent <= 10) {
      // ── Event is NOW — fire a loud ping then clean up ──────────────────
      const nowPayload = {
        content: `@everyone 🚨 **${cfg.label}** is happening **RIGHT NOW** in ${cfg.sea}!\n\`${server.jobId}\` | ${server.playing} players`,
        embeds:  [{
          title:       `🚨  ${cfg.label}  —  NOW!`,
          description: `Join immediately — event is starting in **${cfg.sea}**!`,
          color:       0xFF0000,
          fields: [{
            name:  "Server ID",
            value: `\`\`${server.jobId}\`\``,
          }],
          timestamp: new Date().toISOString(),
        }],
      };
      await editWebhookMessage(webhookUrl, msgData.messageId, nowPayload);
      delete liveMessages[msgKey];
      // Don't delete alerted key so we don't re-alert the same cycle
      console.log(`  Discord [${eventKey}]: fired NOW alert for ${jobId}`);
      continue;
    }

    // ── Still counting down — update the embed ─────────────────────────
    const embed   = buildAlertEmbed(cfg, [server], nowSec);
    const updated = await editWebhookMessage(webhookUrl, msgData.messageId, { embeds: [embed] });
    if (updated) {
      console.log(`  Discord [${eventKey}]: updated countdown → ${fmtCountdown(server.timeUntilEvent)} for ${jobId}`);
    }
  }

  // ── 2. Send new alerts for servers just entering the threshold ─────────
  for (const server of alertable) {
    const alertKey = `${eventKey}:${server.jobId}`;
    if (alerted[alertKey] || liveMessages[alertKey]) continue;  // already alerted

    const embed   = buildAlertEmbed(cfg, [server], nowSec);
    const content = `@everyone ${cfg.emoji}  **${cfg.label}** in ${fmtCountdown(server.timeUntilEvent)} — ${cfg.sea}!`;

    const messageId = await sendWebhookMessage(webhookUrl, { content, embeds: [embed] });

    if (messageId) {
      liveMessages[alertKey] = { messageId, sentAt: nowSec };
      alerted[alertKey]      = true;
      console.log(`  Discord [${eventKey}]: sent alert for ${server.jobId} (msg ${messageId})`);
    }
  }
}

// Clean up alerted/liveMessage entries for servers no longer tracked
function pruneAlertedJobs(state) {
  for (const key of Object.keys(state.alertedJobs)) {
    const jobId = key.split(":")[1];
    if (!state.servers[jobId]) delete state.alertedJobs[key];
  }
  for (const key of Object.keys(state.liveMessages)) {
    const jobId = key.split(":")[1];
    if (!state.servers[jobId]) delete state.liveMessages[key];
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Blox Fruits Scanner ===");
  console.log(`Time: ${new Date().toISOString()}`);

  const state   = loadState();
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

  const nowSec  = Date.now() / 1000;
  const nowIso  = new Date().toISOString();
  const seenIds = new Set();
  let newCount  = 0, diedCount = 0, agedOut = 0;

  // ── Process live servers ───────────────────────────────────────────────
  for (const s of liveServers) {
    seenIds.add(s.id);
    const existing = state.servers[s.id];

    if (existing) {
      existing.playing = s.playing;
      existing.fps     = s.fps;
    } else if (isFirst) {
      state.servers[s.id] = { firstSeen: null, firstSeenTs: null, status: "unknown", playing: s.playing, fps: s.fps };
    } else {
      state.servers[s.id] = { firstSeen: nowSec, firstSeenTs: nowIso, status: "tracked", playing: s.playing, fps: s.fps };
      newCount++;
    }
  }

  // ── Prune dead and aged-out servers ────────────────────────────────────
  const canPruneDead = liveServers.length >= 100;

  for (const [jobId, entry] of Object.entries(state.servers)) {
    if (canPruneDead && !seenIds.has(jobId)) {
      delete state.servers[jobId];
      diedCount++;
      continue;
    }
    if (entry.status === "tracked" && entry.firstSeen != null) {
      if (nowSec - entry.firstSeen > MAX_TRACK_AGE_SEC) {
        delete state.servers[jobId];
        agedOut++;
      }
    }
  }

  pruneAlertedJobs(state);
  state.lastScanAt = nowIso;

  const totalKnown   = Object.keys(state.servers).length;
  const totalTracked = Object.values(state.servers).filter(e => e.status === "tracked").length;
  const totalUnknown = totalKnown - totalTracked;

  console.log(`+${newCount} new | -${diedCount} dead | -${agedOut} aged out | tracked: ${totalTracked} | unknown: ${totalUnknown}`);

  // ── Build event results ────────────────────────────────────────────────
  const eventResults = buildEventResults(state, nowSec);

  // ── Discord notifications ──────────────────────────────────────────────
  if (!isFirst) {
    const notifyPromises = [];
    for (const [key, cfg] of Object.entries(EVENTS)) {
      if (eventResults[key]?.length > 0) {
        notifyPromises.push(handleDiscordNotifications(key, cfg, eventResults[key], state, nowSec));
      }
    }
    if (notifyPromises.length > 0) await Promise.all(notifyPromises);
  }

  // ── Build public data for the dashboard ────────────────────────────────
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
