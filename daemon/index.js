/**
 * Daemon — Sovereign compute node orchestrator.
 *
 * Lifecycle: start → authenticate → subscribe → listen → execute → report
 *
 * This is Pattern 2 from Browser Use's architecture, adapted for sovereign
 * infrastructure. Browser Use isolates agents because they run untrusted
 * code on THEIR servers. We isolate credentials because users run THEIR OWN
 * code on THEIR OWN hardware.
 *
 * Key principle: the node never holds cloud API keys. Local Ollama calls
 * go direct (sovereign). Cloud LLM calls route through iris-api (proxied).
 * The hub holds credentials. The node holds compute. Each scales independently.
 *
 * "Avoid what is strong, strike at what is weak." The giants are strong at
 * centralized compute. They are weak at distributed edge orchestration.
 * This daemon IS that edge orchestration.
 *
 * A2A: Exposes HTTP on A2A_PORT (default 3200) for peer-to-peer data flow
 * without routing through the hub — Machine A scrapes, Machine B enriches.
 */

const { CloudClient } = require('./cloud-client')
const { PusherClient } = require('./pusher-client')
const { TaskExecutor } = require('./task-executor')
const { Heartbeat } = require('./heartbeat')
const { WorkspaceManager } = require('./workspace-manager')
const { ResourceMonitor } = require('./resource-monitor')
const { detectProfile, getCachedProfile } = require('./hardware-profile')
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const IRIS_DIR = path.join(os.homedir(), '.iris')
const STATUS_FILE = path.join(IRIS_DIR, 'status.json')
const CONFIG_FILE = path.join(IRIS_DIR, 'config.json')

class Daemon {
  constructor (config) {
    this.config = config
    this.running = false
    this.nodeId = null
    this.nodeName = process.env.NODE_NAME || os.hostname() || 'unnamed'
    this.externalApp = config.externalApp || null // bridge express app (embedded mode)

    this.cloud = new CloudClient(config.apiUrl, config.apiKey, config.apiUrlFallback)
    this.workspaces = new WorkspaceManager(config.dataDir)
    this.executor = new TaskExecutor(this.cloud, this.workspaces)
    // Override fl-api path if explicitly provided
    if (config.flApiPath) {
      this.executor.flApiPath = config.flApiPath
    }
    this.pusher = null
    this.heartbeat = null
    this.a2aServer = null
    this.resourceMonitor = null
    this.hardwareProfile = null
    this.ingestBuffer = [] // received A2A payloads
    this.pendingTaskIds = new Set() // tasks received via Pusher but not yet in executor.runningTasks

    // Pause state — loaded from config, toggled via CLI/signal/endpoint
    this.paused = false
    this.pauseReason = null // 'manual' | 'battery' | null
    this._loadPauseState()
  }

