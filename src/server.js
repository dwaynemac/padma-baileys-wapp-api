// A minimal WhatsApp‐API‑like HTTP server using Baileys

import logger from './logger.js'
import version from './version.js'
import express from "express";
import qrcode from "qrcode";
import {
  createSession, 
  deleteSession,
  getActiveSessions,
  sessions,
  normalizeJid,
  restoreSessionsFromRedis
} from "./helpers.js";
import {
  requireSession,
  apiKeyAuth,
  requestLogger
} from './middlewares.js'

// ---------- Globals ----------
const PORT = process.env.PORT || 3000;

// ---------- Express API ----------
const app = express();
app.use(express.json());
app.use(requestLogger);

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
  const { sessionId } = req.params;
  const { sock, store } = await createSession(sessionId);

  let isHealthy = false;
  if (sock.user) {
    try {
      await store.chats.all(); // check if we can load chats
      isHealthy = true;
      logger.debug({ sessionId }, "Session health check passed");
    } catch (healthErr) {
      logger.warn({ sessionId, error: healthErr }, "Session health check failed");
      isHealthy = false;
    }
  }

  if (isHealthy) {
    return res.json({ status: "already_logged_in" });
  } else {
    // Generate QR without deleting/recreating session to avoid race conditions
    logger.info({ sessionId }, "Session needs authentication, generating QR");
    const { getNewQr } = await createSession(sessionId);
    const qrString = await getNewQr();
    const qrPng = await qrcode.toDataURL(qrString);
    return res.json({ status: "qr", qr: qrPng });
  }
});

/**
 * GET /sessions/:sessionId
 * Returns information about a specific session.
 */
app.get("/sessions/:sessionId", requireSession, (req, res) => {
  const { sessionId } = req.params;
  const { sock } = req.session;

  res.json({
    id: sessionId,
    isLoggedIn: !!sock.user,
    user: sock.user ? {
      id: sock.user.id,
      name: sock.user.name
    } : null
  });
});

/**
 * DELETE /sessions/:sessionId
 * Logs out & removes the session dir.
 */
app.delete("/sessions/:sessionId", requireSession, async (req, res) => {
  const { sessionId } = req.params;
  const { sock } = req.session;
  try {
    await sock.logout();
    await deleteSession(sessionId);
    res.json({ status: "logged_out" });
  } catch (err) {
    logger.error({err}, 'Failed to logout')
    res.status(500).json({ error: err.message });
  }
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
 * GET /sessions/:sessionId/chats/:chatId
 * Returns details of a single chat (not including messages).
 */
app.get("/sessions/:sessionId/chats/:chatId", requireSession, (req, res) => {
  const { store, sock } = req.session;
  const { chatId } = req.params;

  // Get the chat from the store
  const chat = store.chats.get(chatId);

  if (!chat) {
    return res.status(404).json({ error: "Chat not found" });
  }

  /*
  const labelAssociations = req.session.store.getChatLabels(chatId) || [];
  const labels = labelAssociations.map((assoc) => {
    const label = req.session.store.labels.get(assoc.labelId);
    if (label) {
      return {name: label.name, color: label.color ?? null};
    }
  });
   */
  const labels = [];

  // Check if this is a self-chat (chat with myself)
  const isMe = sock.user && normalizeJid(chatId) === normalizeJid(sock.user.id);

  // Return chat details (excluding messages)
  res.json({
    id: chat.id,
    name: chat.name,
    unreadCount: chat.unreadCount,
    conversationTimestamp: chat.conversationTimestamp,
    isGroup: chat.isGroup,
    participant: chat.participant,
    ephemeralExpiration: chat.ephemeralExpiration,
    ephemeralSettingTimestamp: chat.ephemeralSettingTimestamp,
    mute: chat.mute,
    pin: chat.pin,
    isMe: isMe,
    labels: labels
  });
});



/**
 * GET /sessions/:sessionId/chats/:chatId/messages?limit=50
 * Returns the most recent N messages from a chat.
 */
app.get("/sessions/:sessionId/chats/:chatId/messages", requireSession, async (req, res) => {
  const { store } = req.session;
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
 * POST /sessions/:sessionId/chats/:chatId/messages
 * Sends a new message to a chat.
 */
app.post("/sessions/:sessionId/chats/:chatId/messages", requireSession, async (req, res) => {
  const { sock } = req.session;
  const { chatId } = req.params;
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: "Message text is required" });
  }

  try {
    // Send the message
    const result = await sock.sendMessage(chatId, { text });

    // Return the message ID and other relevant information
    res.status(201).json({
      status: "sent",
      messageId: result.key.id,
      timestamp: result.messageTimestamp,
      message: text
    });
  } catch (err) {
    logger.error({err}, 'Failed to send message')
    res.status(500).json({ error: err.message });
  }
});

// Restore sessions from Redis before starting the server
(async () => {
  try {
    await restoreSessionsFromRedis();
    app.listen(PORT, () => logger.info(`PADMA Baileys API server ${version} running`));
  } catch (err) {
    logger.error({ error: err }, "Failed to start server");
    process.exit(1);
  }
})();
