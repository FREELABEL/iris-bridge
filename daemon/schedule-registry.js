/**
 * ScheduleRegistry — Local cron scheduling for Hive node scripts.
 *
 * Persists schedules to schedules.json, fires scripts via node-cron,
 * reports results to cloud (with offline fallback to pending-results.json).
 */

const cron = require('node-cron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

class ScheduleRegistry {
  constructor (config, cloud) {
    this.config = config
    this.cloud = cloud
    this.dataDir = config.dataDir
    this.schedulesFile = path.join(this.dataDir, 'schedules.json')
    this.pendingFile = path.join(this.dataDir, 'pending-results.json')
    this.schedules = new Map()
    this.cronJobs = new Map()
    this._load()
  }

  _load () {
    try {
      if (fs.existsSync(this.schedulesFile)) {
        const data = JSON.parse(fs.readFileSync(this.schedulesFile, 'utf-8'))
        for (const s of data) {
          this.schedules.set(s.id, s)
        }
      }
    } catch (err) {
      console.warn('[schedules] Failed to load schedules.json:', err.message)
    }
  }

  _save () {
    try {
      const data = Array.from(this.schedules.values())
      fs.writeFileSync(this.schedulesFile, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err) {
      console.warn('[schedules] Failed to save schedules.json:', err.message)
    }
  }

  start () {
    let count = 0
    for (const [id, schedule] of this.schedules) {
      if (schedule.enabled) {
        this._register(schedule)
        count++
      }
    }
    if (count > 0) {
      console.log(`[schedules] Registered ${count} schedule(s)`)
    }
  }

  stop () {
    for (const [id, job] of this.cronJobs) {
      job.stop()
    }
    this.cronJobs.clear()
  }

  _register (schedule) {
    // Stop existing job if re-registering
    if (this.cronJobs.has(schedule.id)) {
      this.cronJobs.get(schedule.id).stop()
    }

    if (!cron.validate(schedule.cron)) {
      console.warn(`[schedules] Invalid cron for ${schedule.id}: ${schedule.cron}`)
      return
    }

    const job = cron.schedule(schedule.cron, () => {
      this._fire(schedule.id).catch(err => {
        console.error(`[schedules] Fire error for ${schedule.id}:`, err.message)
      })
    })

    this.cronJobs.set(schedule.id, job)
  }

  async _fire (id) {
    const schedule = this.schedules.get(id)
    if (!schedule) return

    const scriptsDir = path.join(this.dataDir, 'scripts')
    const scriptPath = path.join(scriptsDir, schedule.filename)

    if (!fs.existsSync(scriptPath)) {
      console.warn(`[schedules] Script not found: ${schedule.filename}`)
      schedule.last_run = new Date().toISOString()
      schedule.last_status = 'file_missing'
      this._save()
      return
    }

    const ts = new Date().toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    console.log(`[schedules] [${ts}] Firing: ${schedule.filename} (${schedule.cron})`)

    // Mark as running so heartbeat/UI can show live state
    schedule.running = true
    schedule.started_at = new Date().toISOString()
    console.log(`[schedules] [${ts}] ▶ MARKED RUNNING: ${schedule.filename} (will be visible in next heartbeat)`)

    // Auto-detect interpreter
    const ext = path.extname(schedule.filename).toLowerCase()
    const interpreters = { '.py': 'python3', '.js': 'node' }
    const cmd = interpreters[ext] || '/bin/bash'
    const args = [scriptPath, ...(schedule.args || [])]

    const startTime = Date.now()

    return new Promise((resolve) => {
      const irisPath = path.join(require('os').homedir(), '.iris', 'bin')
      const child = spawn(cmd, args, {
        cwd: scriptsDir,
        env: {
          ...process.env,
          PATH: `${irisPath}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
          SCHEDULE_ID: id,
          SCHEDULE_CRON: schedule.cron
        },
        stdio: ['pipe', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''
      let killed = false

      child.stdout.on('data', d => { stdout += d.toString() })
      child.stderr.on('data', d => { stderr += d.toString() })

      const timer = setTimeout(() => {
        killed = true
        child.kill('SIGKILL')
      }, 60000)

      child.on('close', (code) => {
        clearTimeout(timer)
        const duration = Date.now() - startTime
        const status = killed ? 'timeout' : (code === 0 ? 'completed' : 'failed')

        console.log(`[schedules] [${ts}] ${schedule.filename} → ${status} (${duration}ms)`)

        // Update schedule state (including last output for CLI/API)
        schedule.running = false
        schedule.started_at = null
        schedule.last_run = new Date().toISOString()
        schedule.last_status = status
        schedule.last_duration_ms = duration
        schedule.last_exit_code = code
        schedule.last_stdout = stdout.slice(-4000)
        schedule.last_stderr = stderr.slice(-2000)
        schedule.run_count = (schedule.run_count || 0) + 1
        this._save()

        // Build result
        const result = {
          schedule_id: id,
          filename: schedule.filename,
          cron: schedule.cron,
          status,
          exit_code: code,
          stdout: stdout.slice(-10000),
          stderr: stderr.slice(-5000),
          duration_ms: duration,
          timestamp: new Date().toISOString()
        }

        // Try reporting to cloud, fallback to pending
        this._reportResult(result)
        resolve(result)
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        console.error(`[schedules] Spawn error for ${schedule.filename}:`, err.message)
        schedule.running = false
        schedule.started_at = null
        schedule.last_run = new Date().toISOString()
        schedule.last_status = 'error'
        this._save()
        resolve(null)
      })
    })
  }

  async _reportResult (result) {
    try {
      if (this.cloud && typeof this.cloud.submitScheduleResult === 'function') {
        await this.cloud.submitScheduleResult(result)
      }
      // If no dedicated method, just log — the heartbeat carries status
    } catch {
      // Cloud unreachable — queue for later
      this._appendPending(result)
    }
  }

  _appendPending (result) {
    try {
      let pending = []
      if (fs.existsSync(this.pendingFile)) {
        pending = JSON.parse(fs.readFileSync(this.pendingFile, 'utf-8'))
      }
      pending.push(result)
      // Cap at 1000
      if (pending.length > 1000) {
        pending = pending.slice(-1000)
      }
      fs.writeFileSync(this.pendingFile, JSON.stringify(pending, null, 2), 'utf-8')
    } catch (err) {
      console.warn('[schedules] Failed to save pending result:', err.message)
    }
  }

  async flushPending () {
    if (!fs.existsSync(this.pendingFile)) return

    try {
      const pending = JSON.parse(fs.readFileSync(this.pendingFile, 'utf-8'))
      if (!pending.length) return

      const failed = []
      for (const result of pending) {
        try {
          if (this.cloud && typeof this.cloud.submitScheduleResult === 'function') {
            await this.cloud.submitScheduleResult(result)
          }
        } catch {
          failed.push(result)
        }
      }

      if (failed.length > 0) {
        fs.writeFileSync(this.pendingFile, JSON.stringify(failed, null, 2), 'utf-8')
      } else {
        fs.unlinkSync(this.pendingFile)
      }

      if (pending.length - failed.length > 0) {
        console.log(`[schedules] Flushed ${pending.length - failed.length} pending result(s)`)
      }
    } catch { /* ignore */ }
  }

  // ─── Public API ────────────────────────────────────────────

  add (filename, cronExpr, args = []) {
    if (!cron.validate(cronExpr)) {
      throw new Error(`Invalid cron expression: ${cronExpr}`)
    }

    const scriptsDir = path.join(this.dataDir, 'scripts')
    const scriptPath = path.join(scriptsDir, filename)
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Script not found: ${filename}. Push it first with POST /execute-script`)
    }

    const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const schedule = {
      id,
      filename,
      cron: cronExpr,
      args,
      enabled: true,
      created_at: new Date().toISOString(),
      last_run: null,
      last_status: null,
      run_count: 0
    }

    this.schedules.set(id, schedule)
    this._save()
    this._register(schedule)

    console.log(`[schedules] Added: ${id} → ${filename} (${cronExpr})`)
    return schedule
  }

  remove (id) {
    if (!this.schedules.has(id)) {
      throw new Error(`Schedule not found: ${id}`)
    }

    if (this.cronJobs.has(id)) {
      this.cronJobs.get(id).stop()
      this.cronJobs.delete(id)
    }

    const schedule = this.schedules.get(id)
    this.schedules.delete(id)
    this._save()

    console.log(`[schedules] Removed: ${id} (${schedule.filename})`)
    return schedule
  }

  list () {
    return Array.from(this.schedules.values())
  }

  pause (id) {
    const schedule = this.schedules.get(id)
    if (!schedule) throw new Error(`Schedule not found: ${id}`)

    if (this.cronJobs.has(id)) {
      this.cronJobs.get(id).stop()
      this.cronJobs.delete(id)
    }

    schedule.enabled = false
    this._save()
    console.log(`[schedules] Paused: ${id}`)
    return schedule
  }

  resume (id) {
    const schedule = this.schedules.get(id)
    if (!schedule) throw new Error(`Schedule not found: ${id}`)

    schedule.enabled = true
    this._save()
    this._register(schedule)
    console.log(`[schedules] Resumed: ${id}`)
    return schedule
  }
}

module.exports = { ScheduleRegistry }
