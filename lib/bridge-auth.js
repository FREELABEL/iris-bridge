/**
 * Bridge Auth — auto-generated token + Express middleware.
 *
 * On first bridge start, generates a 32-byte hex token and stores it at
 * ~/.iris/bridge-token (mode 0600). CLI tools read the same file to
 * authenticate. All mutating endpoints require the X-Bridge-Key header.
 *
 * Addresses: #64813 (no auth on endpoints), #64821 (/execute-script zero auth)
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')

const TOKEN_PATH = process.env.BRIDGE_TOKEN_PATH || path.join(os.homedir(), '.iris', 'bridge-token')

/**
 * Load existing token or generate a new one.
 * Token is persisted to disk so CLI tools can read it.
 */
function loadOrCreateToken () {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const existing = fs.readFileSync(TOKEN_PATH, 'utf-8').trim()
      if (existing.length >= 32) return existing
    }
  } catch { /* regenerate */ }

  const token = crypto.randomBytes(32).toString('hex')
  const dir = path.dirname(TOKEN_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 })
  return token
}

const _token = loadOrCreateToken()

/**
 * Express middleware factory.
 *
 * @param {Object} opts
 * @param {Set<string>} opts.openPaths - Exact paths that skip auth (e.g. /health)
 * @param {string[]} opts.openPrefixes - Path prefixes that skip auth (e.g. /daemon/mesh/)
 * @returns {Function} Express middleware
 */
function bridgeAuth (opts = {}) {
  const openPaths = new Set(opts.openPaths || [])
  const openPrefixes = opts.openPrefixes || []

  return (req, res, next) => {
    // Allow open paths without auth
    if (openPaths.has(req.path)) return next()
    if (openPrefixes.some(p => req.path.startsWith(p))) return next()

    // Check X-Bridge-Key header
    const key = req.headers['x-bridge-key']
    if (key && key === _token) return next()

    res.status(401).json({ error: 'Unauthorized: missing or invalid X-Bridge-Key header' })
  }
}

/**
 * Get the current bridge token (for logging masked version on startup).
 */
function getToken () {
  return _token
}

module.exports = { bridgeAuth, getToken, TOKEN_PATH }
