// Tadry WhatsApp bot on Baileys (unofficial).
// - Connects to WhatsApp as the Tadry number via QR-code pairing (one-time)
// - Persists session in ./auth_info (mount a Railway volume here to survive restarts)
// - On each incoming user message, POSTs { text, from_id } to TADRY_API_URL
// - Renders the JSON reply into WhatsApp messages (text + video/link when present)
// - Rate-limit and refusal logic all live in /api/bot on tadry-web

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcodeTerminal from "qrcode-terminal";

const API_URL = process.env.TADRY_API_URL;
const API_SECRET = process.env.BOT_SHARED_SECRET || "";
const AUTH_DIR = process.env.AUTH_DIR || "./auth_info";

if (!API_URL) {
  console.error("Missing TADRY_API_URL env var. Point it at your tadry-web /api/bot endpoint.");
  process.exit(1);
}

const log = pino({ level: process.env.LOG_LEVEL || "info" });

async function askTadry({ text, fromId }) {
  const r = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bot-secret": API_SECRET,
    },
    body: JSON.stringify({ text, from_id: fromId }),
  });
  if (!r.ok) {
    throw new Error(`bot api ${r.status}: ${await r.text().catch(() => "")}`);
  }
  return r.json();
}

async function sendReply(sock, jid, reply) {
  // Order matters: send the answer text first, then attach the video/link
  // as a follow-up so WhatsApp doesn't visually swallow the text.
  if (reply.text && reply.text.trim().length > 0) {
    await sock.sendMessage(jid, { text: reply.text });
  }
  if (reply.video) {
    if (reply.video.is_mp4) {
      try {
        await sock.sendMessage(jid, {
          video: { url: reply.video.url },
          caption: reply.video.caption,
        });
      } catch (err) {
        log.warn({ err: String(err) }, "video send failed, falling back to link");
        await sock.sendMessage(jid, {
          text: `${reply.video.caption ? reply.video.caption + "\n" : ""}${reply.video.url}`,
        });
      }
    } else if (!reply.text?.includes(reply.video.url)) {
      // Link path — send as text so WhatsApp shows a preview.
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
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: log,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, log),
    },
    // We don't want the bot to appear "online" 24/7 — that's a spam signal.
    markOnlineOnConnect: false,
    printQRInTerminal: false,
    browser: ["Tadry Bot", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("\n=== SCAN THIS QR FROM YOUR TADRY WHATSAPP BUSINESS APP ===");
      console.log("Settings → Linked Devices → Link a Device\n");
      qrcodeTerminal.generate(qr, { small: true });
      console.log("\n(waiting for scan...)\n");
    }
    if (connection === "open") {
      log.info("connected to WhatsApp as Tadry");
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
        // Ignore our own messages and status broadcasts.
        if (m.key.fromMe) continue;
        if (m.key.remoteJid?.endsWith("@broadcast")) continue;
        if (!m.key.remoteJid || m.key.remoteJid.endsWith("@g.us")) continue; // no groups
        if (!m.key.id || !firstTime(m.key.id)) continue;

        const text =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          "";
        if (!text || typeof text !== "string" || text.trim().length === 0) continue;

        const fromId = m.key.remoteJid;
        log.info({ from: fromId, len: text.length }, "incoming");

        // Nudge WhatsApp UI to show "typing…" while we wait on the LLM.
        try {
          await sock.sendPresenceUpdate("composing", fromId);
        } catch {}

        let reply;
        try {
          reply = await askTadry({ text, fromId });
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
