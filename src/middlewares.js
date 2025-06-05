import { sessions } from './helpers.js'
import logger from './logger.js'

/**
 * Express middleware to ensure a session exists
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {function} next - Express next function
 */
function requireSession(req, res, next) {
  const { sessionId } = req.params;
  if (!sessions.has(sessionId)) return res.status(404).json({ error: "Session not found" });
  req.session = sessions.get(sessionId);
  next();
}

/**
 * Express middleware for API key authentication
 * @param {string} apiKey - The API key to validate against
 * @returns {function} Express middleware function
 */
function apiKeyAuth(apiKey) {
  return (req, res, next) => {
    const key = req.headers['x-api-key'];
    if (!key || key !== apiKey) {
      return res.status(401).json({ error: 'Api key not found or invalid' });
    }
    next();
  };
}

/**
 * Express middleware to log all requests at debug level
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {function} next - Express next function
 */
function requestLogger(req, res, next) {
  logger.debug({
    method: req.method,
    url: req.url,
    query: req.query,
    ip: req.ip
  }, `${req.method} ${req.url}`);
  next();
}

export { requireSession, apiKeyAuth, requestLogger };
