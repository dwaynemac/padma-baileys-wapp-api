// A minimal WhatsApp‐API‑like HTTP server using Baileys
// ----------------------------------------------------------
// Requirements (add in package.json):
//   "@whiskeysockets/baileys": "^6.7.0",
//   "express": "^4.19.0",
//   "qrcode": "^1.5.3"
// Run with Node 18 +   (package.json must include { "type": "module" })
// DISCLAIMER: Demo‑only. Add persistence, auth, TLS & error‑handling for production.

import express from "express";
import qrcode from "qrcode";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
} from "@whiskeysockets/baileys";
import P from "pino";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";

// ---------- Globals ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const sessions = new Map(); // sessionId -> { socket, store }
const logger = P({ level: "info" });

// ---------- Helpers ----------
async function createSession(id) {
  if (sessions.has(id)) return sessions.get(id);
  const sessionDir = path.join(__dirname, "sessionsData", id);
  // Ensure the directory exists
  await fs.mkdir(sessionDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  const store = makeInMemoryStore({ logger });

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: state,
  });

  store.bind(sock.ev);

  // Persist credentials on update
  sock.ev.on("creds.update", saveCreds);

  // Bubble QR to waiting HTTP call
  let qrResolver;
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && qrResolver) {
      qrResolver(qr);
      qrResolver = null;
    }
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      logger.warn({ id, reason }, "Socket closed");
      sessions.delete(id);
    }
  });

  // Utility function that waits for a fresh QR string
  function getNewQr() {
    return new Promise((resolve) => {
      qrResolver = resolve;
    });
  }

  const session = { sock, store, getNewQr };
  sessions.set(id, session);
  return session;
}

function requireSession(req, res, next) {
  const { sessionId } = req.params;
  if (!sessions.has(sessionId)) return res.status(404).json({ error: "Session not found" });
  req.session = sessions.get(sessionId);
  next();
}

// ---------- Express API ----------
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "SERVER RUNNING"})
})

/**
 * POST /sessions/:sessionId
 * Starts a new session (or resumes) and returns a QR code (PNG‑base64) if not yet authenticated.
 */
app.post("/sessions/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { sock, getNewQr } = await createSession(sessionId);
  if (sock.user) {
    return res.json({ status: "already_logged_in" });
  }
  const qrString = await getNewQr();
  const qrPng = await qrcode.toDataURL(qrString);
  res.json({ status: "qr", qr: qrPng });
});

/**
 * GET /sessions/:sessionId/chats
 * Lists recent chats with basic metadata.
 */
app.get("/sessions/:sessionId/chats", requireSession, (req, res) => {
  const { store } = req.session;
  const chats = store.chats
    .all()
    .map(({ id, name, unreadCount, conversationTimestamp }) => ({
      id,
      name,
      unreadCount,
      conversationTimestamp,
    }))
    .sort((a, b) => b.conversationTimestamp - a.conversationTimestamp);
  res.json(chats);
});

/**
 * GET /sessions/:sessionId/chats/:chatId/messages?limit=50
 * Returns the most recent N messages from a chat.
 */
app.get("/sessions/:sessionId/chats/:chatId/messages", requireSession, async (req, res) => {
  const { sock } = req.session;
  const { chatId } = req.params;
  const limit = Number(req.query.limit) || 50;
  try {
    const msgs = await sock.store.loadMessages(chatId, limit);
    res.json(msgs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /sessions/:sessionId/chats/:chatId/contact
 * Returns contact information for the chat ID (for individual or group participants).
 */
app.get("/sessions/:sessionId/chats/:chatId/contact", requireSession, (req, res) => {
  const { store } = req.session;
  const { chatId } = req.params;
  const contact = store.contacts[chatId];
  if (!contact) return res.status(404).json({ error: "Contact not found" });
  res.json(contact);
});

/**
 * DELETE /sessions/:sessionId
 * Logs out & removes the session dir.
 */
app.delete("/sessions/:sessionId", requireSession, async (req, res) => {
  const { sessionId } = req.params;
  const { sock } = req.session;
  await sock.logout();
  sessions.delete(sessionId);
  res.json({ status: "logged_out" });
});

app.listen(PORT, () => logger.info(`PADMA Baileys API server 0.1.1 running on http://localhost:${PORT}`));
