// A minimal WhatsApp‐API‑like HTTP server using Baileys

import express from "express";
import qrcode from "qrcode";
import {
  createSession, 
  deleteSession,
  getActiveSessions,
  sessions,
  normalizeJid
} from "./helpers.js";
import {
  requireSession,
  apiKeyAuth
} from './middlewares.js'
import logger from './logger.js'
import version from './version.js'

// ---------- Globals ----------
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
  const { sock, getNewQr, store } = await createSession(sessionId, logger);

  let isHealthy = false;
  if (sock.user) {
    try {
      await store.chats.all(); // check if we can load chats
      isHealthy = true;
    } catch {}
  }

  if (isHealthy) {
    return res.json({ status: "already_logged_in" });
  } else {
    // Session is broken—delete and restart session for clean auth flow
    await deleteSession(sessionId);
    const { sock: newSock, getNewQr: newGetNewQr } = await createSession(sessionId, logger);
    const qrString = await newGetNewQr();
    const qrPng = await qrcode.toDataURL(qrString);
    return res.json({ status: "qr", qr: qrPng });
  }
});

app.put("/sessions/:sessionId/chats/refresh", requireSession, async (req, res) => {
  logger.debug({sessionId: req.params.sessionId}, 'PUT /sessions/:sessionId/chats/refresh')
  const { store, sock } = req.session;
  try {
    // Get all chats
    const chats = store.chats.all();

    if (chats.length === 0) {
      logger.info('No chats found in store, attempting to fetch chats from WhatsApp');

      // If we have no chats, we need to trigger a sync with WhatsApp
      // One way to do this is to listen for the 'messaging-history.set' event
      // which is emitted when WhatsApp sends chat history

      // We'll create a promise that resolves when we receive chats
      const waitForChats = new Promise((resolve, reject) => {
        // Set a timeout to avoid hanging indefinitely
        const timeout = setTimeout(() => {
          // Remove the listener before rejecting to avoid memory leaks
          sock.ev.off('messaging-history.set', listener);
          reject(new Error('Timed out waiting for chats'));
        }, 15000); // 15 seconds timeout

        // Listen for the messaging-history.set event
        const listener = (data) => {
          if (data && data.chats && data.chats.length > 0) {
            clearTimeout(timeout);
            sock.ev.off('messaging-history.set', listener);
            resolve(data.chats);
          }
        };

        // Listen for the chats.upsert event as an alternative
        const upsertListener = (chats) => {
          if (chats && chats.length > 0) {
            clearTimeout(timeout);
            sock.ev.off('messaging-history.set', listener);
            sock.ev.off('chats.upsert', upsertListener);
            resolve(chats);
          }
        };

        sock.ev.on('messaging-history.set', listener);
        sock.ev.on('chats.upsert', upsertListener);

        // Trigger a refresh by requesting the chat list
        // This should trigger WhatsApp to send us the chat history
        logger.info('Triggering chat sync...');

        // There's no direct method to fetch all chats, but we can try to trigger
        // the sync by using some of the available methods

        // We'll try multiple methods to increase our chances of success
        (async () => {
          try {
            // Method 1: Try to fetch status which might trigger chat sync
            await sock.fetchStatus('status@broadcast');
            logger.info('Fetched status');
          } catch (e) {
            logger.warn({err: e}, 'Failed to fetch status');
          }

          try {
            // Method 2: Try to check if a number is on WhatsApp
            // This might trigger a sync
            const [result] = await sock.onWhatsApp('1234567890');
            logger.info('Checked if number is on WhatsApp');
          } catch (e) {
            logger.warn({err: e}, 'Failed to check if number is on WhatsApp');
          }

          // If we have a user, try to fetch their status
          if (sock.user && sock.user.id) {
            try {
              await sock.fetchStatus(sock.user.id);
              logger.info('Fetched user status');
            } catch (e) {
              logger.warn({err: e}, 'Failed to fetch user status');
            }
          }
        })();
      });

      try {
        await waitForChats;
        logger.info('Successfully fetched chats from WhatsApp');
      } catch (syncErr) {
        logger.warn({err: syncErr}, 'Failed to sync chats from WhatsApp');
        // Even if we fail to sync, we'll continue with any chats we might have now
      }
    }

    // Get chats again (they might have been updated)
    const updatedChats = store.chats.all();

    // For each chat, load the most recent messages
    const limit = 50; // Adjust this value as needed
    let loadedChatsCount = 0;

    for (const chat of updatedChats) {
      try {
        await store.loadMessages(chat.id, limit, { before: undefined });
        loadedChatsCount++;
      } catch (chatErr) {
        logger.warn({chatId: chat.id, err: chatErr}, 'Failed to fetch history for chat');
        // Continue with other chats even if one fails
      }
    }

    res.json({ 
      status: "ok",
      chatsCount: updatedChats.length,
      loadedChatsCount: loadedChatsCount
    });
  } catch (err) {
    logger.error({err}, 'Failed to fetch history')
    res.status(500).json({ error: err.message });
  }
})


/**
 * GET /sessions/:sessionId
 * Returns information about a specific session.
 */
app.get("/sessions/:sessionId", requireSession, (req, res) => {
  logger.debug({sessionId: req.params.sessionId}, 'GET /sessions/:sessionId')
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
  logger.debug({sessionId: req.params.sessionId}, 'DELETE /sessions/:sessionId')
  const { sessionId } = req.params;
  const { sock } = req.session;
  try {
    await sock.logout();
    await deleteSession(sessionId, redisClient);
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
 * GET /sessions/:sessionId/chats/:chatId
 * Returns details of a single chat (not including messages).
 */
app.get("/sessions/:sessionId/chats/:chatId", requireSession, (req, res) => {
  logger.debug({sessionId: req.params.sessionId, chatId: req.params.chatId}, 'GET /sessions/:sessionId/chats/:chatId')
  const { store, sock } = req.session;
  const { chatId } = req.params;

  // Get the chat from the store
  const chat = store.chats.get(chatId);

  if (!chat) {
    return res.status(404).json({ error: "Chat not found" });
  }

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
    isMe: isMe
  });
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
 * POST /sessions/:sessionId/chats/:chatId/messages
 * Sends a new message to a chat.
 */
app.post("/sessions/:sessionId/chats/:chatId/messages", requireSession, async (req, res) => {
  logger.debug({sessionId: req.params.sessionId, chatId: req.params.chatId}, 'POST /sessions/:sessionId/chats/:chatId/messages')
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

app.listen(PORT, () => logger.info(`PADMA Baileys API server ${version} running`));
