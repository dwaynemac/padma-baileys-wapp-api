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
        await createSession(sessionId);
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

// Creates and configures a Baileys socket for the given session
// `sessionId` is used purely for logging & debugging purposes
async function makeConfiggedWASocket(sessionId, state, store, saveCreds){
  const deviceName = process.env.DEVICE_NAME || "PADMA";
  const sock = makeWASocket({
    logger,
    printQRInTerminal: false,
    auth: state,
    markOnlineOnConnect: false, // avoid blocking notifications on whatsapp app @see https://baileys.wiki/docs/socket/configuration#markonlineonconnect
    browser: [deviceName, 'Desktop', version],
    syncFullHistory: true,                // pide todo el historial
    fireInitQueries: true,                 // dispara las queries de inicio
    // Add timeout configurations to prevent "Timed Out" errors
    defaultQueryTimeoutMs: 60000, // 1 minute timeout for queries
    connectTimeoutMs: 60000, // 1 minute timeout for connection
    keepAliveIntervalMs: 25000, // 25 seconds ping-pong interval
    retryRequestDelayMs: 500, // 500ms delay between retries
    maxMsgRetryCount: 5, // Maximum retry count for messages
  });

  store.bind(sock.ev);

  // Add global error handler to the new socket as well
  sock.ev.on("error", (err) => {
    // include session id so we know which connection failed
    logger.error({ id: sessionId, error: err }, "New socket (timeout recovery) encountered an error");
    // Don't delete the session, just log the error
  });

  sock.ev.on("creds.update", saveCreds);

  return sock
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

  const sock = await makeConfiggedWASocket(id, state, store, saveCreds)

  // Bubble QR to waiting HTTP call
  let qrResolver;
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && qrResolver) {
      logger.debug({ id, qr }, "QR code received for session");
      qrResolver(qr);
      qrResolver = null;
    }
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      
      logger.warn({ id, connection, reason, shouldReconnect, error: lastDisconnect?.error }, "Socket connection closed");

      if (reason === DisconnectReason.restartRequired) {
        logger.info({ id }, "Restart required by WA, attempting to reconnect...");
        // After scanning the QR, WhatsApp will forcibly disconnect you, forcing a reconnect such that we can present the authentication credentials. This is not an error.
        // We must handle this creating a new socket, existing socket has been closed.
        try {
          const newSock = await makeConfiggedWASocket(id, state, store, saveCreds);
          sessions.set(id, {sock: newSock, store, getNewQr});
          logger.info({ id }, "Reconnected successfully after restartRequired.");
        } catch (err) {
          logger.error({ id, err }, "Failed to reconnect after restartRequired.");
          // Decide if session should be deleted or retried further
        }
      } else if (reason === DisconnectReason.loggedOut) {
        logger.info({ id }, "Logged out by WA, deleting session.");
        await deleteSession(id);
      } else if (
        reason === DisconnectReason.timedOut ||
        reason === DisconnectReason.connectionClosed ||
        reason === DisconnectReason.connectionLost ||
        reason === DisconnectReason.connectionReplaced
      ) {
        logger.warn({ id, reason }, "Temporary connection issue, attempting to reconnect...");
        try {
          const newSock = await makeConfiggedWASocket(id, state, store, saveCreds);
          sessions.set(id, {sock: newSock, store, getNewQr});
          logger.info({ id }, "Reconnected successfully after temporary issue.");
        } catch (err) {
          logger.error({ id, err, reason }, "Failed to reconnect after temporary issue.");
          // Potentially add a retry mechanism with backoff here instead of immediate deletion
          // For now, we are not deleting the session, allowing Redis to persist it for a later manual/automatic restore.
        }
      } else {
        logger.error({ id, reason, error: lastDisconnect?.error }, "Socket closed with unhandled or unknown reason. Attempting to reconnect as a fallback.");
        // Fallback: attempt to reconnect for unknown reasons rather than deleting session
        try {
          const newSock = await makeConfiggedWASocket(id, state, store, saveCreds);
          sessions.set(id, {sock: newSock, store, getNewQr});
          logger.info({ id }, "Reconnected successfully after unknown disconnection reason.");
        } catch (err) {
          logger.error({ id, err, reason }, "Failed to reconnect after unknown disconnection reason.");
          // As a last resort, if reconnection fails even for unknown reasons,
          // we might consider deleting the session or marking it as unhealthy.
          // For now, we are not deleting the session.
        }
      }
    } else if (connection === "open") {
      logger.info({ id, user: sock.user?.id }, "Socket connection opened successfully.");
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
