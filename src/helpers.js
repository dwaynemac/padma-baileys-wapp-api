import {
  makeWASocket,
  makeInMemoryStore,
  DisconnectReason
} from "@whiskeysockets/baileys";
import { useRedisAuthState, redisClient } from "./use_redis_auth_state.js"
import logger from './logger.js'
import version from './version.js'

// Map to store active sessions
const sessions = new Map(); // sessionId -> { socket, store }

/**
 * Restores all sessions from Redis when the server starts
 * @returns {Promise<void>}
 */
async function restoreSessionsFromRedis() {
  try {
    logger.info("Restoring sessions from Redis...");

    // Get all keys in Redis
    const keys = await redisClient.keys("*");

    // Filter keys that have 'creds' field (these are session IDs)
    const sessionIds = [];
    for (const key of keys) {
      const hasCreds = await redisClient.hExists(key, 'creds');
      if (hasCreds) {
        sessionIds.push(key);
      }
    }

    logger.info(`Found ${sessionIds.length} sessions in Redis`);

    // Restore each session
    for (const sessionId of sessionIds) {
      try {
        logger.info(`Restoring session: ${sessionId}`);
        await createSession(sessionId, logger);
        logger.info(`Session restored: ${sessionId}`);
      } catch (err) {
        logger.error({ sessionId, error: err }, "Failed to restore session");
      }
    }

    logger.info("Session restoration complete");
  } catch (err) {
    logger.error({ error: err }, "Failed to restore sessions from Redis");
  }
}

async function makeConfiggedWASocket(state){
  const deviceName = process.env.DEVICE_NAME || "PADMA";
  return makeWASocket({
    logger,
    printQRInTerminal: false,
    auth: state,
    markOnlineOnConnect: false, // avoid blocking notifications on whatsapp app @see https://baileys.wiki/docs/socket/configuration#markonlineonconnect
    browser: [deviceName, 'Desktop', version],
    // Add timeout configurations to prevent "Timed Out" errors
    defaultQueryTimeoutMs: 60000, // 1 minute timeout for queries
    connectTimeoutMs: 60000, // 1 minute timeout for connection
    keepAliveIntervalMs: 25000, // 25 seconds ping-pong interval
    retryRequestDelayMs: 500, // 500ms delay between retries
    maxMsgRetryCount: 5, // Maximum retry count for messages
  });
}

/**
 * Creates a new WhatsApp session or returns an existing one
 * @param {string} id - Session identifier
 * @returns {Promise<object>} Session object with sock, store, and getNewQr
 */
async function createSession(id) {
  logger.debug("called createSession", id)
  if (sessions.has(id)) {
    logger.debug("session already exists, returning")
    return sessions.get(id);
  }

  const { state, saveCreds } = await useRedisAuthState(id);
  const store = makeInMemoryStore({ logger });

  const sock = await makeConfiggedWASocket(state)

  store.bind(sock.ev);

  // Add global error handler to prevent unhandled promise rejections from crashing the server
  sock.ev.on("error", (err) => {
    logger.error({ id, error: err }, "Socket encountered an error");
    // Don't delete the session, just log the error
  });

  // Persist credentials on update
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on('messaging-history.set', ({
                                         chats: newChats,
                                         contacts: newContacts,
                                         messages: newMessages,
                                         syncType
                                       }) => {
    logger.debug({ id, chats: newChats, contacts: newContacts, messages: newMessages, syncType }, "Received 'messaging-history.set'")
    // handle the chats, contacts and messages
    newChats.forEach(chat => { store.chats.upsert(chat, 'append')})
    newContacts.forEach(contact => { store.contacts.upsert(contact, 'append')})
    newMessages.forEach(message => { store.messages.upsert(message, 'append')})
  })

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
      if (reason === DisconnectReason.restartRequired) {
        // After scanning the QR, WhatsApp will forcibly disconnect you, forcing a reconnect such that we can present the authentication credentials. This is not an error.
        // We must handle this creating a new socket, existing socket has been closed.
        const newSock = await makeConfiggedWASocket(state);
        store.bind(newSock.ev);

        // Add global error handler to the new socket as well
        newSock.ev.on("error", (err) => {
          logger.error({ id, error: err }, "New socket (restart) encountered an error");
          // Don't delete the session, just log the error
        });

        newSock.ev.on("creds.update", saveCreds);
        sessions.set(id, {sock: newSock, store, getNewQr});
      } else if (reason === DisconnectReason.loggedOut) {
        await deleteSession(id);
      } else if (reason === DisconnectReason.timedOut) {
        // Handle timeout errors by reconnecting instead of deleting the session
        logger.warn({ id }, "Connection timed out, attempting to reconnect");
        const newSock = await makeConfiggedWASocket(state);
        store.bind(newSock.ev);

        // Add global error handler to the new socket as well
        newSock.ev.on("error", (err) => {
          logger.error({ id, error: err }, "New socket (timeout recovery) encountered an error");
          // Don't delete the session, just log the error
        });

        newSock.ev.on("creds.update", saveCreds);
        sessions.set(id, {sock: newSock, store, getNewQr});
      } else {
        await deleteSession(id);
      }
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

/**
 * Get all active sessions
 * @returns {Array} Array of session IDs
 */
function getActiveSessions() {
  return Array.from(sessions.keys());
}

/**
 * Delete a session
 * @param {string} sessionId - Session identifier
 */
async function deleteSession(sessionId) {
  sessions.delete(sessionId);
  redisClient.del(sessionId)
}

/**
 * Normaliza un JID de WhatsApp eliminando la parte “:device” si existe.
 * Ej.: "12345:2@s.whatsapp.net" => "12345@s.whatsapp.net"
 */
const normalizeJid = (jid) => typeof jid === 'string' ? jid.replace(/:[^@]+@/, '@') : jid;


export {
  createSession,
  getActiveSessions,
  deleteSession,
  sessions,
  normalizeJid,
  restoreSessionsFromRedis
};
