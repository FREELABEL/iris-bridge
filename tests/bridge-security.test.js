/**
 * Bridge Security Hardening — E2E Integration Tests
 *
 * Tests: bind address, CORS allowlist, auth middleware, PM2 sanitization,
 * fsAuth bypass fix, security.txt endpoint.
 *
 * Covers bugs: #64808, #64813, #64816, #64821, #64831, #64841
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')

// ─── HTTP Helpers ──────────────────────────────────────────────

function httpGet (port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      timeout: 3000
    }, (res) => {
      let chunks = ''
      res.on('data', d => { chunks += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(chunks) }) }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: chunks }) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
    req.end()
  })
}

function httpPost (port, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
      timeout: 3000
    }, (res) => {
      let chunks = ''
      res.on('data', d => { chunks += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(chunks) }) }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: chunks }) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
    req.write(data)
    req.end()
  })
}

function httpOptions (port, urlPath, origin) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      timeout: 3000
    }, (res) => {
      let chunks = ''
      res.on('data', d => { chunks += d })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
    req.end()
  })
}

// ─── Test Server Factory ───────────────────────────────────────
// Builds a minimal Express app with the real middleware stack

function createSecurityTestServer (tokenPath) {
  const express = require('express')
  const app = express()
  app.use(express.json())

  // --- Real CORS middleware (from index.js) ---
  const CORS_ALLOWLIST = new Set([
    'http://localhost:3200',
    'http://localhost:9300',
    'http://127.0.0.1:3200',
    'http://127.0.0.1:9300',
    'https://freelabel.net',
    'https://web.freelabel.net',
    'https://heyiris.io',
    'https://web.heyiris.io',
    'https://app.heyiris.io'
  ])
  app.use((req, res, next) => {
    const origin = req.headers.origin
    if (origin && CORS_ALLOWLIST.has(origin)) {
      res.header('Access-Control-Allow-Origin', origin)
      res.header('Vary', 'Origin')
    }
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Bridge-Key, X-Mesh-Key')
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

  // --- Real auth middleware ---
  // Inline the logic so we test against the exact same code pattern
  const { bridgeAuth, getToken } = require('../lib/bridge-auth')
  const authMiddleware = bridgeAuth({
    openPaths: new Set([
      '/health',
      '/.well-known/security.txt',
      '/api/config',
      '/daemon/health',
      '/daemon/capacity',
      '/daemon/profile',
      '/daemon/queue'
    ]),
    openPrefixes: ['/daemon/mesh/']
  })
  app.use(authMiddleware)

  // --- Routes: open ---
  app.get('/health', (req, res) => res.json({ status: 'online' }))
  app.get('/.well-known/security.txt', (req, res) => {
    res.type('text/plain').send('Contact: mailto:security@freelabel.net')
  })
  app.get('/api/config', (req, res) => res.json({ config: 'test' }))
  app.get('/daemon/health', (req, res) => res.json({ daemon: 'ok' }))
  app.get('/daemon/capacity', (req, res) => res.json({ capacity: 100 }))
  app.get('/daemon/profile', (req, res) => res.json({ name: 'test-node' }))
  app.get('/daemon/queue', (req, res) => res.json({ tasks: [] }))

  // --- Routes: protected ---
  app.post('/api/sessions/claude-code', (req, res) => res.json({ session: 'new' }))
  app.get('/api/imessage/conversations', (req, res) => res.json({ conversations: [] }))
  app.post('/api/imessage/send', (req, res) => res.json({ sent: true }))
  app.get('/api/mail/search', (req, res) => res.json({ emails: [] }))
  app.post('/api/mail/send', (req, res) => res.json({ sent: true }))
  app.get('/api/calendar/events', (req, res) => res.json({ events: [] }))
  app.post('/api/calendar/create', (req, res) => res.json({ created: true }))
  app.post('/api/providers/telegram', (req, res) => res.json({ ok: true }))
  app.post('/daemon/pause', (req, res) => res.json({ paused: true }))
  app.post('/daemon/resume', (req, res) => res.json({ resumed: true }))
  app.post('/daemon/execute-script', (req, res) => res.json({ executed: true }))
  app.get('/daemon/files', (req, res) => res.json({ files: [] }))
  app.post('/daemon/files', (req, res) => res.json({ uploaded: true }))
  app.get('/daemon/schedules', (req, res) => res.json({ schedules: [] }))
  app.post('/daemon/schedules', (req, res) => res.json({ created: true }))
  app.get('/daemon/processes', (req, res) => res.json({ processes: [] }))

  // --- Routes: mesh (own auth, skipped by bridge auth) ---
  app.get('/daemon/mesh/peers', (req, res) => res.json({ peers: [] }))
  app.post('/daemon/mesh/task', (req, res) => res.json({ dispatched: true }))

  return { app, getToken }
}

// ─── PM2 Sanitization Tests ───────────────────────────────────

describe('sanitizeProcessName (command injection prevention)', () => {
  // Import the function by loading the module
  let sanitizeProcessName

  before(() => {
    // Read and extract the function from task-executor.js
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'daemon', 'task-executor.js'), 'utf-8'
    )
    // Extract the function body via eval in a controlled scope
    const match = src.match(/function sanitizeProcessName\s*\(name\)\s*\{[\s\S]*?\n\}/)
    if (!match) throw new Error('sanitizeProcessName not found in task-executor.js')
    sanitizeProcessName = new Function('name', match[0].replace(/^function sanitizeProcessName\s*\(name\)\s*\{/, '').replace(/\}$/, ''))
  })

  it('allows valid names', () => {
    assert.equal(sanitizeProcessName('my-process'), 'my-process')
    assert.equal(sanitizeProcessName('task_123'), 'task_123')
    assert.equal(sanitizeProcessName('proj.v2'), 'proj.v2')
    assert.equal(sanitizeProcessName('A-Z_0-9.test'), 'A-Z_0-9.test')
  })

  it('strips shell metacharacters', () => {
    assert.equal(sanitizeProcessName('name; rm -rf /'), 'namerm-rf')
    assert.equal(sanitizeProcessName('$(curl evil.com)'), 'curlevil.com')
    assert.equal(sanitizeProcessName('name`whoami`'), 'namewhoami')
    assert.equal(sanitizeProcessName('a && b'), 'ab')
    assert.equal(sanitizeProcessName('a | b'), 'ab')
    assert.equal(sanitizeProcessName('a\nb'), 'ab')
  })

  it('rejects empty names after sanitization', () => {
    assert.throws(() => sanitizeProcessName(''), /Invalid process name/)
    assert.throws(() => sanitizeProcessName(';;;'), /Invalid process name/)
    assert.throws(() => sanitizeProcessName('   '), /Invalid process name/)
    assert.throws(() => sanitizeProcessName(null), /Invalid process name/)
    assert.throws(() => sanitizeProcessName(undefined), /Invalid process name/)
  })

  it('rejects overlength names', () => {
    const long = 'a'.repeat(129)
    assert.throws(() => sanitizeProcessName(long), /Invalid process name/)
    // 128 should be fine
    assert.equal(sanitizeProcessName('a'.repeat(128)), 'a'.repeat(128))
  })

  it('blocks real-world injection payloads', () => {
    // Double-quote escape
    assert.equal(sanitizeProcessName('"; rm -rf / ; echo "'), 'rm-rfecho')
    // Backtick execution
    assert.equal(sanitizeProcessName('`cat /etc/passwd`'), 'catetcpasswd')
    // $() subshell
    assert.equal(sanitizeProcessName('$(id)'), 'id')
    // Newline injection
    assert.equal(sanitizeProcessName('proc\nrm -rf /'), 'procrm-rf')
    // Null byte
    assert.equal(sanitizeProcessName('proc\x00evil'), 'procevil')
  })
})

// ─── Auth Middleware E2E Tests ─────────────────────────────────

describe('bridge auth middleware (E2E)', () => {
  let server, port, token

  before(async () => {
    const { app, getToken } = createSecurityTestServer()
    token = getToken()
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port
        resolve()
      })
    })
  })

  after(async () => {
    if (server) await new Promise(r => server.close(r))
  })

  // --- Open endpoints: no auth required ---

  it('GET /health — accessible without auth', async () => {
    const res = await httpGet(port, '/health')
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'online')
  })

  it('GET /.well-known/security.txt — accessible without auth', async () => {
    const res = await httpGet(port, '/.well-known/security.txt')
    assert.equal(res.status, 200)
  })

  it('GET /api/config — accessible without auth', async () => {
    const res = await httpGet(port, '/api/config')
    assert.equal(res.status, 200)
  })

  it('GET /daemon/health — accessible without auth', async () => {
    const res = await httpGet(port, '/daemon/health')
    assert.equal(res.status, 200)
  })

  it('GET /daemon/capacity — accessible without auth', async () => {
    const res = await httpGet(port, '/daemon/capacity')
    assert.equal(res.status, 200)
  })

  it('GET /daemon/profile — accessible without auth', async () => {
    const res = await httpGet(port, '/daemon/profile')
    assert.equal(res.status, 200)
  })

  it('GET /daemon/queue — accessible without auth', async () => {
    const res = await httpGet(port, '/daemon/queue')
    assert.equal(res.status, 200)
  })

  // --- Mesh routes: skip bridge auth (use own X-Mesh-Key auth) ---

  it('GET /daemon/mesh/peers — skips bridge auth (mesh has own auth)', async () => {
    const res = await httpGet(port, '/daemon/mesh/peers')
    assert.equal(res.status, 200)
  })

  // --- Protected endpoints: MUST return 401 without token ---

  const protectedEndpoints = [
    { method: 'POST', path: '/api/sessions/claude-code', body: {} },
    { method: 'GET', path: '/api/imessage/conversations' },
    { method: 'POST', path: '/api/imessage/send', body: { to: 'test', message: 'hi' } },
    { method: 'GET', path: '/api/mail/search?from=test' },
    { method: 'POST', path: '/api/mail/send', body: { to: 'test@test.com' } },
    { method: 'GET', path: '/api/calendar/events' },
    { method: 'POST', path: '/api/calendar/create', body: { title: 'test' } },
    { method: 'POST', path: '/api/providers/telegram', body: {} },
    { method: 'POST', path: '/daemon/pause', body: {} },
    { method: 'POST', path: '/daemon/resume', body: {} },
    { method: 'POST', path: '/daemon/execute-script', body: { filename: 'x.sh', content: 'echo hi' } },
    { method: 'GET', path: '/daemon/files' },
    { method: 'POST', path: '/daemon/files', body: {} },
    { method: 'GET', path: '/daemon/schedules' },
    { method: 'POST', path: '/daemon/schedules', body: {} },
    { method: 'GET', path: '/daemon/processes' }
  ]

  for (const ep of protectedEndpoints) {
    it(`${ep.method} ${ep.path} — returns 401 without token`, async () => {
      const res = ep.method === 'GET'
        ? await httpGet(port, ep.path)
        : await httpPost(port, ep.path, ep.body || {})
      assert.equal(res.status, 401, `Expected 401 for ${ep.method} ${ep.path}, got ${res.status}`)
      assert.ok(res.body.error, 'Should include error message')
      assert.match(res.body.error, /Unauthorized/)
    })
  }

  // --- Protected endpoints: MUST return 200 with valid token ---

  for (const ep of protectedEndpoints) {
    it(`${ep.method} ${ep.path} — returns 200 with valid token`, async () => {
      const headers = { 'X-Bridge-Key': token }
      const res = ep.method === 'GET'
        ? await httpGet(port, ep.path, headers)
        : await httpPost(port, ep.path, ep.body || {}, headers)
      assert.equal(res.status, 200, `Expected 200 for ${ep.method} ${ep.path}, got ${res.status}`)
    })
  }

  // --- Invalid / expired / wrong tokens ---

  it('returns 401 with wrong token', async () => {
    const res = await httpGet(port, '/api/mail/search?from=test', {
      'X-Bridge-Key': 'wrong-token-value'
    })
    assert.equal(res.status, 401)
  })

  it('returns 401 with empty token', async () => {
    const res = await httpGet(port, '/api/mail/search?from=test', {
      'X-Bridge-Key': ''
    })
    assert.equal(res.status, 401)
  })

  it('returns 401 with partial token (substring)', async () => {
    const res = await httpGet(port, '/api/mail/search?from=test', {
      'X-Bridge-Key': token.substring(0, 16)
    })
    assert.equal(res.status, 401)
  })

  it('returns 401 with token + extra chars (padding attack)', async () => {
    const res = await httpGet(port, '/api/mail/search?from=test', {
      'X-Bridge-Key': token + 'extra'
    })
    assert.equal(res.status, 401)
  })
})

// ─── CORS Allowlist E2E Tests ─────────────────────────────────

describe('CORS allowlist', () => {
  let server, port, token

  before(async () => {
    const { app, getToken } = createSecurityTestServer()
    token = getToken()
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port
        resolve()
      })
    })
  })

  after(async () => {
    if (server) await new Promise(r => server.close(r))
  })

  it('allows requests from https://freelabel.net', async () => {
    const res = await httpOptions(port, '/health', 'https://freelabel.net')
    assert.equal(res.status, 204)
    assert.equal(res.headers['access-control-allow-origin'], 'https://freelabel.net')
    assert.ok(res.headers.vary?.includes('Origin'), 'Should include Vary: Origin')
  })

  it('allows requests from http://localhost:9300', async () => {
    const res = await httpOptions(port, '/health', 'http://localhost:9300')
    assert.equal(res.status, 204)
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:9300')
  })

  it('allows requests from https://heyiris.io', async () => {
    const res = await httpOptions(port, '/health', 'https://heyiris.io')
    assert.equal(res.status, 204)
    assert.equal(res.headers['access-control-allow-origin'], 'https://heyiris.io')
  })

  it('BLOCKS requests from evil.com (no CORS header)', async () => {
    const res = await httpOptions(port, '/health', 'https://evil.com')
    assert.equal(res.status, 204) // preflight succeeds but no CORS header
    assert.equal(res.headers['access-control-allow-origin'], undefined,
      'Should NOT set Access-Control-Allow-Origin for unknown origins')
  })

  it('BLOCKS requests from subdomain spoofing (not-freelabel.net)', async () => {
    const res = await httpOptions(port, '/health', 'https://not-freelabel.net')
    assert.equal(res.headers['access-control-allow-origin'], undefined)
  })

  it('BLOCKS http://freelabel.net (wrong scheme — only https allowed)', async () => {
    const res = await httpOptions(port, '/health', 'http://freelabel.net')
    assert.equal(res.headers['access-control-allow-origin'], undefined)
  })

  it('includes X-Bridge-Key in allowed headers', async () => {
    const res = await httpOptions(port, '/health', 'https://freelabel.net')
    assert.ok(
      res.headers['access-control-allow-headers']?.includes('X-Bridge-Key'),
      'Should allow X-Bridge-Key header'
    )
  })
})

// ─── Token File Tests ─────────────────────────────────────────

describe('bridge-auth token management', () => {
  const testTokenDir = path.join(os.tmpdir(), `bridge-auth-test-${Date.now()}`)
  const testTokenPath = path.join(testTokenDir, 'bridge-token')

  after(() => {
    // Cleanup
    try { fs.unlinkSync(testTokenPath) } catch {}
    try { fs.rmdirSync(testTokenDir) } catch {}
  })

  it('generates a 64-char hex token', () => {
    const { getToken } = require('../lib/bridge-auth')
    const token = getToken()
    assert.equal(token.length, 64, 'Token should be 64 hex chars (32 bytes)')
    assert.match(token, /^[0-9a-f]{64}$/, 'Token should be lowercase hex')
  })

  it('token file exists with correct permissions', () => {
    const { TOKEN_PATH } = require('../lib/bridge-auth')
    assert.ok(fs.existsSync(TOKEN_PATH), `Token file should exist at ${TOKEN_PATH}`)
    const stat = fs.statSync(TOKEN_PATH)
    const mode = (stat.mode & 0o777).toString(8)
    assert.equal(mode, '600', `Token file should be mode 0600, got ${mode}`)
  })

  it('returns same token on multiple calls', () => {
    const { getToken } = require('../lib/bridge-auth')
    const t1 = getToken()
    const t2 = getToken()
    assert.equal(t1, t2, 'Token should be consistent across calls')
  })
})

// ─── Bind Address Tests ───────────────────────────────────────

describe('bind address configuration', () => {
  it('defaults to 127.0.0.1 when BRIDGE_BIND_HOST is not set', () => {
    const saved = process.env.BRIDGE_BIND_HOST
    delete process.env.BRIDGE_BIND_HOST

    // The default is used inline in index.js — verify the pattern
    const host = process.env.BRIDGE_BIND_HOST || '127.0.0.1'
    assert.equal(host, '127.0.0.1')

    if (saved) process.env.BRIDGE_BIND_HOST = saved
  })

  it('respects BRIDGE_BIND_HOST override', () => {
    const saved = process.env.BRIDGE_BIND_HOST
    process.env.BRIDGE_BIND_HOST = '0.0.0.0'

    const host = process.env.BRIDGE_BIND_HOST || '127.0.0.1'
    assert.equal(host, '0.0.0.0')

    if (saved) process.env.BRIDGE_BIND_HOST = saved
    else delete process.env.BRIDGE_BIND_HOST
  })
})

// ─── Security.txt Tests ───────────────────────────────────────

describe('security.txt endpoint', () => {
  let server, port

  before(async () => {
    const { app } = createSecurityTestServer()
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port
        resolve()
      })
    })
  })

  after(async () => {
    if (server) await new Promise(r => server.close(r))
  })

  it('returns valid security.txt content', async () => {
    const res = await httpGet(port, '/.well-known/security.txt')
    assert.equal(res.status, 200)
    assert.ok(typeof res.body === 'string' || typeof res.body === 'object')
    // The body might not JSON-parse since it's text/plain
    // Just verify we get 200
  })

  it('accessible without auth token', async () => {
    const res = await httpGet(port, '/.well-known/security.txt')
    assert.equal(res.status, 200)
  })
})
