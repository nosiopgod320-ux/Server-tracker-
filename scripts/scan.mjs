/**
 * Blox Fruits Server Scanner — v3
 *
 * Key design:
 *  - No baseline delay — all servers tracked from scan 1.
 *  - Scans 10 pages (up to 1000 servers) per cycle.
 *  - Workflow calls this every 60 seconds.
 *  - Alerts when event is ≤10 min away, one Discord message per server.
 *  - Edits that message every scan cycle with live countdown.
 *  - Fires @everyone "NOW" ping when ≤15 seconds remain.
 *  - Heartbeat log message every scan.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname    = dirname(fileURLToPath(import.meta.url));
const ROOT         = join(__dirname, "..");
const DATA_DIR     = join(ROOT, "data");
const STATE_FILE   = join(DATA_DIR, "state.json");
const SERVERS_FILE = join(DATA_DIR, "servers.json");

const PLACE_ID            = 2753915549;
const MAX_TRACK_AGE_SEC   = 14400;   // drop servers older than 4 h
const ALERT_THRESHOLD_SEC = 600;     // alert when ≤10 min to event
const MAX_PAGES           = 8;       // 8 × 100 = up to 800 servers
const PAGE_DELAY_MS       = 2500;    // slower = fewer rate limits
const TOP_N               = 50;      // servers stored per event
// Only prune dead servers when scan was nearly complete (not rate-limited mid-way)
const MIN_FOR_PRUNE       = 600;     // need ≥600 servers fetched to trust dead pruning

// ── Event definitions ──────────────────────────────────────────────────────
const EVENTS = {
  PirateRaid: {
    label:      "⚔️ Pirate / Castle Raid",
    emoji:      "⚔️",
    sea:        "Sea 3",
    color:      0xDC3C3C,
    offset:     0,
    interval:   4500,      // 75 min
    webhookEnv: "DISCORD_WEBHOOK_PIRATE_RAID",
  },
  FactoryRaid: {
    label:      "🏭 Factory Raid",
    emoji:      "🏭",
    sea:        "Sea 2",
    color:      0xDC8232,
    offset:     0,
    interval:   5400,      // 90 min
    webhookEnv: "DISCORD_WEBHOOK_FACTORY_RAID",
  },
  FruitSpawnSea1: {
    label:      "🍎 Fruit Spawn (Sea 1)",
    emoji:      "🍎",
    sea:        "Sea 1",
    color:      0x32BE50,
    offset:     0,
    interval:   () => isWeekend() ? 2700 : 3600,
    webhookEnv: "DISCORD_WEBHOOK_FRUIT_SPAWN",
  },
  FruitSpawnSea2: {
    label:      "🍎 Fruit Spawn (Sea 2)",
    emoji:      "🍎",
    sea:        "Sea 2",
    color:      0x28A844,
    offset:     0,
    interval:   () => isWeekend() ? 2700 : 3600,
    webhookEnv: "DISCORD_WEBHOOK_FRUIT_SPAWN",
  },
  FruitSpawnSea3: {
    label:      "🍎 Fruit Spawn (Sea 3)",
    emoji:      "🍎",
    sea:        "Sea 3",
    color:      0x1E8A38,
    offset:     0,
    interval:   () => isWeekend() ? 2700 : 3600,
    webhookEnv: "DISCORD_WEBHOOK_FRUIT_SPAWN",
  },
  LegendarySword: {
    label:      "🗡️ Legendary Sword Dealer",
    emoji:      "🗡️",
    sea:        "Sea 2",
    color:      0x3C82DC,
    offset:     14400,
    interval:   14400,     // 4 h
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

function isWeekend() {
  const d = new Date().getUTCDay();
  return d === 0 || d === 6;
}

// ── State ──────────────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { servers: {}, lastScanAt: null, alertedJobs: {}, liveMessages: {} };
  }
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    s.alertedJobs  ??= {};
    s.liveMessages ??= {};
    return s;
  } catch {
    return { servers: {}, lastScanAt: null, alertedJobs: {}, liveMessages: {} };
  }
}

function saveState(s) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function saveServers(d) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SERVERS_FILE, JSON.stringify(d, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Roblox API ─────────────────────────────────────────────────────────────

async function fetchPage(cursor, pageNum) {
  let url = `https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public?limit=100&sortOrder=Asc`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

  console.log(`  Page ${pageNum}…`);
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
  });

  if (res.status === 429) {
    console.warn("  Rate-limited.");
    return { servers: [], nextCursor: null, rateLimited: true };
  }
  if (!res.ok) throw new Error(`Roblox API ${res.status}`);

  const data = await res.json();
  const servers = (data.data ?? []).map(s => ({
    id:         s.id,
    playing:    typeof s.playing  === "number" ? s.playing  : 0,
    maxPlayers: typeof s.maxPlayers === "number" ? s.maxPlayers : 0,
    fps:        typeof s.fps      === "number" ? s.fps      : 60,
  }));

  console.log(`  Page ${pageNum}: ${servers.length} servers`);
  return { servers, nextCursor: data.nextPageCursor ?? null, rateLimited: false };
}

async function fetchAllServers() {
  const all = [];
  let cursor = null;
  let rateLimited = false;

  for (let p = 0; p < MAX_PAGES; p++) {
    const r = await fetchPage(cursor, p + 1);
    all.push(...r.servers);
    if (r.rateLimited) { rateLimited = true; break; }
    if (!r.nextCursor) break;
    await sleep(PAGE_DELAY_MS);
    cursor = r.nextCursor;
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
      if (entry.firstSeen == null) continue;
      if ((entry.fps ?? 60) < 15) continue;   // skip laggy servers

      const age            = nowSec - entry.firstSeen;
      const timeUntilEvent = calcTimeUntilEvent(age, cfg.offset, interval);

      list.push({
        jobId,
        timeUntilEvent,
        estimatedAge:  Math.round(age),
        playing:       entry.playing    ?? 0,
        maxPlayers:    entry.maxPlayers ?? 0,
        fps:           Math.round((entry.fps ?? 60) * 10) / 10,
      });
    }

    list.sort((a, b) => a.timeUntilEvent - b.timeUntilEvent);
    results[key] = list.slice(0, TOP_N);
  }

  return results;
}

// ── Discord helpers ─────────────────────────────────────────────────────────

function parseWebhook(url) {
  const parts = url.trim().replace(/\/$/, "").split("/");
  const token = parts.pop();
  const id    = parts.pop();
  return { id, token, base: `https://discord.com/api/webhooks/${id}/${token}` };
}

function fmtCountdown(sec) {
  if (sec <= 0) return "**NOW!** 🚨";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `**${m}m ${String(s).padStart(2, "0")}s**`;
}

function buildServerEmbed(cfg, server, nowSec) {
  const timeLeft = server.timeUntilEvent;
  let urgencyColor = cfg.color;
  let urgencyBar   = "";
  if (timeLeft <= 60)  { urgencyColor = 0xFF0000; urgencyBar = "🔴🔴🔴 URGENT"; }
  else if (timeLeft <= 180) { urgencyColor = 0xFF6600; urgencyBar = "🟠🟠 VERY SOON"; }
  else if (timeLeft <= 300) { urgencyColor = 0xFFCC00; urgencyBar = "🟡 SOON"; }
  else                 { urgencyColor = cfg.color;  urgencyBar = "🟢 UPCOMING"; }

  const ageMin = Math.round(server.estimatedAge / 60);

  return {
    title:       `${cfg.emoji}  ${cfg.label}`,
    description: [
      urgencyBar,
      `⏱ Event in: ${fmtCountdown(timeLeft)}`,
      `🌊 Sea: **${cfg.sea}**`,
    ].join("\n"),
    color: urgencyColor,
    fields: [
      {
        name:   "Server ID (copy this to hop)",
        value:  `\`\`\`${server.jobId}\`\`\``,
        inline: false,
      },
      {
        name:   "👥 Players",
        value:  `${server.playing}/${server.maxPlayers}`,
        inline: true,
      },
      {
        name:   "⏳ Server Age",
        value:  `~${ageMin} min`,
        inline: true,
      },
      {
        name:   "🖥️ FPS",
        value:  `${server.fps}`,
        inline: true,
      },
    ],
    footer:    { text: `Blox Fruits Tracker  •  Next update in ~60s` },
    timestamp: new Date(nowSec * 1000).toISOString(),
  };
}

async function discordPost(webhookUrl, payload) {
  const { base } = parseWebhook(webhookUrl);
  try {
    const res = await fetch(`${base}?wait=true`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`  POST ${res.status}: ${(await res.text()).slice(0, 150)}`);
      return null;
    }
    return (await res.json()).id ?? null;
  } catch (e) { console.warn(`  POST failed: ${e.message}`); return null; }
}

async function discordPatch(webhookUrl, messageId, payload) {
  const { base } = parseWebhook(webhookUrl);
  try {
    const res = await fetch(`${base}/messages/${messageId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (e) { console.warn(`  PATCH failed: ${e.message}`); return false; }
}

async function discordDelete(webhookUrl, messageId) {
  const { base } = parseWebhook(webhookUrl);
  try { await fetch(`${base}/messages/${messageId}`, { method: "DELETE" }); } catch {}
}

// Rate-limit Discord to avoid 429 errors (max 5 msg / 2 sec per webhook)
async function rateLimitedPost(webhookUrl, payload) {
  const id = await discordPost(webhookUrl, payload);
  await sleep(400);  // stay well under rate limit
  return id;
}

// ── Per-event Discord logic ────────────────────────────────────────────────

async function handleEvent(eventKey, cfg, servers, state, nowSec) {
  const webhookUrl = process.env[cfg.webhookEnv];
  if (!webhookUrl) return;

  const alerted      = state.alertedJobs;
  const liveMessages = state.liveMessages;

  // ── Edit existing live messages ────────────────────────────────────────
  for (const [msgKey, msgData] of Object.entries(liveMessages)) {
    if (!msgKey.startsWith(eventKey + ":")) continue;
    const jobId  = msgKey.slice(eventKey.length + 1);
    const server = servers.find(s => s.jobId === jobId);

    // Server gone or event cycled over — clean up
    if (!server || server.timeUntilEvent > ALERT_THRESHOLD_SEC + 120) {
      await discordDelete(webhookUrl, msgData.messageId);
      delete liveMessages[msgKey];
      delete alerted[msgKey];
      continue;
    }

    // Event is NOW — send loud ping and clean up
    if (server.timeUntilEvent <= 15) {
      await discordPatch(webhookUrl, msgData.messageId, {
        content: `@everyone 🚨 **${cfg.label}** is **STARTING NOW** — ${cfg.sea}!`,
        embeds: [{
          title:       `🚨 ${cfg.label} — NOW!`,
          description: `**Join immediately!** Event starting in **${cfg.sea}**\n\nServer ID:\n\`\`\`${server.jobId}\`\`\``,
          color:       0xFF0000,
          timestamp:   new Date().toISOString(),
        }],
      });
      delete liveMessages[msgKey];
      console.log(`  [${eventKey}] NOW fired for ${jobId}`);
      continue;
    }

    // Update countdown embed
    const embed = buildServerEmbed(cfg, server, nowSec);
    await discordPatch(webhookUrl, msgData.messageId, { embeds: [embed] });
    console.log(`  [${eventKey}] updated → ${fmtCountdown(server.timeUntilEvent)} for ${jobId.slice(0,8)}…`);
    await sleep(300);
  }

  // ── Send new alerts ───────────────────────────────────────────────────
  const newAlerts = servers.filter(s => {
    const k = `${eventKey}:${s.jobId}`;
    return s.timeUntilEvent <= ALERT_THRESHOLD_SEC && !alerted[k] && !liveMessages[k];
  });

  for (const server of newAlerts.slice(0, 10)) {   // max 10 new alerts per scan
    const msgKey  = `${eventKey}:${server.jobId}`;
    const content = `@everyone ${cfg.emoji} **${cfg.label}** in ${fmtCountdown(server.timeUntilEvent)} — **${cfg.sea}**!`;
    const embed   = buildServerEmbed(cfg, server, nowSec);

    const messageId = await rateLimitedPost(webhookUrl, { content, embeds: [embed] });
    if (messageId) {
      liveMessages[msgKey] = { messageId, sentAt: nowSec };
      alerted[msgKey]      = true;
      console.log(`  [${eventKey}] alert sent → ${fmtCountdown(server.timeUntilEvent)} for ${server.jobId.slice(0,8)}…`);
    }
  }
}

// ── Heartbeat log ──────────────────────────────────────────────────────────

async function sendHeartbeat({ nowIso, liveCount, newCount, diedCount, agedOut,
                                totalTracked, rateLimited, prunedDead, eventResults }) {
  const url = process.env["DISCORD_WEBHOOK_LOG"];
  if (!url) return;

  const timeStr = nowIso.replace("T", " ").slice(0, 19) + " UTC";

  const eventLines = Object.entries(EVENTS).map(([key, cfg]) => {
    const list    = eventResults[key] ?? [];
    const under10 = list.filter(s => s.timeUntilEvent <= 600).length;
    const best    = list[0];
    const bestStr = best
      ? `${Math.floor(best.timeUntilEvent / 60)}m ${best.timeUntilEvent % 60}s`
      : "—";
    const dot = under10 > 0 ? "🔴" : list.length > 0 ? "🟡" : "⚫";
    return `${dot} ${cfg.emoji} **${cfg.label}** — ${list.length} tracked | next: ${bestStr}`;
  });

  const embed = {
    title:       "✅ Scan Complete",
    description: [
      `**${timeStr}**${rateLimited ? "  ⚠️ rate-limited" : ""}`,
      `📡 Scanned: **${liveCount}** servers${rateLimited ? " ⚠️ rate-limited (dead-prune skipped)" : ""}`,
      `📊 Tracked: **${totalTracked}**`,
      `➕ New: **${newCount}**  |  💀 Dead: **${prunedDead ? diedCount : "skipped"}**  |  ⌛ Aged: **${agedOut}**`,
    ].join("\n"),
    color:  newCount > 0 ? 0x00CCFF : 0x44BB66,
    fields: [{
      name:  "Event Overview",
      value: eventLines.join("\n"),
    }],
    footer:    { text: "Blox Fruits Tracker  •  Next scan in ~60s" },
    timestamp: nowIso,
  };

  try {
    await fetch(parseWebhook(url).base, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    console.log("  Heartbeat sent.");
  } catch (e) { console.warn("  Heartbeat failed:", e.message); }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Blox Fruits Scanner  ${new Date().toISOString()} ===`);

  const state = loadState();

  console.log(`State: ${Object.keys(state.servers).length} servers known`);
  console.log("Fetching from Roblox…");

  let liveServers, rateLimited;
  try {
    ({ servers: liveServers, rateLimited } = await fetchAllServers());
  } catch (err) {
    console.error("Fetch failed:", err.message);
    process.exit(1);
  }

  console.log(`Fetched: ${liveServers.length} servers${rateLimited ? " (rate-limited)" : ""}`);

  const nowSec  = Date.now() / 1000;
  const nowIso  = new Date().toISOString();
  const seenIds = new Set();
  let newCount = 0, diedCount = 0, agedOut = 0;

  // ── Track all servers — no baseline, track from scan 1 ──────────────────
  for (const s of liveServers) {
    seenIds.add(s.id);
    const existing = state.servers[s.id];
    if (existing) {
      // Update live stats
      existing.playing    = s.playing;
      existing.maxPlayers = s.maxPlayers;
      existing.fps        = s.fps;
    } else {
      // Brand new server — start tracking immediately
      state.servers[s.id] = {
        firstSeen:   nowSec,
        firstSeenTs: nowIso,
        playing:     s.playing,
        maxPlayers:  s.maxPlayers,
        fps:         s.fps,
      };
      newCount++;
    }
  }

  // ── Remove dead and aged-out servers ────────────────────────────────────
  // Only trust dead-server pruning when we fetched enough servers.
  // If rate-limited mid-scan, missing servers are NOT dead — just unfetched.
  const canPruneDead = liveServers.length >= MIN_FOR_PRUNE;

  if (!canPruneDead) {
    console.log(`  Skipping dead-prune — only got ${liveServers.length} servers (rate-limited).`);
  }

  for (const [jobId, entry] of Object.entries(state.servers)) {
    if (canPruneDead && !seenIds.has(jobId)) {
      delete state.servers[jobId];
      diedCount++;
      continue;
    }
    // Always age out servers older than 4 hours regardless of scan completeness
    if (entry.firstSeen != null && nowSec - entry.firstSeen > MAX_TRACK_AGE_SEC) {
      delete state.servers[jobId];
      agedOut++;
    }
  }

  // Clean up alert state for removed servers
  for (const key of Object.keys(state.alertedJobs)) {
    const jobId = key.split(":").slice(1).join(":");
    if (!state.servers[jobId]) delete state.alertedJobs[key];
  }
  for (const key of Object.keys(state.liveMessages)) {
    const jobId = key.split(":").slice(1).join(":");
    if (!state.servers[jobId]) delete state.liveMessages[key];
  }

  state.lastScanAt = nowIso;

  const totalTracked = Object.keys(state.servers).length;
  console.log(`+${newCount} new | -${diedCount} dead | -${agedOut} aged | total: ${totalTracked}`);

  // ── Build event results ────────────────────────────────────────────────
  const eventResults = buildEventResults(state, nowSec);

  // ── Discord event alerts ───────────────────────────────────────────────
  for (const [key, cfg] of Object.entries(EVENTS)) {
    if ((eventResults[key]?.length ?? 0) > 0) {
      await handleEvent(key, cfg, eventResults[key], state, nowSec);
    }
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────
  await sendHeartbeat({ nowIso, liveCount: liveServers.length, newCount, diedCount,
                        agedOut, totalTracked, rateLimited,
                        prunedDead: liveServers.length >= MIN_FOR_PRUNE,
                        eventResults });

  // ── Save ───────────────────────────────────────────────────────────────
  const eventMeta = {};
  for (const [key, cfg] of Object.entries(EVENTS)) {
    eventMeta[key] = { label: cfg.label, sea: cfg.sea };
  }

  saveState(state);
  saveServers({
    updatedAt: nowIso,
    totalTracked,
    newThisScan:  newCount,
    diedThisScan: diedCount,
    eventMeta,
    events: eventResults,
  });

  console.log("Done.");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
