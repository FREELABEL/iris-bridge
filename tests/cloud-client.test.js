const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { CloudClient } = require('../daemon/cloud-client')

describe('CloudClient', () => {
  // ─── isConnectionError() classification ───────────────────────

  describe('isConnectionError()', () => {
    it('classifies ENOTFOUND as connection error', () => {
      const err = new Error('DNS lookup failed')
      err.code = 'ENOTFOUND'
      assert.equal(CloudClient.isConnectionError(err), true)
    })

    it('classifies ECONNREFUSED as connection error', () => {
      const err = new Error('Connection refused')
      err.code = 'ECONNREFUSED'
      assert.equal(CloudClient.isConnectionError(err), true)
    })

    it('classifies ECONNRESET as connection error', () => {
      const err = new Error('Connection reset')
      err.code = 'ECONNRESET'
      assert.equal(CloudClient.isConnectionError(err), true)
    })

    it('classifies ETIMEDOUT as connection error', () => {
      const err = new Error('Connection timed out')
      err.code = 'ETIMEDOUT'
      assert.equal(CloudClient.isConnectionError(err), true)
    })

    it('classifies EAI_AGAIN as connection error', () => {
      const err = new Error('DNS temporary failure')
      err.code = 'EAI_AGAIN'
      assert.equal(CloudClient.isConnectionError(err), true)
    })

    it('does NOT classify HTTP 401 as connection error', () => {
      const err = new Error('HTTP 401: Unauthorized')
      err.statusCode = 401
      assert.equal(CloudClient.isConnectionError(err), false)
    })

    it('does NOT classify HTTP 500 as connection error', () => {
      const err = new Error('HTTP 500: Internal Server Error')
      err.statusCode = 500
      assert.equal(CloudClient.isConnectionError(err), false)
    })

    it('classifies timeout without statusCode as connection error', () => {
      const err = new Error('Request timeout')
      // No statusCode, no code — message matches /timeout/i
      assert.equal(CloudClient.isConnectionError(err), true)
    })

    it('does NOT classify timeout WITH statusCode as connection error', () => {
      const err = new Error('Gateway timeout')
      err.statusCode = 504
      assert.equal(CloudClient.isConnectionError(err), false)
    })
  })

  // ─── Failover triggering ──────────────────────────────────────

  describe('failover triggering', () => {
    it('stays on primary after 2 connection errors', async () => {
      const client = new CloudClient('https://primary.example.com', 'key', 'https://fallback.example.com')
      let callCount = 0

      client._request = async () => {
        callCount++
        const err = new Error('DNS fail')
        err.code = 'ENOTFOUND'
        throw err
      }

      try { await client.get('/test') } catch {}
      try { await client.get('/test') } catch {}

      assert.equal(client.usingFallback, false)
      assert.equal(client.consecutivePrimaryFailures, 2)
      assert.equal(client.apiUrl, 'https://primary.example.com')
    })

    it('switches to fallback after 3 consecutive connection errors', async () => {
      const client = new CloudClient('https://primary.example.com', 'key', 'https://fallback.example.com')
      let callCount = 0

      client._request = async (method, path) => {
        callCount++
        // Fail first 3 times on primary, succeed on fallback retry
        if (callCount <= 3) {
          const err = new Error('DNS fail')
          err.code = 'ENOTFOUND'
          throw err
        }
        return { ok: true }
      }

      try { await client.get('/test') } catch {}
      try { await client.get('/test') } catch {}

      // 3rd call triggers failover + immediate retry on fallback
      const result = await client.get('/test')

      assert.equal(client.usingFallback, true)
      assert.equal(client.apiUrl, 'https://fallback.example.com')
      assert.deepEqual(result, { ok: true })
    })

    it('HTTP errors do NOT trigger failover', async () => {
      const client = new CloudClient('https://primary.example.com', 'key', 'https://fallback.example.com')

      client._request = async () => {
        const err = new Error('HTTP 500: Internal Server Error')
        err.statusCode = 500
        throw err
      }

      // 5 HTTP 500 errors — should NOT trigger failover
      for (let i = 0; i < 5; i++) {
        try { await client.get('/test') } catch {}
      }

      assert.equal(client.usingFallback, false)
      assert.equal(client.apiUrl, 'https://primary.example.com')
    })
  })

  // ─── Fallback probing ────────────────────────────────────────

  describe('fallback probing', () => {
    it('probes primary every 10 successful requests on fallback', async () => {
      const client = new CloudClient('https://primary.example.com', 'key', 'https://fallback.example.com')
      let probed = false

      // Force into fallback state
      client.usingFallback = true
      client.apiUrl = 'https://fallback.example.com'
      client.requestsSinceFallback = 0

      // Mock _request to succeed and _probePrimary to track calls
      client._request = async () => ({ ok: true })
      const origProbe = client._probePrimary.bind(client)
      client._probePrimary = () => { probed = true }

      // Make 9 requests — no probe yet
      for (let i = 0; i < 9; i++) {
        await client.get('/test')
      }
      assert.equal(probed, false, 'Should not probe before 10 requests')

      // 10th request triggers probe
      await client.get('/test')
      assert.equal(probed, true, 'Should probe on 10th request')
    })

    it('switches back to primary when probe succeeds', async () => {
      const client = new CloudClient('https://primary.example.com', 'key', 'https://fallback.example.com')

      // Force into fallback state
      client.usingFallback = true
      client.apiUrl = 'https://fallback.example.com'
      client.consecutivePrimaryFailures = 3

      // Mock _request to always succeed (simulates primary recovery)
      client._request = async () => ({ ok: true })

      // Call _probePrimary directly
      client._probePrimary()

      // Wait for async probe to complete
      await new Promise(resolve => setTimeout(resolve, 50))

      assert.equal(client.usingFallback, false)
      assert.equal(client.apiUrl, 'https://primary.example.com')
      assert.equal(client.consecutivePrimaryFailures, 0)
    })

    it('stays on fallback when probe fails', async () => {
      const client = new CloudClient('https://primary.example.com', 'key', 'https://fallback.example.com')

      // Force into fallback state
      client.usingFallback = true
      client.apiUrl = 'https://fallback.example.com'

      // Mock _request to fail (primary still down)
      client._request = async () => {
        const err = new Error('DNS fail')
        err.code = 'ENOTFOUND'
        throw err
      }

      client._probePrimary()

      // Wait for async probe to complete
      await new Promise(resolve => setTimeout(resolve, 50))

      assert.equal(client.usingFallback, true)
      assert.equal(client.apiUrl, 'https://fallback.example.com')
    })
  })

  // ─── Constructor ──────────────────────────────────────────────

  describe('constructor', () => {
    it('strips trailing slash from URLs', () => {
      const client = new CloudClient('https://api.example.com/', 'key', 'https://fallback.example.com/')
      assert.equal(client.primaryUrl, 'https://api.example.com')
      assert.equal(client.fallbackUrl, 'https://fallback.example.com')
      assert.equal(client.apiUrl, 'https://api.example.com')
    })

    it('handles no fallback URL — failover disabled', async () => {
      const client = new CloudClient('https://api.example.com', 'key')

      client._request = async () => {
        const err = new Error('DNS fail')
        err.code = 'ENOTFOUND'
        throw err
      }

      // Should throw without attempting failover
      for (let i = 0; i < 5; i++) {
        await assert.rejects(() => client.get('/test'))
      }

      assert.equal(client.usingFallback, false)
      assert.equal(client.fallbackUrl, null)
    })

    it('detects local dev URLs for TLS skip', () => {
      const local1 = new CloudClient('https://local.iris.freelabel.net', 'key')
      assert.equal(local1.isLocalDev, true)

      const local2 = new CloudClient('http://localhost:3200', 'key')
      assert.equal(local2.isLocalDev, true)

      const prod = new CloudClient('https://freelabel.net', 'key')
      assert.equal(prod.isLocalDev, false)
    })
  })
})
