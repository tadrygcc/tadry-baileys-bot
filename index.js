// Tadry WhatsApp bot on Baileys (unofficial).
// - Connects to WhatsApp as the Tadry number via QR-code pairing (one-time)
// - Persists session in ./auth_info (mount a Railway volume here to survive restarts)
// - On each incoming user message, POSTs { text, from_id, history } to TADRY_API_URL
// - Renders the JSON reply into WhatsApp messages:
//     answer text → sources link (tadrygcc.com/v/{id}) → video (mp4 or link)
// - Multi-turn: remembers last 3 exchanges per phone (in-memory, TTL 30 min)
// - Greets new phones once on their first message

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  Browsers,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcodeTerminal from "qrcode-terminal";
import cron from "node-cron";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";

const API_URL = process.env.TADRY_API_URL;
const API_SECRET = process.env.BOT_SHARED_SECRET || "";
const AUTH_DIR = process.env.AUTH_DIR || "./auth_info";

// The daily brief push: cron on the volume-persistent subscribers list.
// Volume is mounted at /data (same as AUTH_DIR's parent) so restarts don't
// lose subscribers. Defaults chosen so no env vars are needed for the
// happy path — user just needs the Railway volume mount at /data.
const DATA_DIR = process.env.DATA_DIR || path.dirname(AUTH_DIR);
const SUBSCRIBERS_FILE = path.join(DATA_DIR, "subscribers.json");
const BRIEF_CRON = process.env.BRIEF_CRON || "0 8 * * *"; // 08:00 daily (coffee slot)
const BRIEF_TZ = process.env.BRIEF_TZ || "Asia/Riyadh";
const BRIEF_ENABLED = process.env.BRIEF_ENABLED !== "false";
// Derive sibling API URLs from /api/bot so we don't need extra env vars.
const BRIEF_URL = API_URL ? API_URL.replace(/\/api\/bot\/?$/, "/api/brief") : "";
const GREETING_URL = API_URL ? API_URL.replace(/\/api\/bot\/?$/, "/api/greeting") : "";

if (!API_URL) {
  console.error("Missing TADRY_API_URL env var. Point it at your tadry-web /api/bot endpoint.");
  process.exit(1);
}
console.log(`>>> TADRY_API_URL = ${API_URL}`);
console.log(`>>> BOT_SHARED_SECRET length = ${(process.env.BOT_SHARED_SECRET || "").length}`);

const log = pino({ level: process.env.LOG_LEVEL || "info" });

// ------------------------------------------------------------
// Per-user memory: history + first-message greeting bookkeeping
// ------------------------------------------------------------

const HISTORY_MAX_PER_USER = 6; // 3 exchanges
const HISTORY_TTL_MS = 30 * 60 * 1000; // 30 min
const historyByUser = new Map(); // jid → { turns: [{role,text}], updatedAt }
const greetedUsers = new Set(); // jid → seen at least once

function recentHistory(jid) {
  const h = historyByUser.get(jid);
  if (!h) return [];
  if (Date.now() - h.updatedAt > HISTORY_TTL_MS) {
    historyByUser.delete(jid);
    return [];
  }
  return h.turns;
}

function appendHistory(jid, role, text) {
  const cur = historyByUser.get(jid);
  const turns = cur && Date.now() - cur.updatedAt <= HISTORY_TTL_MS ? cur.turns : [];
  turns.push({ role, text });
  while (turns.length > HISTORY_MAX_PER_USER) turns.shift();
  historyByUser.set(jid, { turns, updatedAt: Date.now() });
}

// Hardcoded fallback greeting — only used if /api/greeting is unreachable.
// The real greeting comes from the server so we can tweak it (add new
// commands, refresh the latest-5 list) without redeploying Baileys.
const GREETING_FALLBACK = [
  "*تدري؟*",
  "_محاور جيوسياسة منطقتنا — العالم العربيّ وإيران. أجيب من الأرشيف بمصادر موثّقة، لا اختراع ولا تلفيق._",
  "",
  "*جرّب:*",
  "› اكتب رقم حلقة (مثال: *«الحلقة 53»*)",
  "› اكتب اسم دولة أو موضوع (مثال: *«سوريا»*)",
  "› *«موجز»* — لموجز اليوم في المنطقة",
  "› *«اشتراك»* — ليوصلك الموجز الصباحي مع قهوتك ☕",
  "",
  "— *tadrygcc.com*",
].join("\n");

