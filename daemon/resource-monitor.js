/**
 * ResourceMonitor — Battery-aware "Mycelium" throttling for sovereign nodes.
 *
 * Inspired by organic fungal networks: a tree doesn't share nutrients when
 * it's dying. A MacBook doesn't process AI tasks when it's on battery.
 *
 * Polls CPU load, free memory, and power state every 30s.
 * Reports capacity level to the hub so it can route tasks intelligently:
 *   - hibernating: on battery below 20% → rejects all new tasks
 *   - idle: load < 30% → accepts heavy tasks
 *   - light: load < 60% → accepts normal tasks
 *   - busy: load < 80% → accepts lightweight tasks only
 *   - overloaded: load >= 80% → rejects new tasks
 *
 * Emits 'capacity-changed' when level transitions (e.g., plugged in → unplugged).
 */

const os = require('os')
const { execSync } = require('child_process')
const EventEmitter = require('events')

class ResourceMonitor extends EventEmitter {
  constructor (options = {}) {
    super()
    this.intervalMs = options.intervalMs || 30000
    this.maxCpuThreshold = options.maxCpuThreshold || null // null = disabled
    this.timer = null
    this.lastLevel = null

    // Current state
    this.capacity = {
      level: 'idle',
      cpu_pct: 0,
      free_mem_mb: 0,
      total_mem_mb: 0,
      load_avg: 0,
      cpu_cores: os.cpus().length,
      on_battery: false,
      battery_pct: null
    }
  }

  start () {
    // Take an initial reading immediately
    this._poll()

    // Then poll on interval
    this.timer = setInterval(() => this._poll(), this.intervalMs)
    console.log(`[resource] Monitor started — polling every ${this.intervalMs / 1000}s`)
  }

  stop () {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    console.log('[resource] Monitor stopped')
  }

  /**
   * Get current capacity snapshot.
   */
  getCapacity () {
    return { ...this.capacity }
  }

  /**
   * Check if the node should accept new tasks based on current capacity.
   */
  canAcceptTasks () {
    return this.capacity.level !== 'hibernating' && this.capacity.level !== 'overloaded'
  }

  // ─── Internal polling ────────────────────────────────────────

  _poll () {
    const cores = os.cpus().length
    const loadAvg1m = os.loadavg()[0]
    const cpuPct = Math.round((loadAvg1m / cores) * 100)
    const freeMemMB = Math.round(os.freemem() / (1024 ** 2))
    const totalMemMB = Math.round(os.totalmem() / (1024 ** 2))

    // Battery check (macOS)
    const battery = this._checkBattery()

    // Determine capacity level
    let level
    if (battery.onBattery && battery.percent !== null && battery.percent < 20) {
      level = 'hibernating'
    } else if (cpuPct >= 80) {
      level = 'overloaded'
    } else if (cpuPct >= 60) {
      level = 'busy'
    } else if (cpuPct >= 30) {
      level = 'light'
    } else {
      level = 'idle'
    }

    // Check optional max CPU threshold
    if (this.maxCpuThreshold && cpuPct >= this.maxCpuThreshold && level !== 'hibernating') {
      level = 'overloaded'
    }

    // Update state
    this.capacity = {
      level,
      cpu_pct: cpuPct,
      free_mem_mb: freeMemMB,
      total_mem_mb: totalMemMB,
      load_avg: Math.round(loadAvg1m * 100) / 100,
      cpu_cores: cores,
      on_battery: battery.onBattery,
      battery_pct: battery.percent
    }

    // Emit event if level changed
    if (level !== this.lastLevel) {
      const prev = this.lastLevel
      this.lastLevel = level

      if (prev !== null) {
        console.log(`[resource] Capacity changed: ${prev} → ${level}${battery.onBattery ? ' (battery)' : ''}`)
        this.emit('capacity-changed', { level, previous: prev, capacity: this.capacity })
      }
    }
  }

  /**
   * Check macOS battery state via pmset.
   * Returns { onBattery: boolean, percent: number|null }
   */
  _checkBattery () {
    if (os.platform() !== 'darwin') {
      return { onBattery: false, percent: null }
    }

    try {
      const output = execSync('pmset -g batt 2>/dev/null', { encoding: 'utf-8', timeout: 5000 })

      // Parse power source: "Now drawing from 'AC Power'" or "'Battery Power'"
      const onBattery = /Battery Power/i.test(output) && !/AC Power/i.test(output.split('\n')[0])

      // Parse battery percentage: "100%; charged" or "78%; discharging"
      const pctMatch = output.match(/(\d+)%/)
      const percent = pctMatch ? parseInt(pctMatch[1], 10) : null

      return { onBattery, percent }
    } catch {
      // pmset not available (maybe not macOS or restricted)
      return { onBattery: false, percent: null }
    }
  }
}

module.exports = { ResourceMonitor }
