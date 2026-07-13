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
// Derive /api/brief URL from /api/bot so we don't need a second env var.
const BRIEF_URL = API_URL ? API_URL.replace(/\/api\/bot\/?$/, "/api/brief") : "";

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

const GREETING = [
  "*تدري؟*",
  "_بوت جيوسياسة الخليج وإيران. أجيب من الأرشيف بمصادر موثّقة — لا اختراع ولا تلفيق._",
  "",
  "اسألني عن أيّ موضوع أو حلقة. *مثلاً:*",
  "",
  "› *«الحلقة 53»* — لأرسل لك الحلقة مباشرةً.",
  "› *«متى سقط الأسد؟»* — للإجابة بمصادرها الأصليّة.",
  "› *«سوريا»* — لأعرض ما غطّاه تدري، وتختار الزاوية.",
  "› *«موجز»* — لموجز اليوم في الخليج والمنطقة.",
  "› *«اشتراك»* — ليوصلك الموجز كلّ صباح الساعة ٨ بتوقيت الخليج.",
  "",
  "— *tadrygcc.com*",
].join("\n");

const BRAND_FOOTER = "\n\n—\n_اسأل تدري؟ · tadrygcc.com_";

// ------------------------------------------------------------
// Subscribers: persistent set of jids that want the daily push
// ------------------------------------------------------------

let subscribers = new Set();

async function loadSubscribers() {
  try {
    const raw = await fs.readFile(SUBSCRIBERS_FILE, "utf8");
    const arr = JSON.parse(raw);
    subscribers = new Set(Array.isArray(arr) ? arr : []);
    log.info(`loaded ${subscribers.size} subscriber(s) from ${SUBSCRIBERS_FILE}`);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      log.info(`no subscribers file at ${SUBSCRIBERS_FILE} yet — starting empty`);
    } else {
      log.warn({ err: String(err) }, "failed to load subscribers — starting empty");
    }
    subscribers = new Set();
  }
}

async function saveSubscribers() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(
      SUBSCRIBERS_FILE,
      JSON.stringify([...subscribers], null, 2)
    );
  } catch (err) {
    log.error({ err: String(err) }, "failed to save subscribers");
  }
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
  for (const jid of subscribers) {
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

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
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
        log.info({ from: fromId, len: text.length }, "incoming");

        // First-time greeting. Send once per jid per bot lifetime.
        if (!greetedUsers.has(fromId)) {
          greetedUsers.add(fromId);
          try {
            await sock.sendMessage(fromId, { text: GREETING });
          } catch (err) {
            log.warn({ err: String(err) }, "greeting failed");
          }
        }

        // Subscribe / unsubscribe handled locally — never hits /api/bot.
        // Idempotent by design so repeated «اشتراك» from the same person
        // reassures them rather than errors.
        if (isSubscribeIntent(text)) {
          const wasNew = !subscribers.has(fromId);
          subscribers.add(fromId);
          await saveSubscribers();
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