// Server-side greeting cache: refetch every hour so new episodes appear
// in the «latest 5» list without a Baileys restart.
const GREETING_TTL_MS = 60 * 60 * 1000;
let greetingCache = { text: GREETING_FALLBACK, at: 0 };

async function getGreeting() {
  const now = Date.now();
  if (greetingCache.text && now - greetingCache.at < GREETING_TTL_MS) {
    return greetingCache.text;
  }
  if (!GREETING_URL) return GREETING_FALLBACK;
  try {
    const r = await fetch(GREETING_URL, { signal: AbortSignal.timeout(6_000) });
    if (!r.ok) throw new Error(`greeting api ${r.status}`);
    const data = await r.json();
    if (typeof data.text === "string" && data.text.length > 20) {
      greetingCache = { text: data.text, at: now };
      return data.text;
    }
    throw new Error("greeting api returned empty text");
  } catch (err) {
    log.warn({ err: String(err) }, "greeting fetch failed — using fallback");
    return GREETING_FALLBACK;
  }
}

const BRAND_FOOTER = "\n\n—\n_اسأل تدري؟ · tadrygcc.com_";

// ------------------------------------------------------------
// Subscribers: map keyed by jid → { subscribed_at, paid, paid_at }.
// Persisted as a plain object to /data/subscribers.json.
//
// Format history:
//   v0 (early): ["jid1", "jid2"]                — just an array of jids
//   v1 (current): { "jid1": { subscribed_at, paid, paid_at }, ... }
// loadSubscribers() promotes v0 files to v1 on read.
// ------------------------------------------------------------

let subscribers = new Map();

function newSubRecord(name) {
  return {
    subscribed_at: Date.now(),
    paid: false,
    paid_at: null,
    name: typeof name === "string" && name.trim() ? name.trim() : null,
  };
}

async function loadSubscribers() {
  try {
    const raw = await fs.readFile(SUBSCRIBERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    subscribers = new Map();
    if (Array.isArray(parsed)) {
      // v0 → v1 promotion: unknown subscribe time so leave it at 0.
      for (const jid of parsed) {
        if (typeof jid === "string" && jid.length > 0) {
          subscribers.set(jid, { subscribed_at: 0, paid: false, paid_at: null });
        }
      }
      log.info(`loaded ${subscribers.size} subscriber(s) [v0 array, promoted]`);
      // Persist immediately in v1 shape so we only promote once.
      await saveSubscribers();
    } else if (parsed && typeof parsed === "object") {
      for (const [jid, meta] of Object.entries(parsed)) {
        subscribers.set(jid, {
          subscribed_at: typeof meta?.subscribed_at === "number" ? meta.subscribed_at : 0,
          paid: meta?.paid === true,
          paid_at: typeof meta?.paid_at === "number" ? meta.paid_at : null,
          name: typeof meta?.name === "string" ? meta.name : null,
        });
      }
      log.info(`loaded ${subscribers.size} subscriber(s) from ${SUBSCRIBERS_FILE}`);
    }
  } catch (err) {
    if (err && err.code === "ENOENT") {
      log.info(`no subscribers file at ${SUBSCRIBERS_FILE} yet — starting empty`);
    } else {
      log.warn({ err: String(err) }, "failed to load subscribers — starting empty");
    }
    subscribers = new Map();
  }
}

async function saveSubscribers() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(
      SUBSCRIBERS_FILE,
      JSON.stringify(Object.fromEntries(subscribers), null, 2)
    );
  } catch (err) {
    log.error({ err: String(err) }, "failed to save subscribers");
  }
}

function subsInTarget(target) {
  // target: "all" | "paid" | "free"
  const jids = [];
  for (const [jid, meta] of subscribers) {
    if (target === "paid" && !meta.paid) continue;
    if (target === "free" && meta.paid) continue;
    jids.push(jid);
  }
  return jids;
}

