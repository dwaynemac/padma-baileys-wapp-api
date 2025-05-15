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

async function makeConfiggedWASocket(state){
  const deviceName = process.env.DEVICE_NAME || "PADMA";
  return makeWASocket({
    logger,
    printQRInTerminal: false,
    auth: state,
    markOnlineOnConnect: false, // avoid blocking notifications on whatsapp app @see https://baileys.wiki/docs/socket/configuration#markonlineonconnect
    browser: [deviceName, 'Desktop', version],
  });
}

/**
 * Creates a new WhatsApp session or returns an existing one
 * @param {string} id - Session identifier
 * @param {object} logger - Pino logger instance
 * @returns {Promise<object>} Session object with sock, store, and getNewQr
 */
async function createSession(id, logger) {
  logger.debug("called createSession", id)
  if (sessions.has(id)) {
    logger.debug("session already exists, returning")
    return sessions.get(id);
  }

  const { state, saveCreds } = await useRedisAuthState(id);
  const store = makeInMemoryStore({ logger });

  const sock = await makeConfiggedWASocket(state)

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
      if (reason === DisconnectReason.restartRequired) {
        // After scanning the QR, WhatsApp will forcibly disconnect you, forcing a reconnect such that we can present the authentication credentials. This is not an error.
        // We must handle this creating a new socket, existing socket has been closed.
        const newSock = await makeConfiggedWASocket(state);
        store.bind(newSock.ev);
        newSock.ev.on("creds.update", saveCreds);
        sessions.set(id, {sock: newSock, store, getNewQr});
      } else if (reason === DisconnectReason.loggedOut) {
        await deleteSession(id);
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
 * @param {string} dirName - Directory path (optional)
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
  normalizeJid
};
