import {
  makeWASocket,
  makeInMemoryStore,
  DisconnectReason,
  BufferJSON
} from "@whiskeysockets/baileys";
import { useRedisAuthState, redisClient } from "./use_redis_auth_state.js"
import logger from './logger.js'
import version from './version.js'

// Map to store active sessions
const sessions = new Map(); // sessionId -> { socket, store }

// Map to track reconnection attempts for exponential backoff
const reconnectionAttempts = new Map(); // sessionId -> { attempts, lastAttempt, backoffMs }

/**
 * Calculate exponential backoff delay with jitter
 * @param {number} attempts - Number of reconnection attempts
 * @returns {number} Delay in milliseconds
 */
function calculateBackoff(attempts) {
  const baseDelay = 1000; // 1 second
  const maxDelay = 300000; // 5 minutes
  const delay = Math.min(baseDelay * Math.pow(2, attempts), maxDelay);
  return delay + Math.random() * 1000; // Add jitter
}

/**
 * Check if reconnection should be attempted based on backoff
 * @param {string} sessionId - Session identifier
 * @returns {boolean} Whether reconnection should be attempted
 */
function shouldAttemptReconnection(sessionId) {
  const reconnectInfo = reconnectionAttempts.get(sessionId);
  if (!reconnectInfo) return true; // First attempt
  
  const now = Date.now();
  const timeSinceLastAttempt = now - reconnectInfo.lastAttempt;
  return timeSinceLastAttempt >= reconnectInfo.backoffMs;
}

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

// Creates a Baileys store that persists to Redis
async function makeRedisStore(sessionId) {
  const store = makeInMemoryStore({ logger });

  const redisKey = `${sessionId}:store`;

  try {
    const dataStr = await redisClient.get(redisKey);
    if (dataStr) {
      store.fromJSON(JSON.parse(dataStr, BufferJSON.reviver));
    }
  } catch (err) {
    logger.error({ sessionId, err }, "Failed to load store from Redis");
  }

  const saveToRedis = async () => {
    try {
      await redisClient.set(redisKey, JSON.stringify(store.toJSON(), BufferJSON.replacer));
    } catch (err) {
      logger.error({ sessionId, err }, "Failed to save store to Redis");
    }
  };

  // Save store every 10 seconds
  setInterval(saveToRedis, 10000);

  return store;
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
  const store = await makeRedisStore(id);

  const sock = await makeConfiggedWASocket(id, state, store, saveCreds)

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
        logger.info({ id }, "Restart required by WA, reconnecting...");
        // After scanning the QR, WhatsApp will forcibly disconnect you, forcing a reconnect such that we can present the authentication credentials. This is not an error.
        // We must handle this creating a new socket, existing socket has been closed.
        
        // Clean up old socket before creating new one
        const oldSession = sessions.get(id);
        if (oldSession && oldSession.sock && oldSession.sock !== sock) {
          try {
            oldSession.sock.end();
          } catch (cleanupErr) {
            logger.warn({ id, error: cleanupErr }, "Error cleaning up old socket");
          }
        }
        
        const newSock = await makeConfiggedWASocket(id, state, store, saveCreds);
        sessions.set(id, {sock: newSock, store, getNewQr});
        
        // Reset backoff on successful connection
        reconnectionAttempts.delete(id);
      } else if (reason === DisconnectReason.loggedOut) {
        await deleteSession(id);
      } else if (
        reason === DisconnectReason.timedOut ||
        reason === DisconnectReason.connectionClosed ||
        reason === DisconnectReason.connectionLost ||
        reason === DisconnectReason.connectionReplaced
      ) {
        // Handle temporary connection issues by reconnecting with exponential backoff
        if (shouldAttemptReconnection(id)) {
          logger.warn({ id, reason }, "Connection lost, attempting to reconnect");
          
          // Clean up old socket before creating new one
          const oldSession = sessions.get(id);
          if (oldSession && oldSession.sock && oldSession.sock !== sock) {
            try {
              oldSession.sock.end();
            } catch (cleanupErr) {
              logger.warn({ id, error: cleanupErr }, "Error cleaning up old socket");
            }
          }
          
          // Update reconnection tracking
          const reconnectInfo = reconnectionAttempts.get(id) || { attempts: 0, lastAttempt: 0, backoffMs: 0 };
          reconnectInfo.attempts++;
          reconnectInfo.lastAttempt = Date.now();
          reconnectInfo.backoffMs = calculateBackoff(reconnectInfo.attempts);
          reconnectionAttempts.set(id, reconnectInfo);
          
          logger.info({ id, attempts: reconnectInfo.attempts, backoffMs: reconnectInfo.backoffMs }, "Scheduling reconnection with backoff");
          
          // Schedule reconnection with backoff
          setTimeout(async () => {
            try {
              const newSock = await makeConfiggedWASocket(id, state, store, saveCreds);
              sessions.set(id, {sock: newSock, store, getNewQr});
              logger.info({ id }, "Reconnection successful");
              // Reset backoff on successful connection
              reconnectionAttempts.delete(id);
            } catch (reconnectErr) {
              logger.error({ id, error: reconnectErr }, "Reconnection failed");
            }
          }, reconnectInfo.backoffMs);
        } else {
          logger.info({ id }, "Reconnection attempt skipped due to backoff");
        }
      } else {
        logger.warn({ id, reason }, "Socket closed with unknown reason");
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
  // Properly close socket before deletion
  const session = sessions.get(sessionId);
  if (session && session.sock) {
    try {
      session.sock.end();
    } catch (err) {
      logger.warn({ sessionId, error: err }, "Error closing socket during session deletion");
    }
  }
  
  sessions.delete(sessionId);
  reconnectionAttempts.delete(sessionId); // Clean up tracking
  await redisClient.del(sessionId); // Fixed: Await Redis deletion
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
  makeRedisStore,
  normalizeJid,
  restoreSessionsFromRedis
};