// اشتراك / اشترك / subscribe — match the whole trimmed message so a
// mid-sentence mention doesn't accidentally toggle. Same for unsubscribe.
const SUBSCRIBE_RE = /^\s*(?:اشتراك|اشترك|subscribe|الاشتراك|start)\s*[?؟.!]*\s*$/i;
const UNSUBSCRIBE_RE = /^\s*(?:إيقاف|ايقاف|إلغاء|الغاء|الغاء\s+الاشتراك|إلغاء\s+الاشتراك|توقف|stop|unsubscribe)\s*[?؟.!]*\s*$/i;

function isSubscribeIntent(text) {
  return SUBSCRIBE_RE.test(text);
}
function isUnsubscribeIntent(text) {
  return UNSUBSCRIBE_RE.test(text);
}

// Fetch the current cached brief text from tadry-web and push it to
// every subscriber. Small delay between sends to avoid tripping WA
// spam heuristics on a fan-out. Failures per-recipient are logged but
// do not abort the run.
async function fetchTodaysBrief() {
  const r = await fetch(BRIEF_URL, {
    method: "GET",
    headers: { "x-bot-secret": API_SECRET },
  });
  if (!r.ok) throw new Error(`brief api ${r.status}: ${await r.text().catch(() => "")}`);
  const data = await r.json();
  if (!data.text || typeof data.text !== "string") {
    throw new Error("brief api returned no text");
  }
  return data.text;
}

async function pushBriefToAllSubscribers(sock) {
  if (subscribers.size === 0) {
    log.info("scheduled push: no subscribers");
    return;
  }
  let text;
  try {
    text = await fetchTodaysBrief();
  } catch (err) {
    log.error({ err: String(err) }, "scheduled push: fetch brief failed");
    return;
  }
  const body = text + BRAND_FOOTER;
  let sent = 0;
  // Morning brief goes to *all* subscribers regardless of paid tier —
  // the free promise is the morning coffee brief.
  for (const jid of subscribers.keys()) {
    try {
      await sock.sendMessage(jid, { text: body });
      sent++;
      // 500ms between sends — WhatsApp's fan-out guardrails are lax at
      // this scale but zero delay looks bot-shaped.
      await new Promise((res) => setTimeout(res, 500));
    } catch (err) {
      log.warn({ err: String(err), jid }, "scheduled push: send failed");
    }
  }
  log.info(`scheduled push: sent ${sent}/${subscribers.size}`);
}

// ------------------------------------------------------------
// Ad-hoc push: admin-triggered from tadrygcc.com/admin. Delivered to
// all current subscribers (paid filter comes in a future phase).
// Silent hours 22:00–06:00 Gulf enforced server-side so an accidental
// tap at 3 AM can't ping everyone.
// ------------------------------------------------------------

const PUSH_ALERT_FOOTER = "\n\n—\n_تنبيه تدري · tadrygcc.com_";
const PUSH_SEND_DELAY_MS = 500;

function isSilentHourNow() {
  // Convert current UTC to Asia/Riyadh (UTC+3 fixed, no DST).
  const nowUtcH = new Date().getUTCHours();
  const gulfH = (nowUtcH + 3) % 24;
  return gulfH >= 22 || gulfH < 6;
}

async function pushAlertToSubscribers(sock, text, target) {
  const jids = subsInTarget(target);
  if (jids.length === 0) return { sent: 0, failed: 0, total: 0, target };
  const body = text + PUSH_ALERT_FOOTER;
  let sent = 0;
  let failed = 0;
  for (const jid of jids) {
    try {
      await sock.sendMessage(jid, { text: body });
      sent++;
    } catch (err) {
      failed++;
      log.warn({ err: String(err), jid }, "ad-hoc push: send failed");
    }
    await new Promise((res) => setTimeout(res, PUSH_SEND_DELAY_MS));
  }
  return { sent, failed, total: jids.length, target };
}

// Minimal HTTP server so tadry-web /api/admin/push can dispatch alerts
// without needing a polling queue. Railway auto-exposes $PORT and gives
// this service a public URL, which the admin config points at.
function requireSecret(req, res) {
  if ((req.headers["x-bot-secret"] || "") !== API_SECRET) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return false;
  }
  return true;
}

async function readJsonBody(req, res, maxBytes = 20_000) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad json" }));
        resolve(null);
      }
    });
  });
}

