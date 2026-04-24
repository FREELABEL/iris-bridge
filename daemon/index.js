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
const { execSync, spawn } = require('child_process')
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
    this.scheduleRegistry = null
    this.ingestBuffer = [] // received A2A payloads
    this.pendingTaskIds = new Set() // tasks received via Pusher but not yet in executor.runningTasks
    this.recentlyRejectedTasks = new Map() // taskId → timestamp (prevents heartbeat doom loops)
    this.recentlySeenTasks = new Map() // taskId → timestamp (dedup duplicate Pusher events)
    this._browserTaskLock = false // mutex: only one browser task at a time

    // Mesh networking (offline/LAN peer-to-peer)
    this.meshDiscovery = null
    this.meshRegistry = null
    this.meshAuth = null
    this.meshDispatch = null
    this.meshChat = null
    this.meshEnergy = null

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
    console.log(`[daemon] Name: ${this.nodeName}`)
    console.log(`[daemon] User: ${heartbeatResult.user_id ?? 'unknown'}`)
    console.log(`[daemon] API: ${this.config.apiUrl}`)
    console.log(`[daemon] Status: online | Active tasks: ${heartbeatResult.active_tasks}`)
    console.log(`[daemon] Max concurrent: ${process.env.MAX_CONCURRENT || 4}`)

    // Step 1b: Auto-bootstrap IRIS CLI if not installed
    this._userId = heartbeatResult.user_id || null
    await this._bootstrapCLI()

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

    // Step 4b: Start mesh networking (offline/LAN peer-to-peer)
    this._startMesh()

    // Step 5: Start heartbeat loop (with capacity + status + session reporting)
    this.heartbeat = new Heartbeat(this.cloud, 30000)
    this.heartbeat.getStateCallback = () => ({
      capacity: this.resourceMonitor ? this.resourceMonitor.getCapacity() : null,
      paused: this.paused,
      pause_reason: this.pauseReason,
      active_sessions: this._getLocalSessions(),
      local_schedules: this.scheduleRegistry
        ? (() => {
            const list = this.scheduleRegistry.list()
            const running = list.filter(s => s.running === true).length
            if (list.length > 0) {
              console.log(`[heartbeat] Reporting ${list.length} schedules (${running} running) to cloud`)
            }
            return list
          })().map(s => ({
            id: s.id,
            filename: s.filename,
            cron: s.cron,
            enabled: s.enabled !== false,
            running: s.running === true,
            started_at: s.started_at || null,
            last_run: s.last_run || null,
            last_status: s.last_status || null,
            last_duration_ms: s.last_duration_ms || null,
            run_count: s.run_count || 0
          }))
        : [],
      heartbeat_state: this.heartbeat.state,
      local_ip: this._getLocalIp(),
      max_concurrent: parseInt(process.env.MAX_CONCURRENT || '3', 10),
      running_task_ids: [
        ...(this.executor ? [...this.executor.runningTasks.keys()] : []),
        ...this.pendingTaskIds
      ]
    })
    this.heartbeat.onPingCallback = () => {
      this._writeStatusFile()
      this._refreshSessionCache() // refresh session data after each heartbeat
      if (this.scheduleRegistry) this.scheduleRegistry.flushPending().catch(() => {})
    }
    this.heartbeat.start()

    // Step 5b: Start local schedule registry
    this._startScheduleRegistry()

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

    // Queue — show all active/running tasks with details
    app.get(`${prefix}/queue`, (req, res) => {
      const tasks = []
      if (this.executor && this.executor.runningTasks) {
        for (const [taskId, child] of this.executor.runningTasks) {
          tasks.push({
            id: taskId,
            title: child._taskTitle || null,
            type: child._taskType || null,
            pid: child.pid,
            started: child._startedAt ? new Date(child._startedAt).toISOString() : null,
            uptime_s: child._startedAt ? Math.round((Date.now() - child._startedAt) / 1000) : null,
          })
        }
      }
      const capacity = this.resourceMonitor ? this.resourceMonitor.getCapacity() : {}
      res.json({
        active_tasks: tasks.length,
        paused: this.paused,
        capacity: capacity.level || 'unknown',
        tasks,
        pending_local: this.pendingTaskIds || [],
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

    // ─── Script Execution (atomic push + run) ─────────────────────────
    app.post(`${prefix}/execute-script`, (req, res) => {
      const { filename, content, args: scriptArgs, timeout_ms, persist, env: requestEnv } = req.body || {}

      if (!filename || !content) {
        return res.status(400).json({ error: 'filename and content required' })
      }

      // Validate filename — no path separators or traversal
      if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        return res.status(400).json({ error: 'filename must be a plain name (no paths)' })
      }

      const baseDir = this.config.dataDir
      const scriptsDir = path.join(baseDir, 'scripts')
      if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir, { recursive: true })

      const scriptPath = path.join(scriptsDir, filename)
      fs.writeFileSync(scriptPath, content, 'utf-8')
      fs.chmodSync(scriptPath, '755')

      // Auto-detect interpreter
      const ext = path.extname(filename).toLowerCase()
      const interpreters = { '.py': 'python3', '.js': 'node', '.ts': 'npx' }
      const cmd = interpreters[ext] || '/bin/bash'
      const spawnArgs = ext === '.ts' ? ['ts-node', scriptPath, ...(scriptArgs || [])] : [scriptPath, ...(scriptArgs || [])]

      const timeout = Math.min(Math.max(timeout_ms || 30000, 1000), 300000)
      const startTime = Date.now()

      console.log(`[execute-script] Running: ${cmd} ${filename} (timeout: ${timeout}ms, persist: ${!!persist})`)

      // #58002: Merge project env vars (from --project flag) into child process environment
      const childEnv = { ...process.env, ...(requestEnv && typeof requestEnv === 'object' ? requestEnv : {}) }
      const child = spawn(cmd, spawnArgs, {
        cwd: scriptsDir,
        env: childEnv,
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
      }, timeout)

      child.on('close', (code) => {
        clearTimeout(timer)
        const duration = Date.now() - startTime

        // Cleanup unless persist requested
        if (!persist && fs.existsSync(scriptPath)) {
          fs.unlinkSync(scriptPath)
        }

        console.log(`[execute-script] ${filename} → exit ${code} (${duration}ms)${killed ? ' [TIMEOUT]' : ''}`)

        res.json({
          status: killed ? 'timeout' : (code === 0 ? 'completed' : 'failed'),
          exit_code: code,
          stdout: stdout.slice(-50000),
          stderr: stderr.slice(-10000),
          duration_ms: duration,
          script_path: persist ? '/scripts/' + filename : null,
          machine: this.nodeName
        })
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        if (!persist && fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath)
        res.status(500).json({ error: err.message })
      })
    })

    // ─── Schedule Management ──────────────────────────────────────────
    app.get(`${prefix}/schedules`, (req, res) => {
      if (!this.scheduleRegistry) return res.status(503).json({ error: 'Schedule registry not initialized' })
      res.json({ schedules: this.scheduleRegistry.list() })
    })

    app.post(`${prefix}/schedules`, (req, res) => {
      if (!this.scheduleRegistry) return res.status(503).json({ error: 'Schedule registry not initialized' })
      const { filename, cron, args } = req.body || {}
      if (!filename || !cron) return res.status(400).json({ error: 'filename and cron required' })
      try {
        const schedule = this.scheduleRegistry.add(filename, cron, args || [])
        res.json({ status: 'created', schedule })
      } catch (err) {
        res.status(400).json({ error: err.message })
      }
    })

    app.delete(`${prefix}/schedules/:id`, (req, res) => {
      if (!this.scheduleRegistry) return res.status(503).json({ error: 'Schedule registry not initialized' })
      try {
        const schedule = this.scheduleRegistry.remove(req.params.id)
        res.json({ status: 'removed', schedule })
      } catch (err) {
        res.status(404).json({ error: err.message })
      }
    })

    app.post(`${prefix}/schedules/:id/pause`, (req, res) => {
      if (!this.scheduleRegistry) return res.status(503).json({ error: 'Schedule registry not initialized' })
      try {
        const schedule = this.scheduleRegistry.pause(req.params.id)
        res.json({ status: 'paused', schedule })
      } catch (err) {
        res.status(404).json({ error: err.message })
      }
    })

    app.post(`${prefix}/schedules/:id/resume`, (req, res) => {
      if (!this.scheduleRegistry) return res.status(503).json({ error: 'Schedule registry not initialized' })
      try {
        const schedule = this.scheduleRegistry.resume(req.params.id)
        res.json({ status: 'resumed', schedule })
      } catch (err) {
        res.status(404).json({ error: err.message })
      }
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

    // ── Calendar (READ) ─────────────────────────────────────────────
    /**
     * GET /api/calendar/events?start=YYYY-MM-DD&end=YYYY-MM-DD&calendar=<name>&limit=200
     * Read events from Apple Calendar.app via the Calendar.sqlitedb (~50ms).
     * No filters → returns events from -2 days to +14 days.
     */
    app.get(`${prefix}/api/calendar/events`, async (req, res) => {
      if (process.platform !== 'darwin') {
        return res.status(503).json({ error: 'Calendar is only available on macOS' })
      }

      const startStr = (req.query.start || req.query.start_date || '').toString().trim()
      const endStr = (req.query.end || req.query.end_date || '').toString().trim()
      const calendarFilter = (req.query.calendar || req.query.calendar_name || '').toString().trim()
      const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '200', 10)))

      // Apple Cocoa epoch is 2001-01-01 (978307200 unix seconds)
      const COCOA_OFFSET = 978307200

      let startEpoch, endEpoch
      if (startStr) {
        const d = new Date(startStr)
        if (isNaN(d.getTime())) return res.status(400).json({ error: 'invalid start date' })
        startEpoch = Math.floor(d.getTime() / 1000) - COCOA_OFFSET
      } else {
        startEpoch = Math.floor(Date.now() / 1000) - (2 * 86400) - COCOA_OFFSET
      }
      if (endStr) {
        const d = new Date(endStr)
        if (isNaN(d.getTime())) return res.status(400).json({ error: 'invalid end date' })
        endEpoch = Math.floor(d.getTime() / 1000) - COCOA_OFFSET
      } else {
        endEpoch = Math.floor(Date.now() / 1000) + (14 * 86400) - COCOA_OFFSET
      }

      const calendarDbPath = path.join(process.env.HOME, 'Library', 'Calendars', 'Calendar.sqlitedb')
      const calFilterEscaped = calendarFilter.replace(/'/g, "''")

      const sql = `
SELECT
  datetime(ci.start_date + ${COCOA_OFFSET}, 'unixepoch', 'localtime') AS starts,
  datetime(ci.end_date + ${COCOA_OFFSET}, 'unixepoch', 'localtime') AS ends,
  ci.all_day AS all_day,
  COALESCE(c.title, '') AS calendar,
  COALESCE(ci.summary, '') AS title,
  COALESCE(ci.description, '') AS description,
  COALESCE(l.title, '') AS location,
  COALESCE(ci.url, '') AS url
FROM CalendarItem ci
LEFT JOIN Calendar c ON ci.calendar_id = c.ROWID
LEFT JOIN Location l ON ci.location_id = l.ROWID
WHERE ci.start_date IS NOT NULL
  AND ci.summary IS NOT NULL
  AND ci.start_date >= ${startEpoch}
  AND ci.start_date <= ${endEpoch}
  ${calendarFilter ? `AND c.title LIKE '%${calFilterEscaped}%'` : ''}
ORDER BY ci.start_date ASC
LIMIT ${limit}
`.trim()

      try {
        const result = await new Promise((resolve, reject) => {
          const { execFile } = require('child_process')
          execFile(
            '/usr/bin/sqlite3',
            ['-readonly', '-json', '-bail', calendarDbPath, sql],
            { timeout: 10000, maxBuffer: 5 * 1024 * 1024 },
            (err, stdout, stderr) => {
              if (err) {
                const msg = (stderr || err.message || '').trim()
                if (msg.includes('unable to open') || msg.includes('authorization denied')) {
                  return reject(new Error(
                    'Cannot read Calendar.sqlitedb. Grant Full Disk Access to the daemon process ' +
                    'in System Settings > Privacy & Security > Full Disk Access.'
                  ))
                }
                return reject(new Error(`sqlite3: ${msg.slice(0, 300)}`))
              }
              try {
                resolve(stdout.trim() ? JSON.parse(stdout) : [])
              } catch (parseErr) {
                reject(new Error(`sqlite3 JSON parse: ${parseErr.message}`))
              }
            }
          )
        })

        res.json({
          events: result,
          count: result.length,
          start: startStr || 'now-2d',
          end: endStr || 'now+14d',
          calendar: calendarFilter || null,
        })
      } catch (err) {
        console.error(`[calendar/events] Failed: ${err.message}`)
        res.status(500).json({ error: err.message })
      }
    })

    /**
     * GET /api/calendar/list — list all calendars on this Mac
     */
    app.get(`${prefix}/api/calendar/list`, async (req, res) => {
      if (process.platform !== 'darwin') {
        return res.status(503).json({ error: 'Calendar is only available on macOS' })
      }

      const calendarDbPath = path.join(process.env.HOME, 'Library', 'Calendars', 'Calendar.sqlitedb')

      try {
        const result = await new Promise((resolve, reject) => {
          const { execFile } = require('child_process')
          execFile(
            '/usr/bin/sqlite3',
            ['-readonly', '-json', '-bail', calendarDbPath, 'SELECT ROWID, title, color FROM Calendar WHERE title IS NOT NULL ORDER BY title'],
            { timeout: 5000 },
            (err, stdout, stderr) => {
              if (err) return reject(new Error((stderr || err.message).slice(0, 300)))
              try { resolve(stdout.trim() ? JSON.parse(stdout) : []) }
              catch (e) { reject(e) }
            }
          )
        })
        res.json({ calendars: result, count: result.length })
      } catch (err) {
        res.status(500).json({ error: err.message })
      }
    })

    // ── Apps (search + launch) ──────────────────────────────────────
    /**
     * GET /api/apps/search?query=<name>&limit=20
     * Find installed Mac apps via Spotlight.
     */
    app.get(`${prefix}/api/apps/search`, async (req, res) => {
      if (process.platform !== 'darwin') {
        return res.status(503).json({ error: 'App search is only available on macOS' })
      }

      const query = (req.query.query || req.query.name || '').toString().trim()
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || '20', 10)))

      if (!query) {
        return res.status(400).json({ error: 'query param is required' })
      }

      // mdfind: find application bundles whose display name matches
      const queryEscaped = query.replace(/"/g, '\\"')
      const mdfindQuery = `kMDItemContentType == "com.apple.application-bundle" && kMDItemDisplayName == "*${queryEscaped}*"c`

      try {
        const stdout = await new Promise((resolve, reject) => {
          const { execFile } = require('child_process')
          execFile('/usr/bin/mdfind', [mdfindQuery], { timeout: 10000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message).slice(0, 300)))
            resolve(stdout)
          })
        })

        const paths = stdout.split('\n').map((p) => p.trim()).filter(Boolean).slice(0, limit)
        const apps = paths.map((p) => ({
          name: path.basename(p, '.app'),
          path: p,
        }))

        res.json({ apps, count: apps.length, query })
      } catch (err) {
        console.error(`[apps/search] Failed: ${err.message}`)
        res.status(500).json({ error: err.message })
      }
    })

    /**
     * POST /api/apps/open
     * Body: { name?: string, path?: string, args?: string[] }
     * Launch a Mac app by name or absolute path.
     */
    app.post(`${prefix}/api/apps/open`, async (req, res) => {
      if (process.platform !== 'darwin') {
        return res.status(503).json({ error: 'App launch is only available on macOS' })
      }

      const { name, path: appPath, args } = req.body || {}

      if (!name && !appPath) {
        return res.status(400).json({ error: 'either name or path is required' })
      }

      const openArgs = []
      if (appPath) {
        openArgs.push(appPath)
      } else {
        openArgs.push('-a', name)
      }
      if (Array.isArray(args) && args.length > 0) {
        openArgs.push('--args', ...args.map((a) => String(a)))
      }

      try {
        await new Promise((resolve, reject) => {
          const { execFile } = require('child_process')
          execFile('/usr/bin/open', openArgs, { timeout: 10000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message).slice(0, 300)))
            resolve(stdout)
          })
        })

        console.log(`[apps/open] Launched ${name || appPath}`)
        res.json({
          ok: true,
          launched: name || appPath,
          message: `Opened ${name || appPath}`,
        })
      } catch (err) {
        console.error(`[apps/open] Failed: ${err.message}`)
        res.status(500).json({ error: err.message })
      }
    })

    // ── Calendar Create Event (WRITE) ──────────────────────────────
    /**
     * POST /api/calendar/create-event
     * Body: { title, start_date, end_date, calendar_name?, location?, notes?, all_day? }
     * Creates a single event in Calendar.app via AppleScript (single event = fast).
     * Dates accept ISO 8601 ("2026-04-15T14:00:00") or "YYYY-MM-DD HH:MM".
     */
    app.post(`${prefix}/api/calendar/create-event`, async (req, res) => {
      if (process.platform !== 'darwin') {
        return res.status(503).json({ error: 'Calendar is only available on macOS' })
      }

      const { title, start_date, end_date, calendar_name, location, notes, all_day } = req.body || {}

      if (!title || !start_date || !end_date) {
        return res.status(400).json({ error: 'title, start_date, and end_date are required' })
      }

      // Parse dates → AppleScript-friendly format
      const parseDate = (s) => {
        const d = new Date(s.includes('T') || s.includes('Z') ? s : s.replace(' ', 'T'))
        if (isNaN(d.getTime())) return null
        return d
      }

      const startD = parseDate(String(start_date))
      const endD = parseDate(String(end_date))
      if (!startD || !endD) {
        return res.status(400).json({ error: 'invalid start_date or end_date format (use ISO 8601 or YYYY-MM-DD HH:MM)' })
      }

      // AppleScript date construction: build a date object via individual setters.
      // Important AppleScript quirks:
      //   - month must be a month constant (January..December), not an integer
      //   - day must be set BEFORE month (otherwise Feb 31 → March 3 etc.)
      const APPLESCRIPT_MONTHS = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ]
      const buildDateLines = (varName, d) => {
        return [
          `set ${varName} to (current date)`,
          `set year of ${varName} to ${d.getFullYear()}`,
          `set day of ${varName} to 1`, // safe day before changing month
          `set month of ${varName} to ${APPLESCRIPT_MONTHS[d.getMonth()]}`,
          `set day of ${varName} to ${d.getDate()}`,
          `set hours of ${varName} to ${d.getHours()}`,
          `set minutes of ${varName} to ${d.getMinutes()}`,
          `set seconds of ${varName} to 0`,
        ].join('\n')
      }

      const escape = (s) => (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const titleEsc = escape(title)
      const locationEsc = escape(location || '')
      const notesEsc = escape(notes || '')
      const calNameEsc = escape(calendar_name || '')

      // Calendar selection: named calendar if provided, otherwise first writable calendar
      const calendarLine = calendar_name
        ? `set targetCal to (first calendar whose title is "${calNameEsc}")`
        : `set targetCal to first calendar whose writable is true`

      const propsLines = [
        `summary:"${titleEsc}"`,
        `start date:startDate`,
        `end date:endDate`,
      ]
      if (location) propsLines.push(`location:"${locationEsc}"`)
      if (notes) propsLines.push(`description:"${notesEsc}"`)
      if (all_day) propsLines.push(`allday event:true`)

      const script = `
tell application "Calendar"
${buildDateLines('startDate', startD)}
${buildDateLines('endDate', endD)}
  ${calendarLine}
  set newEvent to make new event at end of events of targetCal with properties {${propsLines.join(', ')}}
  return uid of newEvent
end tell
`.trim()

      try {
        const stdout = await new Promise((resolve, reject) => {
          const { execFile } = require('child_process')
          execFile('/usr/bin/osascript', ['-e', script], { timeout: 30000, maxBuffer: 1 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
              const msg = (stderr || err.message || '').trim()
              if (msg.includes('-1743') || msg.includes('not allowed')) {
                return reject(new Error('Calendar.app automation not authorized. Grant access in System Settings > Privacy > Automation.'))
              }
              return reject(new Error(`osascript: ${msg.slice(0, 300)}`))
            }
            resolve(stdout)
          })
        })

        const uid = stdout.trim()
        console.log(`[calendar/create-event] Created "${title}" (uid: ${uid})`)
        res.json({
          ok: true,
          uid,
          title,
          start_date: startD.toISOString(),
          end_date: endD.toISOString(),
          calendar: calendar_name || 'default writable',
          message: `Event "${title}" created`,
        })
      } catch (err) {
        console.error(`[calendar/create-event] Failed: ${err.message}`)
        res.status(500).json({ error: err.message })
      }
    })

    // ── Mail Draft (WRITE — no-send) ───────────────────────────────
    /**
     * POST /api/mail/draft
     * Create a draft email in Apple Mail.app — opens visible compose window
     * but does NOT send. User can review/edit/send manually.
     * Body: { to_email, to_name?, cc_email?, subject, body_text, attachments? }
     */
    app.post(`${prefix}/api/mail/draft`, async (req, res) => {
      if (process.platform !== 'darwin') {
        return res.status(503).json({ error: 'Apple Mail is only available on macOS' })
      }

      const { to_email, to_name, cc_email, subject, body_text, attachments } = req.body || {}

      if (!to_email || !subject || !body_text) {
        return res.status(400).json({ error: 'to_email, subject, and body_text are required' })
      }

      const escapeForAppleScript = (str) => (str || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')

      const escapedTo = escapeForAppleScript(to_email)
      const escapedName = escapeForAppleScript(to_name || to_email)
      const escapedSubject = escapeForAppleScript(subject)
      const escapedBody = escapeForAppleScript(body_text)

      // CC recipients (string or array)
      let ccLines = ''
      if (cc_email) {
        const ccAddresses = Array.isArray(cc_email) ? cc_email : [cc_email]
        ccLines = ccAddresses.map((addr) =>
          `  make new cc recipient at beginning of cc recipients of msg with properties {address:"${escapeForAppleScript(addr)}"}`
        ).join('\n')
      }

      // Attachments (array of absolute file paths)
      let attachmentLines = ''
      if (attachments && Array.isArray(attachments) && attachments.length > 0) {
        attachmentLines = attachments.map((fp) =>
          `  make new attachment with properties {file name:POSIX file "${escapeForAppleScript(fp)}"} at after the last paragraph of content of msg`
        ).join('\n')
      }

      // visible:true makes the compose window open so the user sees the draft.
      // We deliberately do NOT call `send msg` — the message stays as a draft.
      const script = `tell application "Mail"
  set msg to make new outgoing message with properties {subject:"${escapedSubject}", content:"${escapedBody}", visible:true}
  make new to recipient at beginning of to recipients of msg with properties {name:"${escapedName}", address:"${escapedTo}"}
${ccLines}
${attachmentLines}
  activate
end tell`

      try {
        await new Promise((resolve, reject) => {
          const { execFile } = require('child_process')
          execFile('/usr/bin/osascript', ['-e', script], { timeout: 20000 }, (err, stdout, stderr) => {
            if (err) {
              const msg = (stderr || err.message || '').trim()
              if (msg.includes('-1743') || msg.includes('not allowed')) {
                return reject(new Error(
                  'Mail.app automation not authorized. Grant access in System Settings > Privacy > Automation.'
                ))
              }
              return reject(new Error(`osascript: ${msg.slice(0, 300)}`))
            }
            resolve(stdout)
          })
        })

        console.log(`[apple-mail] Draft created for ${to_email}: ${subject}`)
        res.json({
          ok: true,
          provider: 'apple-mail',
          status: 'draft',
          to_email,
          cc_email: cc_email || null,
          subject,
          message: 'Draft opened in Mail.app — review and send manually',
        })
      } catch (err) {
        console.error(`[apple-mail] Draft failed: ${err.message}`)
        res.status(500).json({ error: `Apple Mail draft failed: ${err.message}` })
      }
    })

    // ── Mail + iMessage Search (READ) ──────────────────────────────
    // These endpoints provide read-only access to Apple Mail and iMessage
    // for the macOS integration. Available in daemon-only mode (no full
    // bridge required). SEND endpoints still live in bridge index.js.

    /**
     * GET /api/imessage/search?handle=<email_or_phone>&days=14&limit=100
     * Read recent iMessages directly from ~/Library/Messages/chat.db
     */
    app.get(`${prefix}/api/imessage/search`, async (req, res) => {
      if (process.platform !== 'darwin') {
        return res.status(503).json({ error: 'iMessage search is only available on macOS' })
      }

      const handle = (req.query.handle || '').toString().trim()
      const days = Math.max(1, Math.min(365, parseInt(req.query.days || '14', 10)))
      const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '100', 10)))

      if (!handle) {
        return res.status(400).json({ error: 'handle query param is required (email or phone)' })
      }

      const digits = handle.replace(/\D/g, '')
      const lower = handle.toLowerCase().replace(/'/g, "''")
      const chatDbPath = path.join(process.env.HOME, 'Library', 'Messages', 'chat.db')

      const sql = `
SELECT
  datetime(m.date/1000000000 + strftime('%s','2001-01-01'), 'unixepoch', 'localtime') AS ts,
  m.is_from_me AS from_me,
  COALESCE(h.id, '') AS sender,
  COALESCE(m.text, '') AS text
FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
WHERE (
  ${digits ? `REPLACE(REPLACE(REPLACE(REPLACE(h.id, '+', ''), '-', ''), ' ', ''), '(', '') LIKE '%${digits}%' OR ` : ''}
  LOWER(h.id) LIKE '%${lower}%'
)
  AND m.date > (strftime('%s','now','-${days} days') - strftime('%s','2001-01-01')) * 1000000000
  AND m.text IS NOT NULL
ORDER BY m.date DESC
LIMIT ${limit}
`.trim()

      try {
        const result = await new Promise((resolve, reject) => {
          const { execFile } = require('child_process')
          execFile(
            '/usr/bin/sqlite3',
            ['-readonly', '-json', '-bail', chatDbPath, sql],
            { timeout: 15000, maxBuffer: 5 * 1024 * 1024 },
            (err, stdout, stderr) => {
              if (err) {
                const msg = (stderr || err.message || '').trim()
                if (msg.includes('unable to open') || msg.includes('authorization denied')) {
                  return reject(new Error(
                    'Cannot read chat.db. Grant Full Disk Access to the daemon process ' +
                    'in System Settings > Privacy & Security > Full Disk Access.'
                  ))
                }
                return reject(new Error(`sqlite3: ${msg.slice(0, 300)}`))
              }
              try {
                resolve(stdout.trim() ? JSON.parse(stdout) : [])
              } catch (parseErr) {
                reject(new Error(`sqlite3 JSON parse: ${parseErr.message}`))
              }
            }
          )
        })

        res.json({ messages: result, count: result.length, handle, days })
      } catch (err) {
        console.error(`[imessage/search] Failed: ${err.message}`)
        res.status(500).json({ error: err.message })
      }
    })

    /**
     * GET /api/mail/search?from=<sender>&days=14&limit=20&include_body=1
     * Search Apple Mail by sender using the Envelope Index sqlite db.
     * 100x faster than AppleScript — instant results from the Mail.app index.
     *
     * Bodies are NOT in the index — they live in .emlx files on disk.
     * If include_body=1, we read each .emlx and extract a snippet.
     */
    app.get(`${prefix}/api/mail/search`, async (req, res) => {
      if (process.platform !== 'darwin') {
        return res.status(503).json({ error: 'Mail search is only available on macOS' })
      }

      const from = (req.query.from || '').toString().trim()
      const days = Math.max(1, Math.min(365, parseInt(req.query.days || '14', 10)))
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || '20', 10)))
      const includeBody = req.query.include_body === '1' || req.query.include_body === 'true'

      if (!from) {
        return res.status(400).json({ error: 'from query param is required (email or name substring)' })
      }

      // Locate the Envelope Index — try V10 first, fall back to V9, V8
      const mailRoot = path.join(process.env.HOME, 'Library', 'Mail')
      let envelopePath = null
      try {
        for (const v of ['V10', 'V9', 'V8']) {
          const candidate = path.join(mailRoot, v, 'MailData', 'Envelope Index')
          if (fs.existsSync(candidate)) {
            envelopePath = candidate
            break
          }
        }
      } catch { /* ignore */ }

      if (!envelopePath) {
        return res.status(503).json({ error: 'Apple Mail Envelope Index not found. Is Mail.app set up?' })
      }

      const fromEscaped = from.replace(/'/g, "''")
      const cutoffEpoch = Math.floor(Date.now() / 1000) - (days * 86400)

      // Note: Mail caches a summary preview in the `summaries` table — much
      // faster than parsing .emlx files. We always fetch it but only return
      // it as `body` when include_body=1.
      const sql = `
SELECT
  datetime(m.date_received, 'unixepoch', 'localtime') AS ts,
  a.address AS email,
  a.comment AS name,
  s.subject AS subject,
  COALESCE(sum.summary, '') AS body
FROM messages m
JOIN addresses a ON m.sender = a.ROWID
JOIN subjects s ON m.subject = s.ROWID
LEFT JOIN summaries sum ON m.summary = sum.ROWID
WHERE (a.address LIKE '%${fromEscaped}%' OR a.comment LIKE '%${fromEscaped}%')
  AND m.date_received > ${cutoffEpoch}
ORDER BY m.date_received DESC
LIMIT ${limit}
`.trim()

      try {
        const result = await new Promise((resolve, reject) => {
          const { execFile } = require('child_process')
          execFile(
            '/usr/bin/sqlite3',
            ['-readonly', '-json', '-bail', envelopePath, sql],
            { timeout: 10000, maxBuffer: 5 * 1024 * 1024 },
            (err, stdout, stderr) => {
              if (err) {
                const msg = (stderr || err.message || '').trim()
                if (msg.includes('unable to open') || msg.includes('authorization denied')) {
                  return reject(new Error(
                    'Cannot read Mail Envelope Index. Grant Full Disk Access to the daemon process ' +
                    'in System Settings > Privacy & Security > Full Disk Access.'
                  ))
                }
                return reject(new Error(`sqlite3: ${msg.slice(0, 300)}`))
              }
              try {
                resolve(stdout.trim() ? JSON.parse(stdout) : [])
              } catch (parseErr) {
                reject(new Error(`sqlite3 JSON parse: ${parseErr.message}`))
              }
            }
          )
        })

        const messages = result.map((row) => ({
          date: row.ts || '',
          sender: row.name ? `${row.name} <${row.email}>` : row.email,
          subject: row.subject || '',
          // Summary is the Mail.app cached preview (~1KB). Truncate if too long.
          body: includeBody ? (row.body || '').slice(0, 1500) : '',
        }))

        res.json({ messages, count: messages.length, from, days })
      } catch (err) {
        console.error(`[mail/search] Failed: ${err.message}`)
        res.status(500).json({ error: err.message })
      }
    })

    // Mesh networking routes (offline/LAN peer-to-peer)
    this._registerMeshRoutes(app, prefix)

    // In embedded mode, routes are already mounted on the bridge — no new server needed
    if (useEmbedded) {
      console.log(`[daemon] Daemon endpoints mounted at /daemon/* on bridge server`)
      console.log(`[daemon] Endpoints: /daemon/health /daemon/queue /daemon/capacity /daemon/pause /daemon/resume /daemon/sessions /daemon/files /daemon/processes`)
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      const bindHost = process.env.BRIDGE_BIND_HOST || '127.0.0.1'
      this.a2aServer = app.listen(a2aPort, bindHost, () => {
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
    const ts = new Date().toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    console.log(`[daemon] [${ts}] Task dispatched: ${event.task_id} — "${event.title}"`)

    // ── Dedup: skip duplicate Pusher events for the same task_id within 10s window
    const DEDUP_COOLDOWN_MS = 10 * 1000 // 10 seconds
    const lastSeen = this.recentlySeenTasks.get(event.task_id)
    if (lastSeen && (Date.now() - lastSeen) < DEDUP_COOLDOWN_MS) {
      console.log(`[daemon] DEDUP: Task ${event.task_id.substring(0, 8)} already received ${Math.round((Date.now() - lastSeen) / 1000)}s ago — ignoring duplicate Pusher event`)
      return
    }
    this.recentlySeenTasks.set(event.task_id, Date.now())
    // Clean up old dedup entries (> 60s)
    for (const [id, time] of this.recentlySeenTasks) {
      if (Date.now() - time > 60 * 1000) this.recentlySeenTasks.delete(id)
    }

    // Also skip if this task is already running in the executor
    if (this.executor && this.executor.runningTasks.has(event.task_id)) {
      console.log(`[daemon] DEDUP: Task ${event.task_id.substring(0, 8)} already running in executor — ignoring`)
      return
    }

    // ── Dedup: skip tasks we already rejected recently (prevents heartbeat doom loops)
    const REJECT_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes
    const lastRejected = this.recentlyRejectedTasks.get(event.task_id)
    if (lastRejected && (Date.now() - lastRejected) < REJECT_COOLDOWN_MS) {
      console.log(`[daemon] SKIP: Task ${event.task_id.substring(0, 8)} was rejected ${Math.round((Date.now() - lastRejected) / 1000)}s ago — ignoring`)
      return
    }
    // Clean up old entries (> 10 min)
    for (const [id, time] of this.recentlyRejectedTasks) {
      if (Date.now() - time > 10 * 60 * 1000) this.recentlyRejectedTasks.delete(id)
    }

    // Track immediately so heartbeat includes this task (prevents orphan race condition)
    this.pendingTaskIds.add(event.task_id)

    // Pre-flight checks (singleton + browser count) run AFTER task fetch
    // because Pusher events don't include task.type — see post-fetch checks below.

    const isBrowserTask = false // lock disabled — max concurrent handles throttling

    // Reject if at capacity
    const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '4', 10)
    const activeTasks = this.executor ? this.executor.runningTasks.size : 0
    if (activeTasks >= MAX_CONCURRENT) {
      console.log(`[daemon] Deferring task ${event.task_id} — ${activeTasks} tasks running (max ${MAX_CONCURRENT})`)
      this.pendingTaskIds.delete(event.task_id)
      this.recentlyRejectedTasks.set(event.task_id, Date.now())
      try {
        await this.cloud.submitResult(event.task_id, {
          status: 'failed',
          error: `Node at capacity (${activeTasks}/${MAX_CONCURRENT} tasks running). Will retry on next schedule.`
        })
      } catch { /* best effort */ }
      return
    }

    // Reject if paused or hibernating
    if (this.paused) {
      console.log(`[daemon] Rejecting task ${event.task_id} — node is ${this.pauseReason === 'battery' ? 'hibernating (battery)' : 'paused'}`)
      this.pendingTaskIds.delete(event.task_id)
      try {
        await this.cloud.submitResult(event.task_id, {
          status: 'failed',
          error: `Node ${this.pauseReason === 'battery' ? 'hibernating (on battery)' : 'paused by user'}`
        })
      } catch { /* best effort */ }
      return
    }

    try {
      // Fetch full task details (retry with backoff — Pusher event can arrive before DB commit)
      let task
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          task = await this.cloud.fetchTask(event.task_id)
          break
        } catch (fetchErr) {
          if (attempt < 2 && fetchErr.message?.includes('404')) {
            console.log(`[daemon] Task fetch retry ${attempt + 1}/3 (waiting for DB commit)...`)
            await new Promise(r => setTimeout(r, (attempt + 1) * 1000))
          } else {
            throw fetchErr
          }
        }
      }

      // ── Pre-flight: singleton type check (AFTER fetch, we now have task.type) ──
      const singletonTypesPost = ['som_batch', 'discover', 'enrich_batch', 'inbox_scan']
      if (task && singletonTypesPost.includes(task.type)) {
        const executorRunning = (this.executor?._runningTasks || []).map(t => t.type)
        if (executorRunning.includes(task.type)) {
          console.log(`[daemon] ⏭ SINGLETON: Rejecting ${task.type} (${event.task_id.substring(0, 12)}) — another ${task.type} is already running`)
          this.pendingTaskIds.delete(event.task_id)
          try {
            await this.cloud.submitResult(event.task_id, {
              status: 'failed',
              error: `Singleton: another ${task.type} is already running on this node`
            })
          } catch {}
          return
        }
      }

      // ── Pre-flight: Chrome process count (AFTER fetch, we know if it's a browser task) ──
      const browserTaskTypes = ['som_batch', 'discover', 'enrich_batch', 'leadgen', 'som']
      if (task && browserTaskTypes.includes(task.type)) {
        try {
          const { execSync } = require('child_process')
          // Count Playwright processes only — NEVER count Chrome Helper (that's the user's real browser)
          const playwrightCount = parseInt(execSync("ps aux | grep -c '[p]laywright'", { encoding: 'utf-8' }).trim(), 10) || 0
          if (playwrightCount > 6) {
            console.log(`[daemon] ⚠️ PRE-FLIGHT: ${playwrightCount} Playwright processes — rejecting ${task.type}`)
            this.pendingTaskIds.delete(event.task_id)
            try {
              await this.cloud.submitResult(event.task_id, {
                status: 'failed',
                error: `Too many Playwright processes (${playwrightCount})`
              })
            } catch {}
            return
          }
        } catch {}
      }

      // Accept the task (ignore "already running" — task may have been auto-accepted on dispatch)
      try {
        await this.cloud.acceptTask(event.task_id)
        console.log(`[daemon] Accepted task: ${event.task_id}`)
      } catch (acceptErr) {
        if (acceptErr.message?.includes('running') || acceptErr.message?.includes('422')) {
          console.log(`[daemon] Task already running — proceeding with execution`)
        } else {
          throw acceptErr
        }
      }

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

  // ─── CLI Auto-Bootstrap ──────────────────────────────────────────

  async _bootstrapCLI () {
    const irisCmd = path.join(os.homedir(), '.iris', 'bin', 'iris')

    if (fs.existsSync(irisCmd)) {
      try {
        const version = execSync(`"${irisCmd}" --version 2>/dev/null`, { encoding: 'utf-8', timeout: 5000 }).trim()
        console.log(`[daemon] IRIS CLI available: ${version || 'installed'}`)
      } catch {
        console.log('[daemon] IRIS CLI found at ~/.iris/bin/iris')
      }
      return
    }

    console.log('[daemon] IRIS CLI not found — bootstrapping...')

    try {
      // Download and run installer in silent mode (--only-code = just the binary)
      const token = this.config.apiKey || ''
      const userId = this._userId || '0'
      const installCmd = [
        'curl -fsSL https://heyiris.io/install-iris.sh',
        '|',
        'bash -s --',
        '--only-code',
        token ? `--token ${token}` : '',
        userId !== '0' ? `--user-id ${userId}` : ''
      ].filter(Boolean).join(' ')

      execSync(installCmd, {
        encoding: 'utf-8',
        timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NONINTERACTIVE: '1' }
      })

      if (fs.existsSync(irisCmd)) {
        console.log('[daemon] IRIS CLI installed at ~/.iris/bin/iris')
      } else {
        console.warn('[daemon] CLI install completed but binary not found — scripts using `iris` may fail')
      }
    } catch (err) {
      console.warn(`[daemon] CLI bootstrap failed (non-blocking): ${err.message}`)
      console.warn('[daemon] Scripts using `iris` CLI will fail. Install manually: curl -fsSL https://heyiris.io/install-iris.sh | bash')
    }
  }

  // ─── Local Schedule Registry ─────────────────────────────────────

  _startScheduleRegistry () {
    try {
      const { ScheduleRegistry } = require('./schedule-registry')
      this.scheduleRegistry = new ScheduleRegistry(this.config, this.cloud)
      this.scheduleRegistry.start()
    } catch (err) {
      console.warn('[schedules] Failed to start schedule registry:', err.message)
    }
  }

  // ─── Local Session Discovery ────────────────────────────────────
  // ── Mesh Networking ──────────────────────────────────────────────

  _startMesh () {
    const a2aPort = parseInt(process.env.A2A_PORT || '3200', 10)

    try {
      const MeshDiscovery = require('./mesh-discovery')
      const MeshRegistry = require('./mesh-registry')
      const MeshAuth = require('./mesh-auth')
      const MeshDispatch = require('./mesh-dispatch')
      const MeshChat = require('./mesh-chat')
      const MeshEnergy = require('./mesh-energy')

      this.meshAuth = new MeshAuth()
      this.meshRegistry = new MeshRegistry({ ownNodeName: this.nodeName })
      this.meshDiscovery = new MeshDiscovery({ nodeName: this.nodeName, port: a2aPort, nodeId: this.nodeId })
      this.meshDispatch = new MeshDispatch({ registry: this.meshRegistry, auth: this.meshAuth, ownNodeName: this.nodeName })
      this.meshChat = new MeshChat({ registry: this.meshRegistry, auth: this.meshAuth, ownNodeName: this.nodeName })
      this.meshEnergy = new MeshEnergy({ registry: this.meshRegistry, auth: this.meshAuth, resourceMonitor: this.resourceMonitor, ownNodeName: this.nodeName })

      // Wire discovery → registry
      this.meshDiscovery.on('peer-up', (peer) => {
        this.meshRegistry.addPeer(peer.name, peer.ip || peer.host, peer.port, 'mdns')
      })
      this.meshDiscovery.on('peer-down', (peer) => {
        this.meshRegistry.updatePeerStatus(peer.name, 'offline')
      })

      this.meshDiscovery.start()
      this.meshRegistry.startHealthChecks(15000)
      this.meshEnergy.start()

      console.log('[mesh] Mesh networking started')
    } catch (err) {
      console.warn('[mesh] Failed to start mesh networking:', err.message)
    }
  }

  _pushMeshResult (originNode, taskId, status, result, error) {
    if (!this.meshRegistry) return
    const peer = this.meshRegistry.getPeer(originNode)
    if (!peer || peer.status !== 'online') return

    const payload = JSON.stringify({
      type: 'mesh_task_result',
      task_id: taskId,
      status,
      result: result || null,
      error: error || null,
      from_node: this.nodeName,
      timestamp: new Date().toISOString()
    })

    const pfx = peer.prefix ?? ''
    const http = require('http')
    const req = http.request({
      host: peer.host,
      port: peer.port,
      path: `${pfx}/ingest`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 5000
    })
    req.on('error', () => { /* best effort */ })
    req.end(payload)
  }

  _stopMesh () {
    if (this.meshEnergy) this.meshEnergy.stop()
    if (this.meshRegistry) this.meshRegistry.stopHealthChecks()
    if (this.meshDiscovery) this.meshDiscovery.stop()
    console.log('[mesh] Mesh networking stopped')
  }

  /**
   * Register mesh HTTP routes on the Express app.
   * Called from startA2AServer() with the Express app and prefix.
   */
  _registerMeshRoutes (app, prefix) {
    if (!this.meshAuth || !this.meshRegistry) return

    const meshProtect = this.meshAuth.middleware()

    // ── Discovery & Registry (unprotected) ──────────────────────

    app.get(`${prefix}/mesh/peers`, (req, res) => {
      res.json({ peers: this.meshRegistry.getAllPeers(), node: this.nodeName })
    })

    app.post(`${prefix}/mesh/peers`, (req, res) => {
      const { host, port, psk } = req.body || {}
      if (!host) return res.status(400).json({ error: 'host required' })
      const peer = this.meshRegistry.addPeer(host, host, port || 3200, 'manual')
      if (psk) this.meshRegistry.setPeerKey(host, psk)
      res.json({ peer })
    })

    app.delete(`${prefix}/mesh/peers/:name`, (req, res) => {
      this.meshRegistry.removePeer(req.params.name)
      res.json({ ok: true })
    })

    // ── Auth / Pairing (unprotected) ────────────────────────────

    app.post(`${prefix}/mesh/invite`, (req, res) => {
      const invite = this.meshAuth.generateInvite()
      res.json(invite)
    })

    app.post(`${prefix}/mesh/pair`, (req, res) => {
      const { code, node_name, host, port } = req.body || {}
      if (!code) return res.status(400).json({ error: 'code required' })
      try {
        const result = this.meshAuth.acceptInvite(code, node_name)
        // Register the peer with their PSK so the inviter can also initiate requests
        if (node_name) {
          const peerHost = host || req.ip || req.socket.remoteAddress
          const peerPort = port || 3200
          this.meshRegistry.addPeer(node_name, peerHost, peerPort, 'paired')
          this.meshRegistry.setPeerKey(node_name, result.psk)
        }
        res.json({ psk: result.psk, peer_name: this.nodeName })
      } catch (err) {
        res.status(400).json({ error: err.message })
      }
    })

    // ── Task Dispatch (protected) ───────────────────────────────

    app.post(`${prefix}/mesh/task`, meshProtect, async (req, res) => {
      const task = req.body
      if (!task || !task.type) return res.status(400).json({ error: 'task with type required' })

      const taskId = task.id || require('crypto').randomUUID()
      task.id = taskId

      this.meshDispatch.trackTask(taskId, 'accepted')
      res.json({ task_id: taskId, status: 'accepted' })

      // Execute asynchronously, then push result back to originator's /ingest
      try {
        const result = await this.executor.execute(task)
        this.meshDispatch.trackTask(taskId, 'completed', result)
        // Send result back to originator if we know them
        if (task.origin_node) {
          this._pushMeshResult(task.origin_node, taskId, 'completed', result)
        }
      } catch (err) {
        this.meshDispatch.trackTask(taskId, 'failed', null, err.message)
        if (task.origin_node) {
          this._pushMeshResult(task.origin_node, taskId, 'failed', null, err.message)
        }
      }
    })

    app.get(`${prefix}/mesh/task/:id/status`, (req, res) => {
      const status = this.meshDispatch.getTaskStatus(req.params.id)
      if (!status) return res.status(404).json({ error: 'Task not found' })
      res.json(status)
    })

    // ── Chat (protected) ────────────────────────────────────────

    app.post(`${prefix}/mesh/chat`, meshProtect, (req, res) => {
      const msg = req.body
      if (!msg || !msg.text) return res.status(400).json({ error: 'message with text required' })
      this.meshChat.receiveMessage(msg)
      res.json({ ok: true })
    })

    app.get(`${prefix}/mesh/chat`, (req, res) => {
      const { since, peer } = req.query
      res.json({ messages: this.meshChat.getMessages({ since, peer }), node: this.nodeName })
    })

    app.get(`${prefix}/mesh/chat/poll`, async (req, res) => {
      const msg = await this.meshChat.waitForMessage(30000)
      if (msg) {
        res.json({ message: msg })
      } else {
        res.status(204).end()
      }
    })

    // ── Energy Alerts (protected receive, public read) ──────────

    app.post(`${prefix}/mesh/energy`, meshProtect, (req, res) => {
      this.meshEnergy.receiveAlert(req.body || {})
      res.json({ ok: true })
    })

    app.get(`${prefix}/mesh/energy`, (req, res) => {
      res.json({ alerts: this.meshEnergy.getAlerts() })
    })
  }

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

    // Stop mesh networking
    this._stopMesh()

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