  async start () {
    console.log('[daemon] Starting...')

    // Step 0: Detect hardware profile (cached after first run)
    console.log('[daemon] Detecting hardware...')
    this.hardwareProfile = await detectProfile()
    console.log(`[daemon] Hardware: ${this.hardwareProfile.cpu.model} | ${this.hardwareProfile.memory.total_gb}GB RAM | GPU: ${this.hardwareProfile.gpu.available ? this.hardwareProfile.gpu.name : 'none'}`)

    // Step 1: Authenticate with cloud and register as online
    console.log('[daemon] Authenticating with cloud...')
    const heartbeatResult = await this.cloud.sendHeartbeat({
      hardware_profile: this.hardwareProfile
    })
    this.nodeId = heartbeatResult.node_id

    console.log(`[daemon] Node registered: ${this.nodeId}`)
    console.log(`[daemon] Status: online | Active tasks: ${heartbeatResult.active_tasks}`)

    // Step 2: Connect to Pusher
    const pusherKey = heartbeatResult.pusher_key || this.config.pusherKey
    const pusherCluster = heartbeatResult.pusher_cluster || this.config.pusherCluster
    const channel = heartbeatResult.channel || `private-node.${this.nodeId}`

    if (pusherKey) {
      console.log(`[daemon] Connecting to Pusher channel: ${channel}`)
      this.pusher = new PusherClient(pusherKey, pusherCluster, channel, this.cloud)
      await this.pusher.connect()
      this.pusher.onTaskDispatched((event) => this.handleTaskDispatched(event))
      console.log('[daemon] Pusher connected — listening for tasks')
    } else {
      console.log('[daemon] No Pusher key — falling back to polling mode')
    }

    // Step 3: Start resource monitor (battery-aware Mycelium throttling)
    this.resourceMonitor = new ResourceMonitor({
      intervalMs: 30000,
      maxCpuThreshold: this.config.maxCpuThreshold || null
    })
    this.resourceMonitor.on('capacity-changed', ({ level, previous }) => {
      // Auto-hibernate on battery — auto-resume when plugged in
      if (level === 'hibernating' && !this.paused) {
        this.paused = true
        this.pauseReason = 'battery'
        console.log('[daemon] Battery detected — hibernating (no new tasks)')
      } else if (previous === 'hibernating' && level !== 'hibernating') {
        // Only auto-resume if we were paused by battery, not manually
        if (this.pauseReason === 'battery') {
          this.paused = false
          this.pauseReason = null
          console.log('[daemon] AC power restored — resuming task acceptance')
          // Pick up tasks dispatched while hibernating
          this.checkPendingTasks().catch(() => {})
        }
      }
      this._writeStatusFile()
    })
    this.resourceMonitor.start()

    // Step 4: Start A2A HTTP server
    await this.startA2AServer()

    // Step 5: Start heartbeat loop (with capacity + status + session reporting)
    this.heartbeat = new Heartbeat(this.cloud, 30000)
    this.heartbeat.getStateCallback = () => ({
      capacity: this.resourceMonitor ? this.resourceMonitor.getCapacity() : null,
      paused: this.paused,
      pause_reason: this.pauseReason,
      active_sessions: this._getLocalSessions(),
      heartbeat_state: this.heartbeat.state,
      local_ip: this._getLocalIp(),
      running_task_ids: [
        ...(this.executor ? [...this.executor.runningTasks.keys()] : []),
        ...this.pendingTaskIds
      ]
    })
    this.heartbeat.onPingCallback = () => {
      this._writeStatusFile()
      this._refreshSessionCache() // refresh session data after each heartbeat
    }
    this.heartbeat.start()

    // Initial session cache population
    this._cachedSessions = []
    this._refreshSessionCache()

    // Step 6: Listen for SIGUSR1 (pause/resume toggle from CLI)
    process.on('SIGUSR1', () => this._handleConfigReload())

    // Step 7: Check for any pending tasks already assigned
    if (!this.paused) {
      await this.checkPendingTasks()
    }

    this.running = true
    this._writeStatusFile()
    console.log(`[daemon] Ready — waiting for tasks...${this.paused ? ' (PAUSED)' : ''}`)
  }

  // ─── Pause/Resume Kill Switch ─────────────────────────────────