function startHttpServer(sockRef) {
  const port = Number(process.env.PORT) || 8080;
  console.log(`[http] boot: attempting to listen on port ${port} (PORT env=${process.env.PORT ?? "(unset)"})`);
  const server = http.createServer(async (req, res) => {
    const sock = sockRef.current;
    // Health check for Railway's default probes.
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          subs: subscribers.size,
          paid: subsInTarget("paid").length,
          pid: process.pid,
          uptime_s: Math.round(process.uptime()),
        })
      );
      return;
    }

    // Nuclear reset: wipe the stale auth_info directory and exit so
    // Railway restarts the container fresh. Used when we've unlinked all
    // WA devices from the phone side and need Baileys to abandon its
    // stored session and print a new QR. Secret-gated. POST-only so
    // curious GETs from misconfigured tools don't accidentally reset.
    if (req.method === "POST" && req.url === "/debug/reset-auth") {
      if (!requireSecret(req, res)) return;
      try {
        const fsSync = await import("node:fs");
        fsSync.rmSync(AUTH_DIR, { recursive: true, force: true });
        console.log(`[reset] wiped auth dir ${AUTH_DIR} — exiting for Railway to restart`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, wiped: AUTH_DIR, exiting: true }));
        // Give the response a moment to flush before exit.
        setTimeout(() => process.exit(0), 500);
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // Diagnostic dump — reveals process identity + full subs contents so
    // we can distinguish between "empty Map" and "two-process divergence".
    // Secret-gated because it exposes phone numbers.
    if (req.method === "GET" && req.url === "/debug/state") {
      if (!requireSecret(req, res)) return;
      const subsArr = [];
      for (const [jid, meta] of subscribers) {
        subsArr.push({ jid, ...meta });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          pid: process.pid,
          uptime_s: Math.round(process.uptime()),
          started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
          subs_size: subscribers.size,
          subs_dump: subsArr,
          sock_ready: sock != null,
          subscribers_file: SUBSCRIBERS_FILE,
        })
      );
      return;
    }

    // GET /subs — list subscribers with metadata. Secret-gated because
    // this is a PII-shaped payload (phone numbers) — same rule as /push.
    if (req.method === "GET" && req.url === "/subs") {
      if (!requireSecret(req, res)) return;
      const list = [];
      for (const [jid, meta] of subscribers) {
        list.push({
          jid,
          subscribed_at: meta.subscribed_at || null,
          paid: meta.paid === true,
          paid_at: meta.paid_at || null,
          name: meta.name || null,
        });
      }
      // Newest first — most recent joins are the most interesting.
      list.sort((a, b) => (b.subscribed_at || 0) - (a.subscribed_at || 0));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ subs: list, total: list.length }));
      return;
    }

    // POST /subs/paid — flip a subscriber's paid flag.
    // Body: { jid, paid: boolean }
    if (req.method === "POST" && req.url === "/subs/paid") {
      if (!requireSecret(req, res)) return;
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const jid = typeof body.jid === "string" ? body.jid : "";
      const paid = body.paid === true;
      if (!jid || !subscribers.has(jid)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no such subscriber" }));
        return;
      }
      const meta = subscribers.get(jid);
      meta.paid = paid;
      meta.paid_at = paid ? Date.now() : null;
      subscribers.set(jid, meta);
      await saveSubscribers();
      log.info({ jid, paid }, "paid flag updated");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, jid, paid: meta.paid, paid_at: meta.paid_at }));
      return;
    }

    if (req.method !== "POST" || req.url !== "/push") {
      res.writeHead(404).end();
      return;
    }
    if (!requireSecret(req, res)) return;
    if (!sock) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "wa not ready", message: "WhatsApp socket not connected yet — retry in a few seconds." }));
      return;
    }

    const parsed = await readJsonBody(req, res);
    if (parsed === null) return;
    try {
      const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
      const override = parsed.override_silent === true;
      const target =
        parsed.target === "paid" || parsed.target === "free"
          ? parsed.target
          : "all";
      if (!text || text.length < 3) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "empty" }));
        return;
      }
      if (text.length > 3000) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "too long" }));
        return;
      }
      if (isSilentHourNow() && !override) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "silent_hours",
            message:
              "Silent hours 22:00-06:00 Asia/Riyadh. Pass override_silent:true to force.",
          })
        );
        return;
      }
      log.info(
        { chars: text.length, target, subs: subscribers.size },
        "ad-hoc push starting"
      );
      const result = await pushAlertToSubscribers(sock, text, target);
      log.info(result, "ad-hoc push done");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      log.error({ err: String(err) }, "push endpoint crashed");
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
  server.on("error", (err) => {
    console.error(`[http] server error: ${err}`);
  });
  // Bind to 0.0.0.0 explicitly — some container platforms won't route
  // to a service that binds only to 127.0.0.1 (the Node default).
  server.listen(port, "0.0.0.0", () => {
    console.log(`[http] listening on 0.0.0.0:${port}`);
  });
}

