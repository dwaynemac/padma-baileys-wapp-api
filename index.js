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
 * GET /sessions
 * Lists all active sessions.
 */
app.get("/sessions", (req, res) => {
  const activeSessions = Array.from(sessions.keys()).map(sessionId => {
    const { sock } = sessions.get(sessionId);
    return {
      id: sessionId,
      isLoggedIn: !!sock.user,
      user: sock.user ? {
        id: sock.user.id,
        name: sock.user.name
      } : null
    };
  });
  res.json(activeSessions);
});

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
 * Includes profilePicThumbObj, name, pushname, verifiedName, and shortName.
 * Uses Baileys methods to fetch additional contact details.
 */
app.get("/sessions/:sessionId/chats/:chatId/contact", requireSession, async (req, res) => {
  const { store, sock } = req.session;
  const { chatId } = req.params;

  try {
    // Get basic contact info from store
    let contact = store.contacts[chatId];
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    // Try to get chat info which might have more details
    const chat = store.chats.get(chatId);

    // Use Baileys to fetch additional contact information
    let profilePic = null;
    try {
      // Try to fetch profile picture URL
      profilePic = await sock.profilePictureUrl(chatId, 'image');
    } catch (e) {
      logger.info({ error: e.message }, 'Failed to fetch profile picture');
    }

    // Try to fetch contact status
    let status = null;
    try {
      status = await sock.fetchStatus(chatId);
    } catch (e) {
      logger.info({ error: e.message }, 'Failed to fetch status');
    }

    // Try to fetch business profile for business accounts
    let businessProfile = null;
    try {
      businessProfile = await sock.getBusinessProfile(chatId);
    } catch (e) {
      logger.info({ error: e.message }, 'Failed to fetch business profile');
    }

    // Check if the number is registered on WhatsApp
    let isOnWhatsApp = false;
    try {
      const [result] = await sock.onWhatsApp(chatId.split('@')[0]);
      isOnWhatsApp = result?.exists || false;
    } catch (e) {
      logger.info({ error: e.message }, 'Failed to check if number is on WhatsApp');
    }

    // Create enhanced contact with all required fields
    const enhancedContact = {
      ...contact,
      // Use chat name if contact name is not available
      name: contact.name || (chat ? chat.name : null),
      // Use notify as pushname if not available
      pushname: contact.pushname || contact.notify || null,
      // Use name or notify for these fields if not available
      verifiedName: contact.verifiedName || contact.name || contact.notify || null,
      shortName: contact.shortName || contact.name || contact.notify || null,
      // Ensure profilePicThumbObj is included with proper structure
      profilePicThumbObj: contact.profilePicThumbObj || (profilePic ? {
        eurl: profilePic,
        url: profilePic,
        tag: "0",
        id: chatId
      } : null),
      // Add additional information from Baileys
      status: status ? status.status : null,
      lastSeen: status ? status.lastSeen : null,
      // Add business profile information if available
      businessProfile: businessProfile || null,
      // Add WhatsApp registration status
      isOnWhatsApp: isOnWhatsApp
    };

    res.json(enhancedContact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

app.listen(PORT, () => logger.info(`PADMA Baileys API server 0.1.4 running on http://localhost:${PORT}`));
