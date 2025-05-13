// A minimal WhatsApp‐API‑like HTTP server using Baileys

import express from "express";
import qrcode from "qrcode";
import path from "path";
import { fileURLToPath } from "url";
import {
  createSession, 
  deleteSession,
  getActiveSessions,
  sessions
} from "./helpers.js";
import {
  requireSession,
  apiKeyAuth
} from './middlewares.js'
import logger from './logger.js'
import version from './version.js'

// ---------- Globals ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ---------- Express API ----------
const app = express();
app.use(express.json());

/*  AUTHENTICATION
 All requests should have x-api-key header with valid api key.
  */
const API_KEY = process.env.API_KEY || "your-secure-api-key";
app.use(apiKeyAuth(API_KEY));

app.get("/", (req, res) => {
  res.json({ status: "SERVER RUNNING"})
})

/**
 * GET /sessions
 * Lists all active sessions.
 */
app.get("/sessions", (req, res) => {
  const activeSessions = getActiveSessions().map(sessionId => {
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
 * --
 */
app.post("/sessions/:sessionId", async (req, res) => {
  logger.debug({sessionId: req.params.sessionId}, 'POST /sessions/:sessionId')
  const { sessionId } = req.params;
  const { sock, getNewQr } = await createSession(sessionId, logger, __dirname);
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
  logger.debug({sessionId: req.params.sessionId}, 'GET /sessions/:sessionId/chats')
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
  logger.debug({sessionId: req.params.sessionId}, 'GET /sessions/:sessionId/chats/:chatId/messages')
  const { sock, store } = req.session;
  const { chatId } = req.params;
  const limit = Number(req.query.limit) || 50;
  try {
    // Pass a cursor with 'before' property set to undefined to get the most recent messages
    const msgs = await store.loadMessages(chatId, limit, { before: undefined });
    res.json(msgs);
  } catch (err) {
    logger.error({err}, 'Failed to load messages')
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
      verifiedName: contact.verifiedName,
      shortName: contact.shortName,
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
  deleteSession(sessionId);
  res.json({ status: "logged_out" });
});

app.listen(PORT, () => logger.info(`PADMA Baileys API server ${version} running on http://localhost:${PORT}`));
