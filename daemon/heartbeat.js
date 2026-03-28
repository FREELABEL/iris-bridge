/**
 * Heartbeat — Sends periodic keepalive pings to the cloud.
 *
 * The cloud marks a node as offline if it misses heartbeats.
 * Also picks up any pending tasks dispatched between heartbeats.
 * Includes capacity data so the hub can route tasks intelligently.
 *
 * Resilience features:
 *   - Exponential backoff after consecutive failures (30s → 60s → 120s → 300s cap)
 *   - Circuit breaker after sustained failures (probes every 5 min)
 *   - ±20% jitter to prevent thundering herd across nodes
 *   - Auto-recovery on first successful ping
 */

class Heartbeat {
  constructor (cloudClient, intervalMs = 30000) {
    this.cloud = cloudClient
    this.baseIntervalMs = intervalMs
    this.currentIntervalMs = intervalMs
    this.timer = null
    this.failCount = 0
    this.maxFails = 5 // enter backoff after this many consecutive failures
    this.circuitBreakerThreshold = 10 // enter circuit-open after this many
    this.maxBackoffMs = 300000 // 5 minute cap
    this.circuitProbeMs = 300000 // 5 minute probe interval when circuit open

    // State machine: closed → backoff → open
    this.state = 'closed'

    // Callback to get current daemon state (set by Daemon)
    this.getStateCallback = null

    // Callback to write status file (set by Daemon)
    this.onPingCallback = null
  }

  start () {
    this._scheduleNext()
    console.log(`[heartbeat] Started — every ${this.baseIntervalMs / 1000}s`)
  }

  stop () {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    console.log('[heartbeat] Stopped')
  }

  _scheduleNext () {
    this.timer = setTimeout(() => this._tick(), this.currentIntervalMs)
  }

  async _tick () {
    await this.ping()
    // Only schedule next if we haven't been stopped
    if (this.timer !== null) {
      this._scheduleNext()
    }
  }

  async ping () {
    try {
      // Gather daemon state to send with heartbeat
      const extra = this.getStateCallback ? this.getStateCallback() : {}
      const result = await this.cloud.sendHeartbeat(extra)

      // Success — reset everything
      if (this.state !== 'closed') {
        console.log(`[heartbeat] Recovered — resuming normal ${this.baseIntervalMs / 1000}s heartbeat`)
      }
      this.failCount = 0
      this.state = 'closed'
      this.currentIntervalMs = this.baseIntervalMs

      // Trigger status file write after successful heartbeat
      if (this.onPingCallback) this.onPingCallback()

      // Log if tasks were dispatched during heartbeat
      if (result.dispatched_count > 0) {
        console.log(`[heartbeat] ${result.dispatched_count} task(s) dispatched via heartbeat`)
      }
    } catch (err) {
      this.failCount++
      console.error(`[heartbeat] Failed (${this.failCount}/${this.maxFails}): ${err.message}`)

      if (this.failCount >= this.circuitBreakerThreshold && this.state !== 'open') {
        // Circuit breaker — sustained failures, switch to slow probe
        this.state = 'open'
        this.currentIntervalMs = this.circuitProbeMs
        console.error(`[heartbeat] Circuit OPEN — probing every ${this.circuitProbeMs / 1000}s`)
      } else if (this.failCount >= this.maxFails && this.state === 'closed') {
        // Enter backoff
        this.state = 'backoff'
        this._applyBackoff()
      } else if (this.state === 'backoff') {
        // Already in backoff — increase interval
        this._applyBackoff()
      }
    }
  }

  _applyBackoff () {
    // Exponential: baseInterval * 2^(failCount - maxFails), capped at maxBackoffMs
    const exponent = this.failCount - this.maxFails
    const backoffMs = Math.min(this.baseIntervalMs * Math.pow(2, exponent), this.maxBackoffMs)

    // Add jitter: ±20% to prevent thundering herd
    const jitter = backoffMs * 0.2 * (Math.random() * 2 - 1)
    this.currentIntervalMs = Math.round(backoffMs + jitter)

    console.log(`[heartbeat] Backing off — next ping in ${(this.currentIntervalMs / 1000).toFixed(1)}s`)
  }
}

module.exports = { Heartbeat }