// ------------------------------------------------------------

async function askTadry({ text, fromId, history }) {
  const r = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bot-secret": API_SECRET,
    },
    body: JSON.stringify({ text, from_id: fromId, history }),
  });
  if (!r.ok) {
    throw new Error(`bot api ${r.status}: ${await r.text().catch(() => "")}`);
  }
  return r.json();
}

// Download an MP4 URL into a Buffer. Baileys extracts duration and
// thumbnail from the file bytes at send time; sending by { url: '...' }
// alone yields a 0:00 duration in WhatsApp until you tap play.
async function downloadVideo(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`video download ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf;
}

// Same for cover PNGs — Baileys wants bytes to render a proper image
// message (not a link preview).
async function downloadImage(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`image download ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf;
}

async function sendReply(sock, jid, reply) {
  // 1) Cover image — shows the episode's artwork prominently as the visual
  //    anchor of the reply. Baileys downloads bytes and sends as a proper
  //    image message (not a link preview).
  if (reply.cover?.url) {
    log.info({ url: reply.cover.url }, "sending cover");
    try {
      const imgBuf = await downloadImage(reply.cover.url);
      await sock.sendMessage(jid, {
        image: imgBuf,
        caption: reply.cover.caption,
      });
      log.info("cover sent");
    } catch (err) {
      log.error({ err: String(err), url: reply.cover.url }, "cover send failed");
    }
  } else {
    log.info({ has_cover: !!reply.cover }, "no cover in reply");
  }

  // 2) The answer text with brand footer appended.
  if (reply.text && reply.text.trim().length > 0) {
    await sock.sendMessage(jid, { text: reply.text + BRAND_FOOTER });
  }

  // 3) Sources link on tadrygcc.com — WhatsApp shows a link preview card.
  if (reply.entry_url) {
    await sock.sendMessage(jid, {
      text: `_المصادر الكاملة:_\n${reply.entry_url}`,
    });
  }

  // 4) The video: MP4 (downloaded → sent as Buffer so duration + thumbnail
  //    render correctly) or Instagram/TikTok link (WhatsApp preview).
  if (reply.video) {
    if (reply.video.is_mp4) {
      try {
        const buf = await downloadVideo(reply.video.url);
        await sock.sendMessage(jid, {
          video: buf,
          caption: reply.video.caption,
          mimetype: "video/mp4",
        });
      } catch (err) {
        log.warn({ err: String(err) }, "mp4 send failed, falling back to URL");
        try {
          await sock.sendMessage(jid, {
            video: { url: reply.video.url },
            caption: reply.video.caption,
            mimetype: "video/mp4",
          });
        } catch (err2) {
          log.warn({ err: String(err2) }, "url send also failed, sending as link");
          await sock.sendMessage(jid, {
            text: `${reply.video.caption ? reply.video.caption + "\n" : ""}${reply.video.url}`,
          });
        }
      }
    } else {
      await sock.sendMessage(jid, {
        text: `${reply.video.caption ? reply.video.caption + "\n" : ""}${reply.video.url}`,
      });
    }
  }
}

// Dedup seen message ids across the whole session (in-memory). Prevents
// double-answers if WhatsApp redelivers an event.
const seen = new Map();
const SEEN_TTL_MS = 10 * 60 * 1000;
function firstTime(id) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k);
  if (seen.has(id)) return false;
  seen.set(id, now);
  return true;
}

