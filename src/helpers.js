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

/**
 * Creates and configures a Baileys socket para la sesión dada y maneja el QR correctamente
 * @param {string} id - Session identifier
 * @param {object} state - Auth state
 * @param {object} store - In-memory store
 * @param {function} saveCreds - Function to save credentials
 * @param {function} onQr - Callback para QR (resolve de la promesa)
 * @returns {Promise<object>} The configured socket
 */
async function makeConfiggedWASocket(id, state, store, saveCreds, onQr) {
  logger.debug("Creating and configuring WA socket with connection handler...");
  const deviceName = process.env.DEVICE_NAME || "PADMA";
  const sock = makeWASocket({
    logger,
    printQRInTerminal: false,
    auth: state,
    markOnlineOnConnect: false,
    browser: [deviceName, 'Desktop', version],
    syncFullHistory: true,
    fireInitQueries: true,
    defaultQueryTimeoutMs: 60000,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 500,
    maxMsgRetryCount: 5,
  });

  store.bind(sock.ev);

  sock.ev.on("error", (err) => {
    logger.error({ id, error: err }, "New socket (timeout recovery) encountered an error");
  });

  sock.ev.on("creds.update", saveCreds);

  // Manejo de QR
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && typeof onQr === 'function') {
      onQr(qr); // Resuelve la promesa de getNewQr
    }
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      logger.warn({ id, reason }, "Socket closed");
      // Antes de reconectar, verifica si la sesión sigue activa
      if (!sessions.has(id)) {
        logger.info({ id }, "Session was deleted, not reconnecting");
        return;
      }
      // Evitar recursión si el socket está esperando QR (no autenticado)
      if (reason === DisconnectReason.restartRequired && !qr) {
        logger.info("Restart required by WA, reconnecting...");
        const newSock = await makeConfiggedWASocket(id, state, store, saveCreds, onQr);
        sessions.set(id, {sock: newSock, store, getNewQr: () => new Promise(r => onQr = r)});
      } else if (reason === DisconnectReason.loggedOut) {
        await deleteSession(id);
      } else if (
        (reason === DisconnectReason.timedOut ||
        reason === DisconnectReason.connectionClosed ||
        reason === DisconnectReason.connectionLost ||
        reason === DisconnectReason.connectionReplaced) && !qr
      ) {
        logger.warn({ id, reason }, "Connection lost, attempting to reconnect");
        const newSock = await makeConfiggedWASocket(id, state, store, saveCreds, onQr);
        sessions.set(id, {sock: newSock, store, getNewQr: () => new Promise(r => onQr = r)});
      } else {
        logger.warn({ id, reason }, "Socket closed with unknown reason");
        await deleteSession(id);
      }
    }
  });

  return sock;
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

  // Variable para guardar el resolve de la promesa QR
  let qrResolver = null;

  // Utility function que espera por un QR nuevo
  function getNewQr() {
    return new Promise((resolve) => {
      qrResolver = resolve;
    });
  }

  // Crear socket y pasar el resolve de QR
  const sock = await makeConfiggedWASocket(id, state, store, saveCreds, (qr) => {
    if (qrResolver) {
      qrResolver(qr);
      qrResolver = null;
    }
  });

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
