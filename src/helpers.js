import {
  makeWASocket,
  useMultiFileAuthState,
  makeInMemoryStore,
  DisconnectReason
} from "@whiskeysockets/baileys";
import path from "path";
import fs from "fs/promises";
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
    browser: [`${deviceName} ${version}`, 'Desktop', version],// pongo version en el name xq la otra no se dónde verla.
  });
}

/**
 * Creates a new WhatsApp session or returns an existing one
 * @param {string} id - Session identifier
 * @param {object} logger - Pino logger instance
 * @param {string} dirName - Directory path
 * @returns {Promise<object>} Session object with sock, store, and getNewQr
 */
async function createSession(id, logger, dirName) {
  logger.debug("called createSession", id, dirName)
  if (sessions.has(id)) {
    logger.debug("session already exists, returning")
    return sessions.get(id);
  }

  const sessionDir = path.join(dirName, "sessionsData", id);
  // Ensure the directory exists
  await fs.mkdir(sessionDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir); // DO NOT USE IN PROD!!!! This function consumes a lot of IO. Only use its implementation as a guide. As I said earlier here
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
      } else {
        sessions.delete(id);
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
function deleteSession(sessionId) {
  sessions.delete(sessionId);
}

export {
  createSession,
  getActiveSessions,
  deleteSession,
  sessions
};