async function start() {
  await loadSubscribers();

  // Start the HTTP server *immediately*, before we await the WA socket.
  // Rationale: Railway's edge routes to $PORT the moment the container
  // is marked ready, and if the port isn't listening it returns
  // "Application failed to respond" (502). Waiting for WA connect
  // means Railway may probe the port before our HTTP server is up.
  // The push/subs handlers close over `sockRef.current` so we can wire
  // the socket in once WA connects.
  const sockRef = { current: null };
  startHttpServer(sockRef);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: log,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, log),
    },
    // Don't appear "online" 24/7 — spam signal.
    markOnlineOnConnect: false,
    printQRInTerminal: false,
    // Standard browser fingerprint. Custom identity strings ("Tadry Bot")
    // sometimes trip WhatsApp Business App's anti-fraud checks.
    browser: Browsers.ubuntu("Chrome"),
    // Skip long history sync on first connect — we only care about
    // messages arriving after the bot is linked.
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  // Pairing-code linking: if PAIRING_PHONE is set and this Baileys
  // instance has no registered creds yet, request an 8-digit code
  // from WA. User enters it in WA → Linked Devices → Link with phone
  // number. This bypasses the QR scanner which has been rejecting
  // scans intermittently against current WA builds.
  //
  // PAIRING_PHONE must be the E.164 number without the '+', e.g.
  // 96555555555 for a Kuwait number.
  const pairingPhone = (process.env.PAIRING_PHONE || "").replace(/\D/g, "");
  if (pairingPhone && !sock.authState.creds.registered) {
    // Give the socket a moment to negotiate the initial WS frames
    // before requesting the code — Baileys errors if called too early.
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(pairingPhone);
        const pretty = code.match(/.{1,4}/g)?.join("-") || code;
        console.log("\n=== PAIRING CODE ===");
        console.log(`Enter this in WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number:\n\n    ${pretty}\n`);
        console.log("The code expires in ~60 seconds. If it fails, redeploy the service to get a new one.\n");
      } catch (err) {
        console.error(`[pairing] requestPairingCode failed: ${err}`);
      }
    }, 3000);
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log(`[conn.update] connection=${connection ?? "(none)"} qr=${qr ? "yes" : "no"} code=${lastDisconnect?.error?.output?.statusCode ?? "-"}`);
    if (qr) {
      console.log("\n=== SCAN THIS QR FROM YOUR TADRY WHATSAPP BUSINESS APP ===");
      console.log("Settings → Linked Devices → Link a Device\n");
      qrcodeTerminal.generate(qr, { small: true });
      const encoded = encodeURIComponent(qr);
      console.log("\n>>> If the ASCII QR above won't scan, open THIS URL");
      console.log(">>> in your browser (any device) and scan it from there:\n");
      console.log(`https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encoded}`);
      console.log("\n(waiting for scan...)\n");
    }
    if (connection === "open") {
      log.info("connected to WhatsApp as Tadry");
      // Hand the socket to the HTTP server so push/subs endpoints
      // can send messages. HTTP server was started earlier in start().
      sockRef.current = sock;
      // Arm the daily brief cron the first time we successfully connect.
      // Reconnects re-enter this branch but node-cron's schedule is
      // idempotent per (cron, callback, tz) key — we guard with a flag.
      if (BRIEF_ENABLED && !global.__briefCronArmed) {
        global.__briefCronArmed = true;
        if (!cron.validate(BRIEF_CRON)) {
          log.error({ BRIEF_CRON }, "invalid BRIEF_CRON expression — push disabled");
        } else {
          cron.schedule(
            BRIEF_CRON,
            () => {
              log.info("scheduled brief push firing");
              pushBriefToAllSubscribers(sock).catch((err) =>
                log.error({ err: String(err) }, "scheduled push crashed")
              );
            },
            { timezone: BRIEF_TZ }
          );
          log.info(`brief push armed: cron="${BRIEF_CRON}" tz=${BRIEF_TZ}`);
        }
      }
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      log.warn({ code, shouldReconnect }, "connection closed");
      if (shouldReconnect) {
        setTimeout(start, 3000);
      } else {
        log.error("logged out — delete auth_info and restart to re-pair");
        process.exit(1);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        if (m.key.fromMe) continue;
        if (m.key.remoteJid?.endsWith("@broadcast")) continue;
        if (!m.key.remoteJid || m.key.remoteJid.endsWith("@g.us")) continue;
        if (!m.key.id || !firstTime(m.key.id)) continue;

        const text =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          "";
        if (!text || typeof text !== "string" || text.trim().length === 0) continue;

        const fromId = m.key.remoteJid;
        // WA sets pushName to the sender's WhatsApp display name on
        // every incoming message. Cache it so the admin panel can
        // show "Yousef" instead of the opaque @lid identifier.
        const pushName = typeof m.pushName === "string" ? m.pushName : null;
        log.info({ from: fromId, name: pushName, len: text.length }, "incoming");

        // First-time greeting. Fetches from /api/greeting so tweaks
        // (new commands, updated latest-5 list) don't require a Baileys
        // redeploy. Falls back to hardcoded string on network error.
        if (!greetedUsers.has(fromId)) {
          greetedUsers.add(fromId);
          try {
            const greetingText = await getGreeting();
            await sock.sendMessage(fromId, { text: greetingText });
          } catch (err) {
            log.warn({ err: String(err) }, "greeting failed");
          }
        }

        // Subscribe / unsubscribe handled locally — never hits /api/bot.
        // Idempotent by design so repeated «اشتراك» from the same person
        // reassures them rather than errors.
        if (isSubscribeIntent(text)) {
          const wasNew = !subscribers.has(fromId);
          log.info(
            { fromId, wasNew, sizeBefore: subscribers.size, pid: process.pid },
            "subscribe intent"
          );
          if (wasNew) {
            subscribers.set(fromId, newSubRecord(pushName));
          } else if (pushName) {
            // Backfill/refresh the display name on returning subs so
            // admin panel keeps the latest name if the user updated it.
            const existing = subscribers.get(fromId);
            if (existing && existing.name !== pushName) {
              existing.name = pushName;
              subscribers.set(fromId, existing);
            }
          }
          await saveSubscribers();
          log.info(
            { fromId, sizeAfter: subscribers.size, pid: process.pid },
            "subscribe done"
          );
          const msg = wasNew
            ? "✓ اشتركت في *موجز تدري* ☕\n_يوصلك كلّ صباح الساعة ٨ بتوقيت الخليج، مع قهوتك._\n\nتبي توقف؟ اكتب *«إيقاف»*."
            : "أنت مشترك بالفعل في *موجز تدري* ☕\n_يوصلك كلّ صباح الساعة ٨ بتوقيت الخليج._";
          try {
            await sock.sendMessage(fromId, { text: msg + BRAND_FOOTER });
          } catch (err) {
            log.warn({ err: String(err) }, "subscribe ack failed");
          }
          continue;
        }
        if (isUnsubscribeIntent(text)) {
          const wasSubscribed = subscribers.delete(fromId);
          if (wasSubscribed) await saveSubscribers();
          const msg = wasSubscribed
            ? "أوقفت اشتراكك في الموجز. ترجع أيّ وقت بكلمة *«اشتراك»*."
            : "ما كنت مشترك أصلاً. تقدر تشترك بكلمة *«اشتراك»*.";
          try {
            await sock.sendMessage(fromId, { text: msg + BRAND_FOOTER });
          } catch (err) {
            log.warn({ err: String(err) }, "unsubscribe ack failed");
          }
          continue;
        }

        try {
          await sock.sendPresenceUpdate("composing", fromId);
        } catch {}

        let reply;
        try {
          reply = await askTadry({
            text,
            fromId,
            history: recentHistory(fromId),
          });
        } catch (err) {
          log.error({ err: String(err) }, "askTadry failed");
          await sock.sendMessage(fromId, {
            text: "حدث خلل تقني. حاول مرّة أخرى بعد قليل.",
          });
          continue;
        }

        try {
          await sock.sendPresenceUpdate("paused", fromId);
        } catch {}

        try {
          await sendReply(sock, fromId, reply);
          log.info({ from: fromId, kind: reply.kind }, "replied");
        } catch (err) {
          log.error({ err: String(err) }, "send failed");
        }

        // Record the exchange for multi-turn context. Keep only textual
        // parts (the video/URLs don't help future retrieval).
        appendHistory(fromId, "user", text);
        if (reply.text && reply.text.trim().length > 0) {
          appendHistory(fromId, "assistant", reply.text);
        }
      } catch (err) {
        log.error({ err: String(err) }, "message handler outer");
      }
    }
  });
}

start().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