  _loadPauseState () {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
        if (config.paused === true) {
          this.paused = true
          this.pauseReason = 'manual'
        }
      }
    } catch { /* no config file yet */ }
  }

  _savePauseState () {
    try {
      let config = {}
      if (fs.existsSync(CONFIG_FILE)) {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
      }
      config.paused = this.paused
      const dir = path.dirname(CONFIG_FILE)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
    } catch (err) {
      console.error('[daemon] Failed to save pause state:', err.message)
    }
  }

  _handleConfigReload () {
    console.log('[daemon] SIGUSR1 received — reloading config...')
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
        const wasPaused = this.paused
        this.paused = config.paused === true
        this.pauseReason = this.paused ? 'manual' : null

        if (wasPaused !== this.paused) {
          console.log(`[daemon] ${this.paused ? 'PAUSED' : 'RESUMED'} via config reload`)
          this._writeStatusFile()
        }
      }
    } catch (err) {
      console.error('[daemon] Config reload failed:', err.message)
    }
  }

  pause (reason = 'manual') {
    this.paused = true
    this.pauseReason = reason
    this._savePauseState()
    this._writeStatusFile()
    console.log(`[daemon] Paused (${reason})`)
  }

  resume () {
    this.paused = false
    this.pauseReason = null
    this._savePauseState()
    this._writeStatusFile()
    console.log('[daemon] Resumed')
    // Check for tasks that were dispatched while paused/hibernating
    this.checkPendingTasks().catch(err => {
      console.log(`[daemon] Post-resume task check failed: ${err.message}`)
    })
  }

  // ─── Status File for Electron Menu Bar ────────────────────────

  _writeStatusFile () {
    try {
      const status = {
        status: this.paused ? (this.pauseReason === 'battery' ? 'hibernating' : 'paused') : 'active',
        reason: this.pauseReason,
        node_id: this.nodeId,
        node_name: this.nodeName,
        capacity: this.resourceMonitor ? this.resourceMonitor.getCapacity() : null,
        heartbeat: this.heartbeat ? { state: this.heartbeat.state, fail_count: this.heartbeat.failCount } : null,
        running_tasks: this.executor ? this.executor.runningTasks.size : 0,
        uptime_s: Math.floor(process.uptime()),
        last_updated: new Date().toISOString()
      }

      const dir = path.dirname(STATUS_FILE)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2))
    } catch { /* non-critical */ }
  }

  // ─── A2A HTTP Server ─────────────────────────────────────────────
  async startA2AServer () {
    // Embedded mode: mount daemon routes on the bridge's express app (no new server)
    const useEmbedded = !!this.externalApp
    let app

    if (useEmbedded) {
      app = this.externalApp
      console.log('[daemon] Mounting daemon endpoints on bridge server (embedded mode)')
    } else {
      const express = require('express')
      app = express()
      app.use(express.json({ limit: '50mb' }))
    }

    const a2aPort = parseInt(process.env.A2A_PORT || '3200', 10)
    const prefix = useEmbedded ? '/daemon' : ''

    // Health check — in embedded mode, augment the bridge's /health instead
    app.get(`${prefix}/health`, (req, res) => {
      let persistentProcesses = 0
      try {
        const pm2List = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8' })
        persistentProcesses = JSON.parse(pm2List).length
      } catch { /* pm2 not available or no processes */ }

      res.json({
        status: this.paused ? (this.pauseReason === 'battery' ? 'hibernating' : 'paused') : 'online',
        paused: this.paused,
        pause_reason: this.pauseReason,
        node_id: this.nodeId,
        node_name: this.nodeName,
        running_tasks: this.executor.runningTasks.size,
        persistent_processes: persistentProcesses,
        ingest_buffer: this.ingestBuffer.length,
        uptime_s: Math.floor(process.uptime())
      })
    })

    // Capacity — resource monitor snapshot (CPU, RAM, battery, level)
    app.get(`${prefix}/capacity`, (req, res) => {
      res.json(this.resourceMonitor ? this.resourceMonitor.getCapacity() : { level: 'unknown' })
    })

    // Hardware profile
    app.get(`${prefix}/profile`, async (req, res) => {
      const forceRefresh = req.query.refresh === 'true'
      if (forceRefresh) {
        this.hardwareProfile = await detectProfile({ forceRefresh: true })
      }
      res.json(this.hardwareProfile || getCachedProfile() || { error: 'No profile detected' })
    })

    // Pause — kill switch (user sovereignty)
    app.post(`${prefix}/pause`, (req, res) => {
      this.pause('manual')
      res.json({ status: 'paused', reason: 'manual' })
    })

    // Resume
    app.post(`${prefix}/resume`, (req, res) => {
      this.resume()
      res.json({ status: 'active', reason: null })
    })

    // A2A Ingest — receive data from peer nodes
    app.post(`${prefix}/ingest`, (req, res) => {
      const { source_node, source_task_id, data, label } = req.body

      if (!data) {
        return res.status(400).json({ error: 'Missing "data" field' })
      }

      const payload = {
        received_at: new Date().toISOString(),
        source_node: source_node || 'unknown',
        source_task_id: source_task_id || null,
        label: label || 'a2a-payload',
        data
      }

      // Store in memory buffer
      this.ingestBuffer.push(payload)

      // Also persist to disk for task access
      const ingestDir = path.join(this.config.dataDir, 'a2a-ingest')
      if (!fs.existsSync(ingestDir)) fs.mkdirSync(ingestDir, { recursive: true })
      const filename = `${label || 'payload'}-${Date.now()}.json`
      fs.writeFileSync(
        path.join(ingestDir, filename),
        JSON.stringify(payload, null, 2)
      )

      console.log(`[a2a] Received from ${source_node}: ${label || 'data'} (${JSON.stringify(data).length} bytes)`)

      res.json({
        status: 'received',
        node: this.nodeName,
        filename,
        buffer_size: this.ingestBuffer.length
      })
    })

    // List ingested payloads
    app.get(`${prefix}/ingest`, (req, res) => {
      res.json({
        count: this.ingestBuffer.length,
        payloads: this.ingestBuffer.slice(-20) // last 20
      })
    })

    // Clear ingest buffer
    app.delete(`${prefix}/ingest`, (req, res) => {
      const count = this.ingestBuffer.length
      this.ingestBuffer = []
      res.json({ cleared: count })
    })

    // Active sessions on this node (served from heartbeat cache)
    app.get(`${prefix}/sessions`, (req, res) => {
      res.json({
        node_id: this.nodeId,
        node_name: this.nodeName,
        sessions: this._cachedSessions || [],
        updated_at: new Date().toISOString()
      })
    })

    // ─── Machine Drive (Mini-Dropbox File Browser) ─────────────────
    // Browse, download, and upload files on this machine's workspace.
    // The "Drive" tab in the Hive UI hits these endpoints.

    // List files in a directory (defaults to workspace root)
    app.get(`${prefix}/files`, (req, res) => {
      const requestedPath = req.query.path || '/'
      const baseDir = this.config.dataDir
      const fullPath = path.resolve(baseDir, requestedPath.replace(/^\//, ''))

      // Security: prevent path traversal outside data dir
      if (!fullPath.startsWith(path.resolve(baseDir))) {
        return res.status(403).json({ error: 'Access denied' })
      }

      if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'Path not found' })
      }

      const stats = fs.statSync(fullPath)

      if (stats.isFile()) {
        // Return file metadata + content for small files
        const size = stats.size
        const entry = {
          name: path.basename(fullPath),
          path: '/' + path.relative(baseDir, fullPath),
          type: 'file',
          size,
          modified: stats.mtime.toISOString()
        }

        if (size < 512 * 1024) {
          // Files under 512KB — include content inline
          entry.content = fs.readFileSync(fullPath, 'utf-8')
        }

        return res.json(entry)
      }

      // Directory listing
      const entries = fs.readdirSync(fullPath, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') || e.name === '.output')
        .map(e => {
          const entryPath = path.join(fullPath, e.name)
          const entryStats = fs.statSync(entryPath)
          return {
            name: e.name,
            path: '/' + path.relative(baseDir, entryPath),
            type: e.isDirectory() ? 'directory' : 'file',
            size: e.isDirectory() ? this._dirSize(entryPath) : entryStats.size,
            modified: entryStats.mtime.toISOString(),
            children: e.isDirectory()
              ? fs.readdirSync(entryPath).length
              : undefined
          }
        })
        .sort((a, b) => {
          // Directories first, then by name
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })

      res.json({
        path: '/' + path.relative(baseDir, fullPath),
        type: 'directory',
        entries,
        total_size: entries.reduce((sum, e) => sum + (e.size || 0), 0),
        machine: this.nodeName
      })
    })

    // Download a file
    app.get(`${prefix}/files/download`, (req, res) => {
      const requestedPath = req.query.path
      if (!requestedPath) return res.status(400).json({ error: 'Missing path param' })

      const baseDir = this.config.dataDir
      const fullPath = path.resolve(baseDir, requestedPath.replace(/^\//, ''))

      if (!fullPath.startsWith(path.resolve(baseDir))) {
        return res.status(403).json({ error: 'Access denied' })
      }

      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        return res.status(404).json({ error: 'File not found' })
      }

      res.download(fullPath)
    })

    // Upload a file
    app.post(`${prefix}/files`, (req, res) => {
      const targetPath = req.query.path || '/'
      const filename = req.query.filename

      if (!filename) return res.status(400).json({ error: 'Missing filename param' })

      const baseDir = this.config.dataDir
      const dirPath = path.resolve(baseDir, targetPath.replace(/^\//, ''))

      if (!dirPath.startsWith(path.resolve(baseDir))) {
        return res.status(403).json({ error: 'Access denied' })
      }

      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true })
      }

      const filePath = path.join(dirPath, path.basename(filename))

      // Accept raw body or JSON content
      if (req.body && req.body.content) {
        fs.writeFileSync(filePath, req.body.content, 'utf-8')
      } else {
        // Collect raw body
        const chunks = []
        req.on('data', chunk => chunks.push(chunk))
        req.on('end', () => {
          fs.writeFileSync(filePath, Buffer.concat(chunks))
        })
      }

      console.log(`[files] Uploaded: ${path.basename(filename)} → ${filePath}`)
      res.json({
        status: 'uploaded',
        path: '/' + path.relative(baseDir, filePath),
        machine: this.nodeName
      })
    })

    // Delete a file or directory
    app.delete(`${prefix}/files`, (req, res) => {
      const requestedPath = req.query.path
      if (!requestedPath) return res.status(400).json({ error: 'Missing path param' })

      const baseDir = this.config.dataDir
      const fullPath = path.resolve(baseDir, requestedPath.replace(/^\//, ''))

      if (!fullPath.startsWith(path.resolve(baseDir))) {
        return res.status(403).json({ error: 'Access denied' })
      }

      if (fullPath === path.resolve(baseDir)) {
        return res.status(403).json({ error: 'Cannot delete root' })
      }

      if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'Not found' })
      }

      fs.rmSync(fullPath, { recursive: true, force: true })
      console.log(`[files] Deleted: ${requestedPath}`)
      res.json({ status: 'deleted', path: requestedPath })
    })

    // ─── PM2 Process Management ──────────────────────────────────────
    // List all PM2 processes
    app.get(`${prefix}/processes`, (req, res) => {
      try {
        const raw = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8' })
        const procs = JSON.parse(raw).map(p => ({
          name: p.name,
          pm_id: p.pm_id,
          status: p.pm2_env?.status || 'unknown',
          cpu: p.monit?.cpu || 0,
          memory: p.monit?.memory || 0,
          uptime: p.pm2_env?.pm_uptime || null,
          restarts: p.pm2_env?.restart_time || 0,
          cwd: p.pm2_env?.pm_cwd || null
        }))
        res.json({ processes: procs, count: procs.length })
      } catch {
        res.json({ processes: [], count: 0 })
      }
    })

    // Stop a PM2 process
    app.post(`${prefix}/processes/:name/stop`, (req, res) => {
      try {
        execSync(`pm2 stop "${req.params.name}" && pm2 save`, { encoding: 'utf-8' })
        res.json({ status: 'stopped', name: req.params.name })
      } catch (err) {
        res.status(500).json({ error: `Failed to stop: ${err.message}` })
      }
    })

    // Restart a PM2 process
    app.post(`${prefix}/processes/:name/restart`, (req, res) => {
      try {
        execSync(`pm2 restart "${req.params.name}"`, { encoding: 'utf-8' })
        res.json({ status: 'restarted', name: req.params.name })
      } catch (err) {
        res.status(500).json({ error: `Failed to restart: ${err.message}` })
      }
    })

    // Delete a PM2 process
    app.delete(`${prefix}/processes/:name`, (req, res) => {
      try {
        execSync(`pm2 delete "${req.params.name}" && pm2 save`, { encoding: 'utf-8' })
        res.json({ status: 'deleted', name: req.params.name })
      } catch (err) {
        res.status(500).json({ error: `Failed to delete: ${err.message}` })
      }
    })

    // Get PM2 process logs (last N lines)
    app.get(`${prefix}/processes/:name/logs`, (req, res) => {
      const lines = parseInt(req.query.lines || '100', 10)
      try {
        const logs = execSync(`pm2 logs "${req.params.name}" --nostream --lines ${lines} 2>&1`, { encoding: 'utf-8' })
        res.json({ name: req.params.name, lines: logs })
      } catch (err) {
        res.status(500).json({ error: `Failed to get logs: ${err.message}` })
      }
    })

    // In embedded mode, routes are already mounted on the bridge — no new server needed
    if (useEmbedded) {
      console.log(`[daemon] Daemon endpoints mounted at /daemon/* on bridge server`)
      console.log(`[daemon] Endpoints: /daemon/health /daemon/capacity /daemon/pause /daemon/resume /daemon/sessions /daemon/files /daemon/processes`)
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      this.a2aServer = app.listen(a2aPort, '0.0.0.0', () => {
        console.log(`[a2a] HTTP server listening on :${a2aPort}`)
        console.log(`[a2a] Endpoints: /health /capacity /profile /pause /resume /ingest /files /processes`)
        resolve()
      })

      this.a2aServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.log(`[a2a] Port ${a2aPort} already in use (bridge is running?)`)
          console.log(`[a2a] Tip: Use "npm run bridge" instead — it runs both bridge + daemon on one port`)
          console.log(`[a2a] Continuing without A2A server — daemon will still heartbeat and execute tasks`)
          this.a2aServer = null
          resolve()
        } else {
          throw err
        }
      })
    })
  }

  async handleTaskDispatched (event) {
    console.log(`[daemon] Task dispatched: ${event.task_id} — "${event.title}"`)

    // Track immediately so heartbeat includes this task (prevents orphan race condition)
    this.pendingTaskIds.add(event.task_id)

    // Reject if paused or hibernating
    if (this.paused) {
      console.log(`[daemon] Rejecting task ${event.task_id} — node is ${this.pauseReason === 'battery' ? 'hibernating (battery)' : 'paused'}`)
      this.pendingTaskIds.delete(event.task_id)
      try {
        await this.cloud.submitResult(event.task_id, {
          status: 'rejected',
          error: `Node ${this.pauseReason === 'battery' ? 'hibernating (on battery)' : 'paused by user'}`
        })
      } catch { /* best effort */ }
      return
    }

    try {
      // Fetch full task details
      const task = await this.cloud.fetchTask(event.task_id)

      // Accept the task
      await this.cloud.acceptTask(event.task_id)
      console.log(`[daemon] Accepted task: ${event.task_id}`)

      // Execute (executor.runningTasks will track it from here)
      await this.executor.execute(task)

      // A2A: Forward result to peer if configured
      if (task.config?.destination === 'peer' && task.config?.peer_endpoint) {
        await this.forwardToPeer(task)
      }
    } catch (err) {
      console.error(`[daemon] Task ${event.task_id} failed:`, err.message)
      try {
        await this.cloud.submitResult(event.task_id, {
          status: 'failed',
          error: err.message
        })
      } catch { /* best effort */ }
    } finally {
      this.pendingTaskIds.delete(event.task_id)
    }
  }

  // ─── A2A Forwarding ──────────────────────────────────────────────
  async forwardToPeer (task) {
    const endpoint = task.config.peer_endpoint
    console.log(`[a2a] Forwarding result to peer: ${endpoint}`)

    const http = require('http')
    const https = require('https')
    const { URL } = require('url')
    const url = new URL(endpoint)
    const lib = url.protocol === 'https:' ? https : http

    // Read task output from the workspace
    const workspace = this.workspaces.get(task.id)
    let outputData = {}

    // Try to read output files from workspace
    if (workspace) {
      const files = this.workspaces.collectOutputFiles(task.id)
      outputData = { files }
    }

    const body = JSON.stringify({
      source_node: this.nodeName,
      source_task_id: task.id,
      label: task.config?.peer_label || `result-${task.type}`,
      data: {
        task_id: task.id,
        task_type: task.type,
        title: task.title,
        ...outputData
      }
    })

    return new Promise((resolve, reject) => {
      const req = lib.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `IRIS-Node/${this.nodeName}`
        },
        rejectUnauthorized: false
      }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[a2a] Peer accepted: ${data.substring(0, 100)}`)
            resolve()
          } else {
            console.error(`[a2a] Peer rejected: HTTP ${res.statusCode}`)
            resolve() // don't fail the task over A2A issues
          }
        })
      })

      req.on('error', (err) => {
        console.error(`[a2a] Peer unreachable: ${err.message}`)
        resolve() // non-fatal
      })

      req.setTimeout(10000, () => { req.destroy() })
      req.write(body)
      req.end()
    })
  }

  async checkPendingTasks () {
    try {
      const { tasks } = await this.cloud.getPendingTasks()
      if (tasks && tasks.length > 0) {
        console.log(`[daemon] Found ${tasks.length} pending task(s) — processing...`)
        for (const task of tasks) {
          await this.handleTaskDispatched({
            task_id: task.id,
            title: task.title
          })
        }
      }
    } catch (err) {
      console.log(`[daemon] Could not check pending tasks: ${err.message}`)
    }
  }

  // ─── Local Session Discovery ────────────────────────────────────
  // Returns the primary local (LAN) IP address of this machine.
  // This is sent with every heartbeat so the cloud dashboard can show
  // the real network address, not just the public IP seen by the hub.

  _getLocalIp () {
    try {
      const interfaces = os.networkInterfaces()
      for (const iface of Object.values(interfaces)) {
        for (const addr of iface) {
          if (addr.family === 'IPv4' && !addr.internal) {
            return addr.address
          }
        }
      }
    } catch { /* ignore */ }
    return null
  }

  // Fetches active CLI sessions from the bridge running on the same machine.
  // Returns a compact summary for inclusion in the heartbeat payload.

  _getLocalSessions () {
    try {
      const a2aPort = parseInt(process.env.A2A_PORT || '3200', 10)
      const http = require('http')

      // Synchronous-safe: we cache the last known sessions and update async
      // The heartbeat callback must be sync, so return cached data
      return this._cachedSessions || []
    } catch {
      return []
    }
  }

  // Called periodically to refresh the session cache (async-safe)
  async _refreshSessionCache () {
    try {
      const a2aPort = parseInt(process.env.A2A_PORT || '3200', 10)
      const http = require('http')

      const data = await new Promise((resolve) => {
        const req = http.get(`http://localhost:${a2aPort}/api/discover?limit=10`, (res) => {
          let body = ''
          res.on('data', chunk => { body += chunk })
          res.on('end', () => {
            try {
              resolve(JSON.parse(body))
            } catch {
              resolve(null)
            }
          })
        })
        req.on('error', () => resolve(null))
        req.setTimeout(3000, () => { req.destroy(); resolve(null) })
      })

      if (!data) {
        this._cachedSessions = []
        return
      }

      // Flatten all providers into a compact array
      const sessions = []
      for (const provider of ['claude_code', 'opencode', 'ollama']) {
        const providerSessions = data[provider] || []
        for (const s of providerSessions) {
          sessions.push({
            session_id: s.session_id,
            provider: s.provider || provider,
            name: s.name || 'Session',
            status: s.status || 'active',
            project_path: s.project_path || null,
            model: s.model || null,
            updated_at: s.updated_at || null
          })
        }
      }

      this._cachedSessions = sessions
    } catch {
      this._cachedSessions = []
    }
  }

  _dirSize (dir) {
    let total = 0
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const e of entries) {
        const p = path.join(dir, e.name)
        if (e.isFile()) total += fs.statSync(p).size
        else if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') {
          total += this._dirSize(p)
        }
      }
    } catch { /* permission errors */ }
    return total
  }

  async shutdown (signal) {
    if (!this.running) return
    this.running = false

    console.log(`\n[daemon] Shutting down (${signal})...`)

    // Stop resource monitor
    if (this.resourceMonitor) this.resourceMonitor.stop()

    // Stop heartbeat
    if (this.heartbeat) this.heartbeat.stop()

    // Disconnect Pusher
    if (this.pusher) this.pusher.disconnect()

    // Stop A2A server
    if (this.a2aServer) {
      this.a2aServer.close()
      console.log('[a2a] HTTP server stopped')
    }

    // Kill running tasks
    this.executor.killAll()

    // Write final status
    this._writeStatusFile()

    // Mark node offline
    try {
      await this.cloud.markOffline()
      console.log('[daemon] Marked offline')
    } catch { /* best effort */ }

    console.log('[daemon] Goodbye.')
    process.exit(0)
  }
}

module.exports = { Daemon }
