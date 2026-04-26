/**
 * TaskExecutor — Runs tasks on sovereign hardware.
 *
 * Creates an isolated workspace per task, spawns iris-code as a child
 * process, streams progress to the hub, and collects results.
 *
 * Security philosophy (adapted from Browser Use's hardening model):
 *   - Each task gets its own workspace directory — no cross-contamination
 *   - The executor should never expose cloud credentials to spawned processes
 *   - Environment variables are the attack surface — strip before spawning
 *
 * Gateway architecture (TODO — HiveGateway protocol):
 *   SovereignGateway  → local Ollama, local files, no proxy needed
 *   ProxiedGateway    → routes through iris-api for cloud services
 *   HybridGateway     → local-first, cloud-optional (our differentiator)
 *
 * The agent code shouldn't know which gateway it's using. Same interface,
 * same behavior, different backend. This is how we stay hardware-agnostic
 * while the giants remain trapped in their walled gardens.
 */

const { spawn, execSync, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const https = require('https')
const http = require('http')

// Resolve a Node 18+ binary path for child processes (Playwright requirement)
function resolveNode18Path () {
  const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node')
  if (!fs.existsSync(nvmDir)) return null
  for (const major of [22, 20, 18]) {
    try {
      const dirs = fs.readdirSync(nvmDir).filter(d => d.startsWith(`v${major}.`)).sort().reverse()
      if (dirs.length > 0) {
        const binDir = path.join(nvmDir, dirs[0], 'bin')
        if (fs.existsSync(path.join(binDir, 'node'))) return binDir
      }
    } catch { /* skip */ }
  }
  return null
}

const _node18BinDir = resolveNode18Path()

/**
 * Sanitize a process name to prevent shell injection.
 * Only allows alphanumeric, dash, underscore, and dot.
 * @param {string} name - Raw process name from task config
 * @returns {string} Sanitized name safe for shell interpolation
 */
function sanitizeProcessName (name) {
  const clean = String(name || '').replace(/[^a-zA-Z0-9._-]/g, '')
  if (!clean || clean.length > 128) {
    throw new Error(`Invalid process name: must be 1-128 chars of [a-zA-Z0-9._-], got: "${String(name || '').substring(0, 50)}"`)
  }
  return clean
}

/**
 * Split a prompt string into key=value tokens, preserving values that contain spaces.
 * e.g. "courses limit=20 strategy=AI Course | V3 dry=1"
 * → ["courses", "limit=20", "strategy=AI Course | V3", "dry=1"]
 */
function parseKeyValuePrompt (prompt) {
  const tokens = []
  // Split on whitespace that is followed by a word= pattern (lookahead)
  // This keeps "AI Course | V3" together as part of strategy=...
  const parts = prompt.split(/\s+(?=\w+=)/)
  for (const part of parts) {
    // The first part might have the campaign name before a space
    if (!part.includes('=') && tokens.length === 0) {
      // "courses limit=20..." — first token before any key=value
      const spaceIdx = part.indexOf(' ')
      if (spaceIdx > 0) {
        tokens.push(part.slice(0, spaceIdx))
        tokens.push(part.slice(spaceIdx + 1))
      } else {
        tokens.push(part)
      }
    } else {
      tokens.push(part.trim())
    }
  }
  return tokens
}

// Load project .env vars that child processes need (n8n, etc.)
// Cached so we only read from disk once per daemon session.
let _projectEnvCache = null
function loadProjectEnv () {
  if (_projectEnvCache !== null) return _projectEnvCache
  _projectEnvCache = {}
  const envKeys = ['N8N_EMAIL', 'N8N_PASSWORD', 'N8N_URL', 'N8N_WORKFLOW_ID']
  // 1. Check ~/.iris/bridge/.env
  const bridgeEnv = path.join(os.homedir(), '.iris', 'bridge', '.env')
  // 2. Check freelabel fl-docker-dev/.env
  const flPath = findFreelabelPath()
  const flEnv = flPath ? path.join(flPath, 'fl-docker-dev', '.env') : null
  for (const envFile of [bridgeEnv, flEnv]) {
    if (!envFile || !fs.existsSync(envFile)) continue
    try {
      const lines = fs.readFileSync(envFile, 'utf-8').split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq < 1) continue
        const key = trimmed.slice(0, eq).trim()
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
        if (envKeys.includes(key) && val && !_projectEnvCache[key]) {
          _projectEnvCache[key] = val
        }
      }
    } catch { /* skip */ }
  }
  if (Object.keys(_projectEnvCache).length > 0) {
    console.log(`[executor] Loaded project env: ${Object.keys(_projectEnvCache).join(', ')}`)
  }
  return _projectEnvCache
}

// Auto-detect freelabel project root (looks for som:creators npm script)
/**
 * SOM Preflight — check if a campaign has eligible leads BEFORE launching Chromium.
 * Uses /leads/outreach-funnel for step-by-step breakdown.
 * Returns { eligible: number, total: number, skip: boolean, reason: string, nextStep: object|null }
 */
async function somPreflightCheck (boardId, strategy) {
  const apiBase = process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io'
  const apiToken = process.env.HEYIRIS_TOKEN || 'ca54cd87e7046098eee99de3b9c98cfd'
  const prefix = '[preflight]'

  try {
    let url = `${apiBase}/api/v1/leads/outreach-funnel?bloq_id=${boardId}`
    if (strategy) url += `&strategy=${encodeURIComponent(strategy)}`

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      // Fallback to /leads/stats if funnel endpoint not available
      console.log(`${prefix} ⚠️  Funnel API returned ${res.status} — falling back to stats`)
      const statsUrl = `${apiBase}/api/v1/leads/stats?bloq_id=${boardId}`
      const statsRes = await fetch(statsUrl, {
        headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      })
      if (!statsRes.ok) return { eligible: -1, total: -1, skip: false, reason: 'api_error' }
      const statsJson = await statsRes.json()
      const eng = statsJson.data?.engagement || {}
      const eligible = (eng.never_contacted || 0) + (eng.outreach_pending || 0)
      const total = statsJson.data?.total_leads || 0
      if (eligible === 0) return { eligible: 0, total, skip: true, reason: `All ${total} leads completed` }
      return { eligible, total, skip: false, reason: `${eligible} eligible (fallback)` }
    }

    const json = await res.json()
    const data = json.data || {}
    const total = data.total_leads || 0
    const neverContacted = data.never_contacted || 0
    const steps = data.steps || []
    const nextAction = data.next_action
    const summary = data.summary || {}

    if (total === 0) {
      return { eligible: 0, total: 0, skip: true, reason: `Board ${boardId} has 0 leads` }
    }

    // Log the funnel for visibility
    if (steps.length > 0) {
      for (const s of steps) {
        console.log(`${prefix}   Step ${s.step} "${s.title}": ${s.completed}/${s.eligible} (${s.conversion}%)`)
      }
    }
    if (neverContacted > 0) {
      console.log(`${prefix}   Never contacted: ${neverContacted}`)
    }

    // Skip decision: Playwright's default mode is filter=new — it only contacts leads
    // that have NO outreach steps at all (.fa-paper-plane icon absent in UI).
    // So "never_contacted" is the correct signal for the skip decision.
    // The funnel steps (DM Invite → Follow Up → etc.) are for visibility/dashboards,
    // but the daemon should skip when there are NO new leads to contact.
    if (neverContacted === 0) {
      // Log what's left in the pipeline for visibility
      const stepSummary = steps.filter(s => s.pending > 0).map(s => `${s.title}: ${s.pending} pending`).join(', ')
      return {
        eligible: 0, total, skip: true,
        reason: `All ${total} leads already contacted` + (stepSummary ? ` (follow-up pipeline: ${stepSummary})` : ''),
        nextStep: nextAction,
      }
    }

    return {
      eligible: neverContacted, total, skip: false,
      reason: `${neverContacted} new leads to contact` + (nextAction ? ` (next: ${nextAction.action})` : ''),
      nextStep: nextAction,
    }
  } catch (err) {
    console.log(`${prefix} ⚠️  Preflight failed: ${err.message} — will run anyway`)
    return { eligible: -1, total: -1, skip: false, reason: 'preflight_error' }
  }
}

function findFreelabelPath () {
  // 1. Explicit env var
  if (process.env.FREELABEL_PATH) {
    const pkg = path.join(process.env.FREELABEL_PATH, 'package.json')
    if (fs.existsSync(pkg)) return process.env.FREELABEL_PATH
  }
  // 2. Read from ~/.iris/config.json
  try {
    const configPath = path.join(os.homedir(), '.iris', 'config.json')
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      if (config.freelabel_path) {
        const pkg = path.join(config.freelabel_path, 'package.json')
        if (fs.existsSync(pkg)) return config.freelabel_path
      }
    }
  } catch { /* continue */ }
  // 3. Relative paths from daemon/ directory
  const candidates = [
    path.resolve(__dirname, '../../..'),  // fl-docker-dev/coding-agent-bridge/daemon/ → freelabel root
    path.resolve(__dirname, '../../../..') // one level up
  ]
  for (const c of candidates) {
    const pkg = path.join(c, 'package.json')
    if (fs.existsSync(pkg)) {
      try {
        const json = JSON.parse(fs.readFileSync(pkg, 'utf-8'))
        if (json.scripts && (json.scripts['som:creators'] || json.scripts['leadgen:creators'] || json.scripts['linkedin:search'])) return c
      } catch { /* continue */ }
    }
  }
  return null
}

// Auto-detect Remotion project root (~/.iris/remotion or freelabel/remotion)
function findRemotionPath () {
  // 1. IRIS install location (any user machine)
  const irisPath = path.join(os.homedir(), '.iris', 'remotion')
  if (fs.existsSync(path.join(irisPath, 'package.json'))) return irisPath
  // 2. Freelabel repo fallback (dev machines)
  const fl = findFreelabelPath()
  if (fl) {
    const repoPath = path.join(fl, 'remotion')
    if (fs.existsSync(path.join(repoPath, 'package.json'))) return repoPath
  }
  return null
}

// Lazy-install Remotion dependencies on first use
async function ensureRemotionInstalled (remotionRoot) {
  const nodeModules = path.join(remotionRoot, 'node_modules')
  if (fs.existsSync(nodeModules)) return
  console.log('[executor] Remotion: first-use install, running npm install...')
  await new Promise((resolve, reject) => {
    const proc = spawn('npm', ['install'], { cwd: remotionRoot, stdio: 'inherit' })
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`npm install failed (exit ${code})`)))
  })
  console.log('[executor] Remotion: dependencies installed.')
}

// Auto-detect fl-api root (looks for artisan binary)
function findFlApiPath () {
  // 1. Explicit env var
  if (process.env.FL_API_PATH && fs.existsSync(path.join(process.env.FL_API_PATH, 'artisan'))) {
    return process.env.FL_API_PATH
  }
  // 2. Relative to this file: ../../fl-api (inside fl-docker-dev)
  const relPath = path.resolve(__dirname, '../../fl-api')
  if (fs.existsSync(path.join(relPath, 'artisan'))) {
    return relPath
  }
  // 3. Walk up from cwd
  let dir = process.cwd()
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'fl-api')
    if (fs.existsSync(path.join(candidate, 'artisan'))) return candidate
    dir = path.dirname(dir)
  }
  return null
}

// Detect if fl-api is running inside Docker
function isDockerMode () {
  try {
    execSync('docker compose ps api --quiet', { stdio: 'pipe', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

class TaskExecutor {
  constructor (cloudClient, workspaceManager) {
    this.cloud = cloudClient
    this.workspaces = workspaceManager
    this.runningTasks = new Map() // taskId → childProcess
    this.flApiPath = findFlApiPath()
    this.dockerMode = null // lazily detected
    const verbose = process.env.DAEMON_VERBOSE || process.env.FL_API_PATH || process.env.FREELABEL_PATH
    if (this.flApiPath) {
      if (verbose) console.log(`[executor] fl-api path: ${this.flApiPath}`)
    } else if (verbose) {
      console.warn('[executor] fl-api not found — artisan tasks will fail. Set FL_API_PATH env var.')
    }
    this.freelabelPath = findFreelabelPath()
    if (this.freelabelPath) {
      if (verbose) console.log(`[executor] freelabel path: ${this.freelabelPath}`)
    } else if (verbose) {
      console.warn('[executor] freelabel root not found — som tasks will fail. Set FREELABEL_PATH env var.')
    }
  }

  // Fallback user_id from ~/.iris/config.json (for chain dispatch when API doesn't include user_id)
  _getConfigUserId () {
    try {
      const configPath = path.join(os.homedir(), '.iris', 'config.json')
      if (fs.existsSync(configPath)) {
        return JSON.parse(fs.readFileSync(configPath, 'utf-8')).user_id || null
      }
    } catch { /* ignore */ }
    return null
  }

  async execute (task) {
    const taskId = task.id
    const runtime = task.runtime || task.config?.runtime || process.env.RUNTIME || 'iris_agent'
    const startTime = Date.now()

    const ts = () => new Date().toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' })

    // ── Dedup: reject if same task type is already running ──
    // Prevents duplicate som_batch / discover when scheduler fires faster than execution
    const singletonTypes = ['som_batch', 'discover', 'enrich_batch', 'inbox_scan']
    if (singletonTypes.includes(task.type)) {
      const runningOfSameType = (this._runningTasks || []).filter(t => t.type === task.type)
      if (runningOfSameType.length > 0) {
        console.log(`[executor] [${ts()}] ⏭ Rejecting duplicate ${task.type} — already running (${runningOfSameType[0].id.substring(0, 12)})`)
        try {
          await this.cloud.submitResult(taskId, {
            status: 'failed',
            error: `Duplicate ${task.type} rejected — another instance is already running`,
            output: '',
            duration_ms: 0
          })
        } catch {}
        return
      }
    }

    // Track running tasks for dedup (cleaned up in finally block at end of execute)
    if (!this._runningTasks) this._runningTasks = []
    this._runningTasks.push({ id: taskId, type: task.type })
    const _cleanupRunning = () => {
      this._runningTasks = (this._runningTasks || []).filter(t => t.id !== taskId)
    }

    const taskShort = taskId.substring(0, 12)
    const timeoutSec = task.timeout_seconds || task.config?.timeout_seconds || 'default'
    const nodeId = task.node_id ? task.node_id.substring(0, 12) : 'unknown'
    const createdAt = task.created_at || task.dispatched_at || 'unknown'
    const age = task.created_at ? Math.round((Date.now() - new Date(task.created_at).getTime()) / 1000) : null

    console.log(`[executor] [${ts()}] ── Starting task ──────────────────────`)
    console.log(`[executor]   ID:       ${taskId}`)
    console.log(`[executor]   Type:     ${task.type}`)
    console.log(`[executor]   Runtime:  ${runtime}`)
    console.log(`[executor]   Title:    ${task.title}`)
    console.log(`[executor]   Node:     ${nodeId}`)
    console.log(`[executor]   Timeout:  ${timeoutSec}s`)
    console.log(`[executor]   Created:  ${createdAt}${age ? ` (${age}s ago)` : ''}`)
    if (task.config) {
      const configKeys = Object.keys(task.config).filter(k => !['timeout_seconds'].includes(k))
      if (configKeys.length > 0) {
        console.log(`[executor]   Config:   ${configKeys.map(k => `${k}=${JSON.stringify(task.config[k]).substring(0, 40)}`).join(', ')}`)
      }
    }
    if (task.prompt) {
      console.log(`[executor]   Prompt:   ${task.prompt.substring(0, 80)}${task.prompt.length > 80 ? '…' : ''}`)
    }

    // Notify Discord: task started
    this.notifyDiscord(task, 'started', 0, [], null).catch(() => {})

    // Create isolated workspace
    const workspace = this.workspaces.create(taskId, task)
    console.log(`[executor]   Workspace: ${workspace.projectDir}`)

    // Set up progress reporting (every 5s)
    let lastProgress = 0
    let outputLines = []
    const progressInterval = setInterval(async () => {
      const progress = this.estimateProgress(outputLines, task)
      if (progress !== lastProgress) {
        lastProgress = progress
        try {
          await this.cloud.reportProgress(taskId, progress, outputLines[outputLines.length - 1] || 'Working...')
        } catch { /* non-critical */ }
      }
    }, 5000)

    // Fetch project credentials if the task needs browser automation
    let credentialFilePath = null
    if (task.config?.bloq_id && task.config?.platform) {
      try {
        console.log(`[executor] Fetching ${task.config.platform} credentials for bloq ${task.config.bloq_id}...`)
        const credResult = await this.cloud.fetchTaskCredentials(taskId)
        if (credResult?.credentials) {
          // For api_key credentials, inject as env vars directly (n8n, etc.)
          if (credResult.env_vars && typeof credResult.env_vars === 'object') {
            task.config.env_vars = task.config.env_vars || {}
            Object.assign(task.config.env_vars, credResult.env_vars)
            console.log(`[executor] Injected ${Object.keys(credResult.env_vars).length} env vars from ${task.config.platform} credentials`)
          }
          // For browser_session credentials, write to file
          if (credResult.credential_type !== 'api_key') {
            credentialFilePath = path.join(workspace.dir, 'session-auth.json')
            fs.writeFileSync(credentialFilePath, JSON.stringify(credResult.credentials), 'utf-8')
            fs.chmodSync(credentialFilePath, '600')
            task.config.env_vars = task.config.env_vars || {}
            task.config.env_vars.BROWSER_SESSION_FILE = credentialFilePath
            console.log(`[executor] Browser session written to ${credentialFilePath}`)
          }
        }
      } catch (err) {
        console.warn(`[executor] No credentials available for task ${taskId}: ${err.message}`)
      }
    }

    try {
      // Delegate to runtime-specific executor if not iris_agent
      let result
      if (runtime !== 'iris_agent') {
        result = await this.runRuntimeProcess(task, runtime, workspace, outputLines)
      } else {
        result = await this.runProcess(task, workspace, outputLines)
      }

      clearInterval(progressInterval)

      // ── Handle login expired — detect [LOGIN_EXPIRED] sentinel in output ──
      const loginExpired = outputLines.some(line => line.includes('[LOGIN_EXPIRED]'))
      if (loginExpired) {
        console.log(`[executor] [${ts()}] Login expired for task ${taskId} — prompting re-auth`)

        // macOS notification
        try {
          execSync(`osascript -e 'display notification "YouTube session expired — sign in to continue" with title "IRIS Daemon" sound name "Ping"'`)
        } catch { /* non-critical — notification may fail in non-GUI contexts */ }

        // Terminal prompt
        console.log('')
        console.log('  ┌──────────────────────────────────────────────────┐')
        console.log('  │  ⚠  YouTube login expired!                       │')
        console.log('  │  A browser will open — sign into YouTube,        │')
        console.log('  │  then the task will retry automatically.          │')
        console.log('  │                                                   │')
        console.log('  │  Press ENTER to open browser, or Ctrl+C to skip. │')
        console.log('  └──────────────────────────────────────────────────┘')
        console.log('')

        // Wait for user to press Enter (or auto-continue after 5 min)
        try {
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              console.log('[executor] Re-auth timed out after 5 minutes — skipping')
              reject(new Error('Re-auth prompt timed out'))
            }, 5 * 60 * 1000)

            // If stdin is a TTY, wait for Enter; otherwise auto-proceed
            if (process.stdin.isTTY) {
              process.stdin.setRawMode(false)
              process.stdin.resume()
              process.stdin.once('data', () => {
                clearTimeout(timeout)
                process.stdin.pause()
                resolve()
              })
            } else {
              // Non-interactive — auto-proceed after 3s (notification is the signal)
              setTimeout(() => { clearTimeout(timeout); resolve() }, 3000)
            }
          })
        } catch {
          // Timed out — submit as failed and move on
          await this.cloud.submitResult(taskId, {
            status: 'failed',
            error: 'Login expired — re-auth timed out',
            output: outputLines.join('\n'),
            duration_ms: Date.now() - startTime
          })
          this.notifyDiscord(task, 'failed', Date.now() - startTime, outputLines, 'Login expired — user did not re-auth').catch(() => {})
          return
        }

        // Launch headed save-session
        console.log('[executor] Launching YouTube re-auth browser...')
        const freelabelRoot = this.freelabelPath || findFreelabelPath()
        try {
          execSync('npx playwright test tests/e2e/save-youtube-session.spec.ts --headed --timeout 600000', {
            cwd: freelabelRoot,
            stdio: 'inherit',
            timeout: 10 * 60 * 1000
          })
          console.log('[executor] YouTube session saved! Retrying task...')
        } catch (authErr) {
          console.error(`[executor] Re-auth failed: ${authErr.message}`)
          await this.cloud.submitResult(taskId, {
            status: 'failed',
            error: 'Login expired — re-auth failed',
            output: outputLines.join('\n'),
            duration_ms: Date.now() - startTime
          })
          this.notifyDiscord(task, 'failed', Date.now() - startTime, outputLines, 'Login expired — re-auth failed').catch(() => {})
          return
        }

        // Retry the original task
        const retryOutputLines = []
        outputLines.push('[executor] Retrying after re-auth...')
        result = await this.runProcess(task, workspace, retryOutputLines)
        outputLines.push(...retryOutputLines)

        // If it fails again, give up
        const stillExpired = retryOutputLines.some(line => line.includes('[LOGIN_EXPIRED]'))
        if (stillExpired) {
          console.error('[executor] Still not logged in after re-auth — giving up')
          await this.cloud.submitResult(taskId, {
            status: 'failed',
            error: 'Login expired — re-auth succeeded but still not logged in',
            output: outputLines.join('\n'),
            duration_ms: Date.now() - startTime
          })
          this.notifyDiscord(task, 'failed', Date.now() - startTime, outputLines, 'Still not logged in after re-auth').catch(() => {})
          return
        }
      }

      // Collect output files
      const files = this.workspaces.collectOutputFiles(taskId)

      // Submit result (truncate output to avoid oversized payloads that lose the status field)
      const fullOutput = outputLines.join('\n')
      const MAX_OUTPUT = 50000 // 50KB max
      const truncatedOutput = fullOutput.length > MAX_OUTPUT
        ? '... (truncated) ...\n' + fullOutput.slice(-MAX_OUTPUT)
        : fullOutput

      // For browser tasks, non-zero exit doesn't mean total failure —
      // e.g. discover tasks scrape successfully but Playwright exits non-zero
      // because the n8n chat interaction failed or the wait was interrupted.
      const taskStatus = result.exitCode === 0 ? 'completed' : 'completed_with_warnings'
      await this.cloud.submitResult(taskId, {
        status: taskStatus,
        output: truncatedOutput,
        files,
        duration_ms: Date.now() - startTime,
        metadata: { exit_code: result.exitCode }
      })

      console.log(`[executor] [${ts()}] Task ${taskId} ${taskStatus} in ${Date.now() - startTime}ms${result.exitCode ? ` (exit code ${result.exitCode})` : ''}`)

      // ── Task chaining REMOVED (Apr 26, 2026) ──
      // All task types (discover, som_batch, inbox_scan) now run as independent scheduled jobs.
      // Chaining was elegant but fragile — caused Chrome/Playwright process explosions when
      // scheduled jobs + chains fired simultaneously (e.g. 3 discovers → 3 som_batches → 3 inbox_scans).
      // Jobs: #761 (discover, hourly), #762 (som_batch, every 2h), #792 (inbox_scan, hourly).

      // ── Auto-chain: remotion/remotion_carousel → upload to CDN + post to Buffer ──
      if ((task.type === 'remotion' || task.type === 'remotion_carousel') && task.config?.auto_publish !== false) {
        const workspaceDir = workspace?.dir || workspace?.projectDir
        if (workspaceDir) {
          // Find all rendered PNGs in workspace (check /slides for carousel, or root for single)
          const slidesDir = path.join(workspaceDir, 'slides')
          const searchDirs = [slidesDir, workspaceDir]
          let pngFiles = []
          for (const dir of searchDirs) {
            try {
              if (fs.existsSync(dir)) {
                const entries = fs.readdirSync(dir).filter(f => f.endsWith('.png'))
                pngFiles = entries.map(f => ({ name: f, path: path.join(dir, f) }))
                if (pngFiles.length > 0) break
              }
            } catch { /* skip */ }
          }

          if (pngFiles.length > 0) {
            console.log(`[executor] [${ts()}] Remotion chain: uploading ${pngFiles.length} PNGs to CDN...`)
            try {
              // Read files and base64 encode
              const artifacts = pngFiles.map(f => ({
                filename: f.name,
                content_base64: fs.readFileSync(f.path).toString('base64'),
                content_type: 'image/png'
              }))

              // Upload to CDN via iris-api
              const uploadResult = await this.cloud.post(`/api/v6/node-agent/tasks/${taskId}/artifacts`, { files: artifacts })
              const cdnUrls = (uploadResult?.cdn_urls || []).map(u => u.url || u)
              console.log(`[executor] [${ts()}] Remotion chain: ${cdnUrls.length} files uploaded to CDN`)

              // Post cover slide (first image) to Buffer via fl-api
              if (cdnUrls.length > 0) {
                const caption = task.config?.caption || task.title || 'New from FreeLabel'
                const flApiUrl = process.env.FL_API_URL || process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io'
                const flApiToken = process.env.FL_API_TOKEN || ''

                // Try loading token from SDK env if not in process env
                if (!flApiToken) {
                  try {
                    const sdkEnv = path.join(os.homedir(), '.iris', 'sdk', '.env')
                    if (fs.existsSync(sdkEnv)) {
                      const envContent = fs.readFileSync(sdkEnv, 'utf-8')
                      const match = envContent.match(/^FL_API_TOKEN=(.+)$/m)
                      if (match) process.env.FL_API_TOKEN = match[1].trim()
                    }
                  } catch { /* fine */ }
                }
                const resolvedToken = process.env.FL_API_TOKEN || ''

                if (resolvedToken) {
                  try {
                    const bufferPayload = JSON.stringify({
                      image_url: cdnUrls[0],
                      caption,
                      draft: true
                    })
                    const url = new URL('/api/v1/buffer/post-image', flApiUrl)
                    const res = await fetch(url.toString(), {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${resolvedToken}`
                      },
                      body: bufferPayload
                    })
                    const bufferResult = await res.json().catch(() => ({}))
                    console.log(`[executor] [${ts()}] Remotion chain: Buffer post ${res.ok ? 'success' : 'failed'}`, bufferResult?.success ? '' : bufferResult?.errors?.[0]?.error || '')
                  } catch (bufErr) {
                    console.log(`[executor] [${ts()}] Remotion chain: Buffer post failed: ${bufErr.message}`)
                  }
                } else {
                  console.log(`[executor] [${ts()}] Remotion chain: Skipping Buffer post (no FL_API_TOKEN in env or ~/.iris/sdk/.env)`)
                }
              }
            } catch (uploadErr) {
              console.log(`[executor] [${ts()}] Remotion chain: CDN upload failed: ${uploadErr.message}`)
            }
          }
        }
      }

      // Discord notification
      this.notifyDiscord(task, 'completed', Date.now() - startTime, outputLines).catch(() => {})
    } catch (err) {
      clearInterval(progressInterval)

      await this.cloud.submitResult(taskId, {
        status: 'failed',
        error: err.message,
        output: outputLines.join('\n'),
        duration_ms: Date.now() - startTime
      })

      console.error(`[executor] [${ts()}] Task ${taskId} failed: ${err.message}`)

      // Discord notification
      this.notifyDiscord(task, 'failed', Date.now() - startTime, outputLines, err.message).catch(() => {})
    } finally {
      // Clean up credential temp file immediately — never persist sessions on disk
      if (credentialFilePath && fs.existsSync(credentialFilePath)) {
        fs.unlinkSync(credentialFilePath)
        console.log(`[executor] Credential file cleaned up: ${credentialFilePath}`)
      }
      _cleanupRunning() // Remove from dedup tracking
      this.runningTasks.delete(taskId)
      // Clean up workspace after a delay (keep for debugging)
      setTimeout(() => this.workspaces.cleanup(taskId), 60000)
    }
  }

  runProcess (task, workspace, outputLines) {
    return new Promise(async (resolve, reject) => {
      let cmd, args

      switch (task.type) {
        case 'code_generation':
          // Use iris-code for code generation tasks
          cmd = this.findIrisCode()
          args = ['--non-interactive', '--prompt', task.prompt]
          break

        case 'sandbox_execute': {
          // Execute a shell script
          cmd = '/bin/bash'
          const scriptPath = path.join(workspace.dir, 'task-script.sh')
          fs.writeFileSync(scriptPath, task.prompt, 'utf-8')
          fs.chmodSync(scriptPath, '755')
          args = [scriptPath]
          break
        }

        case 'test_run':
          cmd = '/bin/bash'
          args = ['-c', task.prompt]
          break

        case 'custom_playwright': {
          // Execute a user-provided Playwright script in an isolated workspace.
          // script_content comes via task.config.script_content (from template or hiveRunScript tool).
          // Credentials injected automatically via BROWSER_SESSION_FILE env var (existing pipeline).
          // Input params passed via task.config.env_vars.
          const scriptContent = (task.config && task.config.script_content) || task.prompt
          if (!scriptContent || scriptContent.length < 10) {
            reject(new Error('custom_playwright task requires script_content in config'))
            return
          }

          const scriptPath = path.join(workspace.dir, 'custom-test.spec.ts')
          fs.writeFileSync(scriptPath, scriptContent, 'utf-8')

          // Write minimal playwright config so script runs standalone in workspace
          const timeoutMs = ((task.timeout_seconds || task.config?.timeout_seconds || 600) * 1000)
          const pwConfig = [
            "import { defineConfig } from '@playwright/test';",
            'export default defineConfig({',
            `  timeout: ${timeoutMs},`,
            '  use: { headless: false },',
            '});'
          ].join('\n')
          fs.writeFileSync(path.join(workspace.dir, 'playwright.config.ts'), pwConfig, 'utf-8')

          cmd = 'npx'
          args = ['playwright', 'test', scriptPath, '--headed', `--timeout=${timeoutMs}`]
          workspace.projectDir = workspace.dir
          break
        }

        case 'artisan': {
          // Run a Laravel artisan command against the local fl-api.
          // task.prompt = the artisan command, e.g. "som:creators" or "queue:work --once"
          // task.config.artisan_args = optional extra args array
          const artisanCommand = task.prompt.trim()
          const extraArgs = (task.config && task.config.artisan_args) || []

          if (!this.flApiPath) {
            reject(new Error('fl-api not found. Set FL_API_PATH env var to the Laravel root.'))
            return
          }

          // Lazy-detect Docker mode
          if (this.dockerMode === null) {
            this.dockerMode = isDockerMode()
            console.log(`[executor] Docker mode: ${this.dockerMode}`)
          }

          if (this.dockerMode) {
            // Run via docker compose exec (non-interactive)
            const dockerRoot = path.resolve(this.flApiPath, '..')
            cmd = 'docker'
            args = [
              'compose', '-f', path.join(dockerRoot, 'docker-compose.yml'),
              'exec', '-T', 'api',
              'php', 'artisan', ...artisanCommand.split(' '), ...extraArgs
            ]
            // Override cwd to docker-compose root
            workspace.projectDir = dockerRoot
          } else {
            // Run php artisan directly
            cmd = 'php'
            args = ['artisan', ...artisanCommand.split(' '), ...extraArgs]
            // Run from fl-api root so artisan can find .env
            workspace.projectDir = this.flApiPath
          }
          break
        }

        case 'som': {
          // prompt format: "{campaign} [key=value ...]"
          // e.g. "creators mode=scrape target=https://instagram.com/p/xxx limit=20"
          // Split on whitespace that precedes a key= pattern (preserves values with spaces)
          const somParts = parseKeyValuePrompt(task.prompt.trim())
          const campaign = somParts[0] // creators | courses | beatbox | mayo
          const somExtraArgs = somParts.slice(1) // mode=scrape target=... limit=...

          const freelabelRoot = this.freelabelPath || findFreelabelPath()
          if (!freelabelRoot) {
            reject(new Error('Freelabel project root not found. Set FREELABEL_PATH env var.'))
            return
          }

          // ── Campaign config registry (single source of truth) ──
          // Prevents mismatched board/strategy/account from bad dispatches
          // Campaign configs from shared source of truth
          let somCampaignConfigs
          try {
            const somConfig = require(path.join(freelabelRoot, 'tests/e2e/som-config.js'))
            somCampaignConfigs = somConfig.getDaemonConfigs()
          } catch {
            // Fallback if shared config not found
            somCampaignConfigs = {}
          }

          const campaignConfig = somCampaignConfigs[campaign]
          if (!campaignConfig) {
            console.log(`[executor] ⚠️  Unknown SOM campaign: "${campaign}". Valid: ${Object.keys(somCampaignConfigs).join(', ')}`)
          }

          // ── Preflight: check for eligible leads before launching Chromium ──
          if (campaignConfig?.boardId) {
            const preflight = await somPreflightCheck(campaignConfig.boardId, campaignConfig.strategy)
            console.log(`[executor] Preflight board ${campaignConfig.boardId}: ${preflight.eligible} eligible / ${preflight.total} total — ${preflight.reason}`)
            if (preflight.skip) {
              console.log(`[executor] ⏭️  Skipping ${campaign} — ${preflight.reason}`)
              // Send Discord notification about exhausted leads
              try {
                const webhookUrl = process.env.DISCORD_LMKBOT_WEBHOOK
                if (webhookUrl) {
                  await fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      embeds: [{
                        title: '🚨 SOM — Leads Exhausted (Skipped)',
                        description: `📋 Board: ${campaignConfig.boardId} | Strategy: ${campaignConfig.strategy} | Account: @${campaignConfig.igAccount}\n✅ ${preflight.reason}\n⚡ Run \`npm run leadgen:${campaign}\` to discover more leads.\n💡 *Chromium was NOT launched — preflight saved compute.*`,
                        color: 0xFFA500,
                      }],
                    }),
                  })
                }
              } catch { /* non-blocking */ }
              resolve({ skipped: true, reason: preflight.reason })
              return
            }
          }

          // Use npx playwright directly with --headed to prevent Chrome crashes
          // (channel: 'chrome' in playwright.config uses system Chrome which needs a visible window)
          cmd = 'npx'
          const somSpec = somParts.some(p => p.startsWith('mode='))
            ? undefined // non-default mode — som.js picks the right spec
            : 'tests/e2e/batch-with-login.spec.ts'

          if (somSpec) {
            // Direct playwright invocation for outreach mode (most common)
            args = ['playwright', 'test', somSpec, '--headed', '--timeout=600000']
            // Campaign registry takes priority over task.config to prevent mismatches
            const somEnv = {
              BOARD_ID: campaignConfig?.boardId || task.config?.boardId || '38',
              STRATEGY: campaignConfig?.strategy || task.config?.strategy || 'AI Course | V3',
              IG_ACCOUNT: campaignConfig?.igAccount || task.config?.igAccount || 'heyiris.io',
              LIMIT: String(somExtraArgs.find(a => a.startsWith('limit='))?.split('=')[1] || '15'),
              SOM_SOURCE: task.config?.chained_from ? 'chain' : (task.config?.scheduled ? 'schedule' : 'dispatch'),
              SOM_TASK_ID: task.id || '',
            }
            // Warn if task.config disagrees with registry
            if (campaignConfig && task.config?.boardId && task.config.boardId !== campaignConfig.boardId) {
              console.log(`[executor] ⚠️  SOM config mismatch: task.config.boardId=${task.config.boardId} but ${campaign} should be ${campaignConfig.boardId}. Using registry.`)
            }
            if (campaignConfig && task.config?.strategy && task.config.strategy !== campaignConfig.strategy) {
              console.log(`[executor] ⚠️  SOM config mismatch: task.config.strategy="${task.config.strategy}" but ${campaign} should be "${campaignConfig.strategy}". Using registry.`)
            }
            // Merge extra key=value args as env vars
            for (const arg of somExtraArgs) {
              const [k, ...v] = arg.split('=')
              if (k && v.length) somEnv[k.toUpperCase()] = v.join('=')
            }
            task.config = task.config || {}
            task.config.env_vars = { ...(task.config.env_vars || {}), ...somEnv }
          } else {
            // Non-outreach mode (scrape, engage, email) — let som.js handle it
            cmd = 'npm'
            args = ['run', `som:${campaign}`, '--', ...somExtraArgs]
          }
          workspace.projectDir = freelabelRoot
          break
        }

        case 'leadgen': {
          // prompt format: "{campaign} [key=value ...]"
          // e.g. "creators limit=30 enrich=1 mode=followers min_followers=1000"
          const leadgenParts = task.prompt.trim().split(/\s+/)
          const leadgenCampaign = leadgenParts[0] // creators | courses | beatbox | mayo | sophe
          const leadgenExtraArgs = leadgenParts.slice(1)

          const leadgenRoot = this.freelabelPath || findFreelabelPath()
          if (!leadgenRoot) {
            reject(new Error('Freelabel project root not found. Set FREELABEL_PATH env var.'))
            return
          }

          cmd = 'npm'
          args = ['run', `leadgen:${leadgenCampaign}`, '--', ...leadgenExtraArgs]
          workspace.projectDir = leadgenRoot
          break
        }

        case 'linkedin': {
          // prompt format: "{campaign} [key=value ...]"
          // e.g. "search query=AI+engineer limit=30 enrich=1"
          // e.g. "inbox limit=50 enrich=1"
          const linkedinParts = task.prompt.trim().split(/\s+/)
          const linkedinCampaign = linkedinParts[0]
          const linkedinExtraArgs = linkedinParts.slice(1)

          const linkedinRoot = this.freelabelPath || findFreelabelPath()
          if (!linkedinRoot) {
            reject(new Error('Freelabel project root not found. Set FREELABEL_PATH env var.'))
            return
          }

          cmd = 'npm'
          args = ['run', `linkedin:${linkedinCampaign}`, '--', ...linkedinExtraArgs]
          workspace.projectDir = linkedinRoot
          break
        }

        case 'email': {
          // prompt format: "{campaign} [key=value ...]"
          // e.g. "lawfirms limit=10 enrich=1"
          // e.g. "batch board=38 strategy=ai-course limit=20"
          const emailParts = task.prompt.trim().split(/\s+/)
          const emailCampaign = emailParts[0]
          const emailExtraArgs = emailParts.slice(1)

          const emailRoot = this.freelabelPath || findFreelabelPath()
          if (!emailRoot) {
            reject(new Error('Freelabel project root not found. Set FREELABEL_PATH env var.'))
            return
          }

          cmd = 'npm'
          args = ['run', `email:${emailCampaign}`, '--', ...emailExtraArgs]
          workspace.projectDir = emailRoot
          break
        }

        case 'email_send': {
          // Single transactional email via this node's Apple Mail
          // config: { to_email, to_name, subject, body_text, cc_email, attachments }
          const emailConfig = task.config || {}
          if (!emailConfig.to_email || !emailConfig.subject) {
            reject(new Error('email_send requires: to_email, subject'))
            return
          }

          try {
            const bridgePort = process.env.BRIDGE_PORT || 3200
            const mailResp = await fetch(`http://localhost:${bridgePort}/api/mail/send`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to_email: emailConfig.to_email,
                to_name: emailConfig.to_name || '',
                subject: emailConfig.subject,
                body_text: emailConfig.body_text || '',
                cc_email: emailConfig.cc_email || null,
                attachments: emailConfig.attachments || []
              })
            })
            const mailResult = await mailResp.json()
            resolve({
              output: `Email sent to ${emailConfig.to_email} via Apple Mail`,
              result: mailResult
            })
          } catch (mailErr) {
            reject(new Error(`email_send failed: ${mailErr.message}`))
          }
          return
        }

        case 'twitter': {
          // prompt format: "{campaign} [key=value ...]"
          // e.g. "search query=AI+engineer limit=30 enrich=1"
          // e.g. "replies target=https://x.com/user/status/123 limit=30"
          const twitterParts = task.prompt.trim().split(/\s+/)
          const twitterCampaign = twitterParts[0]
          const twitterExtraArgs = twitterParts.slice(1)

          const twitterRoot = this.freelabelPath || findFreelabelPath()
          if (!twitterRoot) {
            reject(new Error('Freelabel project root not found. Set FREELABEL_PATH env var.'))
            return
          }

          cmd = 'npm'
          args = ['run', `twitter:${twitterCampaign}`, '--', ...twitterExtraArgs]
          workspace.projectDir = twitterRoot
          break
        }

        case 'threads': {
          // prompt format: "{campaign} [key=value ...]"
          // e.g. "replies target=https://www.threads.com/@user/post/CODE limit=30 board=38"
          const threadsParts = task.prompt.trim().split(/\s+/)
          const threadsCampaign = threadsParts[0]
          const threadsExtraArgs = threadsParts.slice(1)

          const threadsRoot = this.freelabelPath || findFreelabelPath()
          if (!threadsRoot) {
            reject(new Error('Freelabel project root not found. Set FREELABEL_PATH env var.'))
            return
          }

          cmd = 'npm'
          args = ['run', `threads:${threadsCampaign}`, '--', ...threadsExtraArgs]
          workspace.projectDir = threadsRoot
          break
        }

        case 'remotion': {
          // prompt format: "{composition} [key=value ...]"
          // e.g. "SocialPostStill brand=freelabel headline=AI+Agents+Are+Here"
          // e.g. "SocialPost brand=discover headline=Top+10+AI+Tools"
          // e.g. "BrandIntro brand=beatbox"
          const remotionParts = task.prompt.trim().split(/\s+/)
          const composition = remotionParts[0]
          const remotionExtraArgs = remotionParts.slice(1)

          const remotionRoot = findRemotionPath()
          if (!remotionRoot) {
            reject(new Error('Remotion not installed. Run: curl -fsSL https://heyiris.io/install-code | bash'))
            return
          }

          // Lazy-install dependencies on first use
          try {
            await ensureRemotionInstalled(remotionRoot)
          } catch (e) {
            reject(new Error(`Remotion dependency install failed: ${e.message}`))
            return
          }

          // Build props: prefer config.props (full JSON) over key=value args
          let props = {}
          if (task.config && task.config.props && typeof task.config.props === 'object') {
            props = task.config.props
          } else {
            for (const arg of remotionExtraArgs) {
              const [k, ...vParts] = arg.split('=')
              if (k && vParts.length) props[k] = vParts.join('=').replace(/\+/g, ' ')
            }
          }

          const isStill = composition.includes('Still') || composition.includes('Thumbnail') || composition.includes('Ad')
          const ext = isStill ? 'png' : 'mp4'
          const outputFile = path.join(workspace.projectDir, `output.${ext}`)

          cmd = 'npx'
          args = isStill
            ? ['remotion', 'still', composition, outputFile, '--props', JSON.stringify(props)]
            : ['remotion', 'render', composition, outputFile, '--props', JSON.stringify(props)]
          workspace.projectDir = remotionRoot
          break
        }

        case 'remotion_carousel': {
          // prompt = JSON string with full carousel props
          // e.g. '{"brand":"freelabel","headline":"5 Ways...","tips":[...],...}'
          // Renders CarouselSlide0..CarouselSlide8 as PNGs
          const remotionRoot = findRemotionPath()
          if (!remotionRoot) {
            reject(new Error('Remotion not installed. Run: curl -fsSL https://heyiris.io/install-code | bash'))
            return
          }

          try {
            await ensureRemotionInstalled(remotionRoot)
          } catch (e) {
            reject(new Error(`Remotion dependency install failed: ${e.message}`))
            return
          }

          // Parse carousel props from prompt (JSON)
          let carouselProps
          try {
            carouselProps = JSON.parse(task.prompt)
          } catch (e) {
            reject(new Error(`Invalid carousel JSON: ${e.message}`))
            return
          }

          // Write a bash script that renders all 9 slides
          const outputDir = path.join(workspace.dir, 'slides')
          fs.mkdirSync(outputDir, { recursive: true })

          const slideCommands = []
          for (let i = 0; i < 9; i++) {
            const slideProps = JSON.stringify({ ...carouselProps, slideIndex: i })
            const outFile = path.join(outputDir, `slide-${i}.png`)
            slideCommands.push(
              `echo "[carousel] Rendering slide ${i}/8..."`,
              `npx remotion still CarouselSlide${i} "${outFile}" --props '${slideProps.replace(/'/g, "'\\''")}'`
            )
          }
          slideCommands.push(`echo "[carousel] All 9 slides rendered to ${outputDir}"`)
          slideCommands.push(`ls -la "${outputDir}"`)

          const scriptContent = `#!/bin/bash\nset -e\ncd "${remotionRoot}"\n${slideCommands.join('\n')}\n`
          const scriptPath = path.join(workspace.dir, 'render-carousel.sh')
          fs.writeFileSync(scriptPath, scriptContent, 'utf-8')
          fs.chmodSync(scriptPath, '755')

          cmd = '/bin/bash'
          args = [scriptPath]
          workspace.projectDir = remotionRoot
          break
        }

        case 'instagram': {
          // prompt format: "{campaign} [key=value ...]"
          // e.g. "inbox account=heyiris.io board=38 wb=1"
          // e.g. "inbox account=heyiris.io board=38 segment=42 limit=30"
          const instaParts = task.prompt.trim().split(/\s+/)
          const instaCampaign = instaParts[0]
          const instaExtraArgs = instaParts.slice(1)

          const instaRoot = this.freelabelPath || findFreelabelPath()
          if (!instaRoot) {
            reject(new Error('Freelabel project root not found. Set FREELABEL_PATH env var.'))
            return
          }

          cmd = 'npm'
          args = ['run', `instagram:${instaCampaign}`, '--', ...instaExtraArgs]
          workspace.projectDir = instaRoot
          break
        }

        case 'enrich_batch': {
          // Enrich leads on a board before outreach
          // prompt format: "{board_id} [goal=email] [limit=50]"
          // e.g. "292 goal=email limit=50"
          const enrichParts = task.prompt ? task.prompt.trim().split(/\s+/).filter(Boolean) : []
          const enrichBoardId = enrichParts[0] || task.config?.boardId || '292'
          const enrichExtraArgs = enrichParts.slice(1)

          // Build artisan command args
          const enrichArtisanArgs = [`leads:enrich-board`, enrichBoardId]
          for (const arg of enrichExtraArgs) {
            const [k, v] = arg.split('=')
            if (k && v) enrichArtisanArgs.push(`--${k}=${v}`)
          }
          if (!enrichExtraArgs.some(a => a.startsWith('limit='))) enrichArtisanArgs.push('--limit=50')
          if (!enrichExtraArgs.some(a => a.startsWith('goal='))) enrichArtisanArgs.push('--goal=email')

          // Run via Docker if available, otherwise direct
          const flApiPath = this.flApiPath || process.env.FL_API_PATH
          if (flApiPath) {
            cmd = 'php'
            args = ['artisan', ...enrichArtisanArgs]
            workspace.projectDir = flApiPath
          } else {
            // Fallback: run enrichment via npm script that calls the API
            const enrichRoot = this.freelabelPath || findFreelabelPath()
            if (!enrichRoot) {
              reject(new Error('Freelabel project root not found. Set FREELABEL_PATH env var.'))
              return
            }
            cmd = 'npm'
            args = ['run', 'som:all', '--', `only=custom`, `enrich=1`, `enrich_goal=email`, `limit=0`]
            workspace.projectDir = enrichRoot
          }
          break
        }

        case 'venue_outreach': {
          // Venue discovery + enrichment + email outreach pipeline
          // prompt format: "{city} [key=value ...]"
          // e.g. "las-vegas limit=20 discover=1 enrich=1 email=1 dry=1"
          // e.g. "las-vegas,seattle,atlanta discover=1 limit=15"
          const venueParts = task.prompt ? task.prompt.trim().split(/\s+/).filter(Boolean) : []
          const venueCity = venueParts[0] || 'las-vegas'
          const venueExtraArgs = venueParts.slice(1)

          const venueRoot = this.freelabelPath || findFreelabelPath()
          if (!venueRoot) {
            reject(new Error('Freelabel project root not found. Set FREELABEL_PATH env var.'))
            return
          }

          cmd = 'npm'
          args = ['run', 'venue:outreach', '--', venueCity, ...venueExtraArgs]
          workspace.projectDir = venueRoot
          break
        }

        case 'enrich_scrape': {
          // Browser-based venue enrichment — Googles businesses, scrapes websites for emails
          // prompt format: "{board_id} [limit=20] [dry=1]"
          // e.g. "292 limit=20" or "292 limit=10 dry=1"
          const scrapeParts = task.prompt ? task.prompt.trim().split(/\s+/).filter(Boolean) : []
          const scrapeBoardId = scrapeParts[0] || task.config?.boardId || '292'
          const scrapeLimit = scrapeParts.find(p => p.startsWith('limit='))?.split('=')[1] || '20'
          const scrapeDry = scrapeParts.some(p => p === 'dry=1') ? '1' : '0'

          const scrapeRoot = this.freelabelPath || findFreelabelPath()
          if (!scrapeRoot) {
            reject(new Error('Freelabel project root not found. Set FREELABEL_PATH env var.'))
            return
          }

          cmd = 'npx'
          args = ['playwright', 'test', 'tests/e2e/enrich-venues.spec.ts', '--headed', '--timeout=1800000']
          task.config = task.config || {}
          task.config.env_vars = {
            ...(task.config.env_vars || {}),
            BOARD_ID: scrapeBoardId,
            LIMIT: scrapeLimit,
            DRY_RUN: scrapeDry,
          }
          workspace.projectDir = scrapeRoot
          break
        }

        case 'som_batch': {
          // Run all outreach campaigns via som-all.js (parallel by default)
          // prompt format: "[key=value ...]"
          // e.g. "limit=15" or "all=1 limit=10 dry=1" or "only=courses,creators limit=15 warmup=1"
          // Enrichment is built into som-all.js — auto-runs for email mode
          const batchArgs = task.prompt ? task.prompt.trim().split(/\s+/).filter(Boolean) : []
          const batchRoot = this.freelabelPath || findFreelabelPath()
          if (!batchRoot) {
            reject(new Error('Freelabel project root not found. Set FREELABEL_PATH env var.'))
            return
          }

          // ── Preflight: check ALL active campaigns for eligible leads ──
          try {
            const somConfig = require(path.join(batchRoot, 'tests/e2e/som-config.js'))
            const allConfigs = somConfig.getDaemonConfigs()
            const activeAccounts = somConfig.getActiveAccounts()
            let anyEligible = false
            const skippedCampaigns = []

            for (const [id, cfg] of Object.entries(activeAccounts)) {
              if (cfg.boardId) {
                const pf = await somPreflightCheck(cfg.boardId, cfg.strategy)
                console.log(`[executor] Preflight ${id} (board ${cfg.boardId}): ${pf.eligible} eligible — ${pf.reason}`)
                if (!pf.skip) anyEligible = true
                else skippedCampaigns.push(`${id} (${pf.reason})`)
              }
            }

            if (!anyEligible && Object.keys(activeAccounts).length > 0) {
              console.log(`[executor] ⏭️  ALL campaigns exhausted — skipping som_batch entirely`)
              try {
                const webhookUrl = process.env.DISCORD_LMKBOT_WEBHOOK
                if (webhookUrl) {
                  await fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      embeds: [{
                        title: '⏭️ SOM Batch — All Campaigns Exhausted (Skipped)',
                        description: skippedCampaigns.map(c => `• ${c}`).join('\n') + '\n\n💡 *Chromium was NOT launched — preflight saved compute.*',
                        color: 0xFFA500,
                      }],
                    }),
                  })
                }
              } catch { /* non-blocking */ }
              resolve({ skipped: true, reason: 'all_campaigns_exhausted', campaigns: skippedCampaigns })
              return
            }
          } catch (err) {
            console.log(`[executor] ⚠️  Batch preflight failed: ${err.message} — running anyway`)
          }

          cmd = 'npm'
          args = ['run', 'som:all', '--', ...batchArgs]
          workspace.projectDir = batchRoot
          break
        }

        case 'inbox_scan': {
          // Scan IG inbox for replies across all active SOM accounts
          // prompt format: "all [since=4h] [wb=1] [dry=1]" or "{account} [since=24h] [wb=1]"
          const scanParts = parseKeyValuePrompt(task.prompt.trim())
          const scanTarget = scanParts[0] || 'all'
          const scanArgs = scanParts.slice(1)

          const scanRoot = this.freelabelPath || findFreelabelPath()
          if (!scanRoot) {
            reject(new Error('Freelabel project root not found. Set FREELABEL_PATH env var.'))
            return
          }

          // Use shared config — same source of truth as som.js, som-all.js
          let scanAccounts
          try {
            const somConfig = require(path.join(scanRoot, 'tests/e2e/som-config.js'))
            const activeAccountsObj = somConfig.getActiveAccounts()
            const activeAccounts = Object.values(activeAccountsObj)
            scanAccounts = scanTarget === 'all'
              ? activeAccounts
              : activeAccounts.filter(a => a.igAccount === scanTarget || a.id === scanTarget)
          } catch {
            // Fallback: scan heyiris.io only
            scanAccounts = [{ id: 'courses', igAccount: 'heyiris.io', boardId: '38' }]
          }

          if (scanAccounts.length === 0) {
            reject(new Error(`No matching accounts for inbox scan target: "${scanTarget}"`))
            return
          }

          const since = scanArgs.find(a => a.startsWith('since='))?.split('=')[1] || '4h'
          const wb = scanArgs.some(a => a === 'wb=1' || a === 'wb=true') ? '1' : '0'
          const dry = scanArgs.some(a => a === 'dry=1' || a === 'dry=true') ? '1' : '0'

          console.log(`[executor] Inbox scan: ${scanAccounts.length} accounts (since=${since}, wb=${wb})`)
          for (const a of scanAccounts) {
            console.log(`[executor]   → @${a.igAccount} (board ${a.boardId})`)
          }

          // Run sequentially — one browser per account
          const runnerScript = scanAccounts.map(a =>
            `BOARD_ID=${a.boardId} IG_ACCOUNT=${a.igAccount} SINCE=${since} WRITE_BACK=${wb} DRY_RUN=${dry} LIMIT=30 npx playwright test tests/e2e/inbox-followup.spec.ts --headed --timeout=120000`
          ).join(' && ')
          cmd = 'bash'
          args = ['-c', runnerScript]
          workspace.projectDir = scanRoot
          break
        }

        case 'discover': {
          // prompt format: "{subcommand} [key=value ...]"
          // e.g. "import-yt-feed limit=50 dry=0"
          const discoverParts = task.prompt.trim().split(/\s+/)
          const discoverSubcommand = discoverParts[0] // import-yt-feed
          const discoverExtraArgs = discoverParts.slice(1)

          const discoverRoot = this.freelabelPath || findFreelabelPath()
          if (!discoverRoot) {
            reject(new Error('Freelabel project root not found. Set FREELABEL_PATH env var.'))
            return
          }

          // Auto-inject local browser session for YouTube tasks
          if (discoverSubcommand.includes('yt') || discoverSubcommand.includes('youtube')) {
            const localSession = path.join(os.homedir(), '.iris', 'sessions', 'youtube.json')
            if (!task.config?.env_vars?.BROWSER_SESSION_FILE && fs.existsSync(localSession)) {
              task.config = task.config || {}
              task.config.env_vars = task.config.env_vars || {}
              task.config.env_vars.BROWSER_SESSION_FILE = localSession
              console.log(`[executor] Using local YouTube session: ${localSession}`)
            }
          }

          cmd = 'npm'
          args = ['run', `discover:${discoverSubcommand}`, '--', ...discoverExtraArgs]
          workspace.projectDir = discoverRoot
          break
        }

        case 'discover-publish': {
          // prompt format: "brand=beatbox url=https://... start=0:10 duration=90 platforms=instagram"
          // Parse key=value pairs from prompt
          const dpParams = {}
          const dpParts = task.prompt.trim().split(/\s+/)
          for (const part of dpParts) {
            const eqIdx = part.indexOf('=')
            if (eqIdx > 0) {
              dpParams[part.substring(0, eqIdx)] = part.substring(eqIdx + 1)
            }
          }

          const dpUrl = dpParams.url
          if (!dpUrl) {
            reject(new Error('discover-publish task requires url= in prompt'))
            return
          }

          const dpBrand = dpParams.brand || 'beatbox'
          const dpStart = dpParams.start || '0:10'
          const dpDuration = dpParams.duration || '90'
          const dpPlatforms = (dpParams.platforms || 'instagram,tiktok').split(',')

          // Call iris-api execute-direct endpoint directly via curl
          // This bypasses the SDK CLI and its .env config issues
          const irisApiUrl = process.env.IRIS_LOCAL_URL || 'https://local.iris.freelabel.net'
          const userId = task.user_id || 193

          let integration, action, params
          if (dpBrand === 'beatbox') {
            integration = 'beatbox-showcase'
            action = 'beatbox_publish'
            params = {
              youtube_url: dpUrl,
              start: dpStart,
              duration: dpDuration + 's',
              platforms: dpPlatforms
            }
          } else {
            integration = 'copycat-ai'
            action = 'trigger_video_clipper'
            params = {
              youtube_url: dpUrl,
              brand: dpBrand,
              start: dpStart,
              duration: dpDuration + 's',
              publish_to_social: true,
              social_platforms: dpPlatforms
            }
          }

          const payload = JSON.stringify({ integration, action, params })

          // Write a polling script that submits the job then polls iris-api for status
          // iris-api proxies to Raichu (fl-api) with proper auth — no token needed here
          const pollScript = `#!/bin/bash
# No set -e — grep returns 1 on no match which would kill the polling loop

echo "Submitting ${dpBrand} video clip job..."
echo "  URL: ${dpUrl}"
echo "  Start: ${dpStart} | Duration: ${dpDuration}s"
echo "  Platforms: ${dpPlatforms.join(', ')}"
echo ""

RESPONSE=$(curl -s -X POST "${irisApiUrl}/api/v1/users/${userId}/integrations/execute-direct" \\
  -H "Content-Type: application/json" \\
  -d '${payload.replace(/'/g, "'\\''")}' \\
  --insecure)

echo "API Response: $RESPONSE"

# Extract job_id from response
JOB_ID=$(echo "$RESPONSE" | grep -o '"job_id":[0-9]*' | head -1 | grep -o '[0-9]*')

if [ -z "$JOB_ID" ]; then
  echo "ERROR: No job_id in response — cannot poll status"
  exit 1
fi

echo ""
echo "Job #$JOB_ID queued — polling status every 5s..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

IRIS_URL="${irisApiUrl}"
MAX_POLLS=60   # 5 minutes per attempt
STALE_THRESHOLD=24  # 2 minutes of pending = stale (24 * 5s)
MAX_RETRIES=2  # Retry the whole job submission once

ATTEMPT=0

while [ $ATTEMPT -lt $MAX_RETRIES ]; do
  ATTEMPT=$((ATTEMPT + 1))

  # On retry, resubmit the job
  if [ $ATTEMPT -gt 1 ]; then
    echo ""
    echo "━━━ Retry $ATTEMPT/$MAX_RETRIES — resubmitting job..."
    RESPONSE=$(curl -s -X POST "$IRIS_URL/api/v1/users/${userId}/integrations/execute-direct" \\
      -H "Content-Type: application/json" \\
      -d '${payload.replace(/'/g, "'\\''")}' \\
      --insecure)
    JOB_ID=$(echo "$RESPONSE" | grep -o '"job_id":[0-9]*' | head -1 | grep -o '[0-9]*') || true
    if [ -z "$JOB_ID" ]; then
      echo "ERROR: Retry failed — no job_id in response"
      echo "$RESPONSE"
      exit 1
    fi
    echo "New job #$JOB_ID queued"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  fi

  POLL=0
  PENDING_COUNT=0
  LAST_STATUS=""
  LAST_MSG=""
  JOB_DONE=0

  while [ $POLL -lt $MAX_POLLS ]; do
    sleep 5
    POLL=$((POLL + 1))

    STATUS_RESPONSE=$(curl -s "$IRIS_URL/api/v1/labs/jobs/$JOB_ID/status" --insecure 2>/dev/null || echo '{"status":"unknown"}')
    STATUS=$(echo "$STATUS_RESPONSE" | grep -o '"status":"[^"]*"' | head -1 | sed 's/"status":"//;s/"//') || true
    PROGRESS=$(echo "$STATUS_RESPONSE" | grep -o '"progress":[0-9]*' | head -1 | grep -o '[0-9]*') || true
    STEP=$(echo "$STATUS_RESPONSE" | grep -o '"current_step":"[^"]*"' | head -1 | sed 's/"current_step":"//;s/"//') || true
    STARTED=$(echo "$STATUS_RESPONSE" | grep -o '"started_at":"[^"]*"' | head -1 | sed 's/"started_at":"//;s/"//') || true
    MSG=$(echo "$STATUS_RESPONSE" | grep -o '"message":"[^"]*"' | head -1 | sed 's/"message":"//;s/"//') || true
    LOG=$(echo "$STATUS_RESPONSE" | grep -o '"log":"[^"]*"' | head -1 | sed 's/"log":"//;s/"//') || true
    DETAIL="$MSG"
    [ -n "$LOG" ] && DETAIL="$LOG"

    ELAPSED=$((POLL * 5))
    TS=$(date '+%I:%M:%S %p')

    # Detect stale pending — job never started, worker probably OOM-killed
    if [ "$STATUS" = "pending" ] && [ -z "$STARTED" ]; then
      PENDING_COUNT=$((PENDING_COUNT + 1))
      if [ $PENDING_COUNT -ge $STALE_THRESHOLD ]; then
        echo "[$TS] Job #$JOB_ID stuck at pending for $((PENDING_COUNT * 5))s (never started) — worker likely dead"
        break  # Break inner loop to trigger retry
      fi
      if [ $((PENDING_COUNT % 6)) -eq 0 ]; then
        echo "[$TS] Still pending... (\${ELAPSED}s)"
      fi
      continue
    fi

    # Job has started or changed status — reset pending counter
    PENDING_COUNT=0

    # Collapse repeated same-status polls
    if [ "$STATUS" = "$LAST_STATUS" ] && [ "$STATUS" = "processing" ]; then
      if [ $((POLL % 6)) -eq 0 ]; then
        if [ -n "$PROGRESS" ]; then
          echo "[$TS] processing... \${PROGRESS}% (\${ELAPSED}s)"
        else
          echo "[$TS] processing... (\${ELAPSED}s)"
        fi
      fi
      continue
    fi

    # Status changed — always print
    if [ -n "$PROGRESS" ] && [ -n "$STEP" ]; then
      echo "[$TS] (\${ELAPSED}s) $STATUS | \${PROGRESS}% | $STEP"
    elif [ -n "$DETAIL" ] && [ "$DETAIL" != "$LAST_MSG" ]; then
      echo "[$TS] (\${ELAPSED}s) $STATUS — $DETAIL"
      LAST_MSG="$DETAIL"
    elif [ -n "$STATUS" ] && [ "$STATUS" != "unknown" ]; then
      echo "[$TS] (\${ELAPSED}s) $STATUS"
    else
      TRUNCATED=$(echo "$STATUS_RESPONSE" | head -c 200)
      echo "[$TS] (\${ELAPSED}s) No status parsed — raw: $TRUNCATED"
    fi

    LAST_STATUS="$STATUS"

    case "$STATUS" in
      completed|done|finished|success)
        echo ""
        echo "Job #$JOB_ID COMPLETED"
        echo "$STATUS_RESPONSE"
        exit 0
        ;;
      failed|error)
        echo ""
        echo "Job #$JOB_ID FAILED"
        echo "$STATUS_RESPONSE"
        # Break to retry instead of exit
        JOB_DONE=1
        break
        ;;
    esac
  done

  # If job completed (success handled above via exit 0)
  if [ $JOB_DONE -eq 1 ] && [ $ATTEMPT -ge $MAX_RETRIES ]; then
    echo "Job failed after $ATTEMPT attempts"
    exit 1
  fi

  # If we broke out due to stale or timeout, retry
  if [ $ATTEMPT -lt $MAX_RETRIES ]; then
    echo "Retrying in 5s..."
    sleep 5
  fi
done

echo "All $MAX_RETRIES attempts exhausted — giving up"
exit 1
`
          const scriptPath = path.join(workspace.dir, 'discover-publish-poll.sh')
          fs.writeFileSync(scriptPath, pollScript)
          fs.chmodSync(scriptPath, '755')

          cmd = '/bin/bash'
          args = [scriptPath]
          break
        }

        case 'scaffold_workspace': {
          // Clone a repo into /data/workspace/{name}, auto-detect deps, install
          const config = task.config || {}
          const wsName = config.workspace_name || `ws-${task.id.substring(0, 8)}`
          const repoUrl = config.repo_url
          const setupCmd = config.setup_command || ''
          const wsDir = path.join('/data/workspace', wsName)

          const lines = ['#!/bin/bash', 'set -e']

          if (repoUrl) {
            lines.push(`echo "Cloning ${repoUrl} → ${wsDir}"`)
            lines.push(`git clone --depth 1 "${repoUrl}" "${wsDir}"`)
          } else {
            lines.push(`mkdir -p "${wsDir}"`)
          }

          lines.push(`cd "${wsDir}"`)

          // Auto-detect and install dependencies
          lines.push('if [ -f package.json ]; then echo "Installing npm deps..."; npm install; fi')
          lines.push('if [ -f composer.json ]; then echo "Installing composer deps..."; composer install --no-interaction; fi')
          lines.push('if [ -f requirements.txt ]; then echo "Installing pip deps..."; pip3 install -r requirements.txt; fi')

          if (setupCmd) {
            lines.push(`echo "Running setup command..."`)
            lines.push(setupCmd)
          }

          lines.push('echo "Workspace scaffolded successfully"')

          const scaffoldScript = path.join(workspace.dir, 'scaffold.sh')
          fs.writeFileSync(scaffoldScript, lines.join('\n'), 'utf-8')
          fs.chmodSync(scaffoldScript, '755')

          cmd = '/bin/bash'
          args = [scaffoldScript]
          break
        }

        case 'run_persistent': {
          // Start a persistent PM2 process in an existing workspace
          const pConfig = task.config || {}
          const pWsName = pConfig.workspace_name
          const pCommand = pConfig.command || task.prompt
          const pName = sanitizeProcessName(pConfig.process_name || pWsName || `proc-${task.id.substring(0, 8)}`)
          const pWsDir = pWsName ? path.join('/data/workspace', pWsName) : workspace.dir

          if (pWsName && !fs.existsSync(pWsDir)) {
            reject(new Error(`Workspace "${pWsName}" not found at ${pWsDir}. Run scaffold_workspace first.`))
            return
          }

          // PM2 start → save → list (task completes immediately, process lives on)
          const pm2Script = [
            '#!/bin/bash',
            'set -e',
            `cd "${pWsDir}"`,
            `pm2 start "${pCommand}" --name "${pName}" --cwd "${pWsDir}"`,
            'pm2 save',
            'echo "PM2 process started:"',
            'pm2 jlist'
          ].join('\n')

          const pm2ScriptPath = path.join(workspace.dir, 'pm2-start.sh')
          fs.writeFileSync(pm2ScriptPath, pm2Script, 'utf-8')
          fs.chmodSync(pm2ScriptPath, '755')

          cmd = '/bin/bash'
          args = [pm2ScriptPath]
          break
        }

        case 'session_message': {
          // Route a message into an existing CLI session via the bridge
          const sessionConfig = task.config || {}
          const sessionId = sessionConfig.session_id
          const sessionProvider = sessionConfig.provider || 'claude_code'

          if (!sessionId) {
            reject(new Error('session_message task requires config.session_id'))
            return
          }

          const bridgePort = parseInt(process.env.A2A_PORT || process.env.BRIDGE_PORT || '3200', 10)
          const providerSlug = sessionProvider === 'claude_code' ? 'claude-code' : sessionProvider

          // Build a script that uses curl to send the message to the local bridge
          const msgBody = JSON.stringify({ message: task.prompt }).replace(/'/g, "'\\''")
          const curlCmd = `curl -s -X POST "http://localhost:${bridgePort}/api/sessions/${providerSlug}/${sessionId}/message" -H "Content-Type: application/json" -d '${msgBody}'`

          cmd = '/bin/bash'
          args = ['-c', curlCmd]
          break
        }

        case 'social_feed_sync': {
          // Sync Instagram feed data from residential IP → fl-api cache
          // prompt: "moore-life" or "moore-life,other-profile" or "--auto" or empty (defaults to --auto)
          const syncScript = path.join(path.resolve(__dirname, '..'), 'scripts', 'social-feed-sync.js')
          if (!fs.existsSync(syncScript)) {
            reject(new Error(`social-feed-sync.js not found at ${syncScript}`))
            return
          }
          cmd = 'node'
          const promptParts = (task.prompt || '').trim().split(/\s+/).filter(Boolean)
          args = [syncScript, ...(promptParts.length > 0 ? promptParts : ['--auto'])]
          break
        }

        case 'social_stats_sync': {
          // Multi-platform social stats sync (Instagram, Twitter, TikTok, YouTube, Spotify, SoundCloud)
          // prompt: "moore-life" or "moore-life,BigSean" or "--auto" or "--auto --platforms=instagram,twitter"
          const statsScript = path.join(path.resolve(__dirname, '..'), 'scripts', 'social-stats-sync.js')
          if (!fs.existsSync(statsScript)) {
            reject(new Error(`social-stats-sync.js not found at ${statsScript}`))
            return
          }
          cmd = 'node'
          const statsParts = (task.prompt || '').trim().split(/\s+/).filter(Boolean)
          args = [statsScript, ...(statsParts.length > 0 ? statsParts : ['--auto'])]
          break
        }

        case 'browser': {
          // LLM-driven browser automation via browser-agent
          const browserAgentPath = path.join(__dirname, '..', 'browser-agent', 'index.js')
          cmd = 'node'
          args = [
            browserAgentPath,
            '--task-file', path.join(workspace.dir, '.task.json'),
            '--output-dir', path.join(workspace.dir, '.output'),
          ]
          if (task.config?.headed) args.push('--headed')
          if (task.config?.start_url) { args.push('--url', task.config.start_url) }
          if (task.config?.max_steps) { args.push('--max-steps', String(task.config.max_steps)) }
          if (task.config?.model) { args.push('--model', task.config.model) }
          // Pass allowed domains via env
          task.config = task.config || {}
          task.config.env_vars = task.config.env_vars || {}
          if (task.config.allowed_domains) {
            task.config.env_vars.ALLOWED_DOMAINS = task.config.allowed_domains
          }
          workspace.projectDir = workspace.dir
          console.log(`[executor] Browser agent task — prompt: "${(task.prompt || '').slice(0, 80)}"`)
          break
        }

        case 'deploy_project': {
          const pConfig = task.config || {}
          const repoUrl = pConfig.repo_url
          const processName = sanitizeProcessName(pConfig.process_name || `proj-${task.id.substring(0, 8)}`)
          const projectType = pConfig.project_type || 'sdk_bot'
          const envVars = pConfig.env_vars || {}
          const isRedeploy = pConfig.redeploy === true
          const isClientSync = pConfig.client_sync === true
          const buildCommand = pConfig.build_command || null
          const port = pConfig.port || 3100
          const wsDir = path.join('/data/workspace', processName)

          const lines = ['#!/bin/bash', 'set -e']

          // Setup git credential helper for private repo access
          lines.push('# Configure git auth for private repos')
          lines.push('git config --global credential.helper store 2>/dev/null || true')

          // Clone or pull
          if (isRedeploy && fs.existsSync(path.join(wsDir, '.git'))) {
            lines.push(`cd "${wsDir}"`)
            lines.push('echo "==> Pulling latest changes..."')
            lines.push(`git fetch origin && git reset --hard origin/${pConfig.branch || 'main'}`)
          } else {
            lines.push(`echo "==> Cloning ${repoUrl} → ${wsDir}"`)
            lines.push(`rm -rf "${wsDir}"`)
            lines.push(`git clone "${repoUrl}" --branch ${pConfig.branch || 'main'} "${wsDir}"`)
            lines.push(`cd "${wsDir}"`)
          }

          // Client sync: push to client repo using deploy key
          if (isClientSync && pConfig.client_repo && pConfig.client_deploy_key) {
            const keyFile = path.join(workspace.dir, '.deploy-key')
            fs.writeFileSync(keyFile, pConfig.client_deploy_key, { mode: 0o600 })

            lines.push('echo "==> Syncing to client repo..."')
            lines.push(`export GIT_SSH_COMMAND="ssh -i ${keyFile} -o StrictHostKeyChecking=no"`)
            lines.push(`git remote remove client 2>/dev/null || true`)
            lines.push(`git remote add client "${pConfig.client_repo}"`)
            lines.push(`git push client ${pConfig.branch || 'main'} --force 2>&1`)
            lines.push('echo "==> Client sync complete"')
            // Clean up deploy key after push
            lines.push(`rm -f "${keyFile}"`)

            // Client sync tasks don't need PM2 — just the push
            const syncScript = path.join(workspace.dir, 'deploy.sh')
            fs.writeFileSync(syncScript, lines.join('\n'), 'utf-8')
            fs.chmodSync(syncScript, '755')
            cmd = '/bin/bash'
            args = [syncScript]
            workspace.projectDir = workspace.dir
            console.log(`[executor] Client sync: ${processName} → ${pConfig.client_repo}`)
            break
          }

          // Write .env
          const envLines = Object.entries(envVars).map(([k, v]) => `${k}=${v}`)
          if (envLines.length > 0) {
            lines.push('echo "==> Writing .env"')
            lines.push("cat > .env << 'ENVEOF'")
            envLines.forEach(l => lines.push(l))
            lines.push('ENVEOF')
          }

          // Install deps (auto-detect)
          lines.push('echo "==> Installing dependencies..."')
          lines.push('if [ -f package.json ]; then npm install --production 2>&1; fi')
          lines.push('if [ -f requirements.txt ]; then pip3 install -r requirements.txt 2>&1; fi')
          lines.push('if [ -f composer.json ]; then composer install --no-dev 2>&1; fi')

          // Build step
          if (buildCommand) {
            lines.push(`echo "==> Building..."`)
            lines.push(buildCommand)
          }

          // Stop existing PM2 process
          lines.push(`pm2 delete "${processName}" 2>/dev/null || true`)

          // Start with PM2
          if (projectType === 'genesis_site') {
            lines.push(`echo "==> Starting static site server on port ${port}..."`)
            lines.push(`pm2 serve ./public ${port} --name "${processName}" --spa 2>&1 || pm2 serve ./dist ${port} --name "${processName}" --spa 2>&1 || pm2 serve . ${port} --name "${processName}" --spa 2>&1`)
          } else {
            lines.push('echo "==> Starting process..."')
            lines.push(`pm2 start npm --name "${processName}" -- start 2>&1`)
          }
          lines.push('pm2 save')
          lines.push(`echo "==> Project ${processName} deployed successfully"`)
          lines.push('pm2 jlist')

          const deployScript = path.join(workspace.dir, 'deploy.sh')
          fs.writeFileSync(deployScript, lines.join('\n'), 'utf-8')
          fs.chmodSync(deployScript, '755')

          cmd = '/bin/bash'
          args = [deployScript]
          workspace.projectDir = workspace.dir
          console.log(`[executor] Deploy project: ${processName} (${isRedeploy ? 'redeploy' : 'fresh'})`)
          break
        }

        case 'stop_project': {
          const stopConfig = task.config || {}
          const stopNameRaw = stopConfig.process_name

          if (!stopNameRaw) {
            reject(new Error('stop_project requires config.process_name'))
            return
          }

          const stopName = sanitizeProcessName(stopNameRaw)
          cmd = '/bin/bash'
          args = ['-c', `pm2 delete "${stopName}" && pm2 save && echo "Process ${stopName} stopped"`]
          console.log(`[executor] Stop project: ${stopName}`)
          break
        }

        case 'peer_file_browse': {
          // Browse filesystem at requested path — reuses /files endpoint logic
          const browsePath = (task.config && task.config.path) || task.prompt || '/'
          const browseBaseDir = this.config ? this.config.dataDir : (process.env.WORKSPACE_DIR || process.cwd())
          const browseFullPath = path.resolve(browseBaseDir, browsePath.replace(/^\//, ''))

          if (!browseFullPath.startsWith(path.resolve(browseBaseDir))) {
            reject(new Error('Access denied — path traversal'))
            return
          }

          if (!fs.existsSync(browseFullPath)) {
            reject(new Error(`Path not found: ${browsePath}`))
            return
          }

          const browseStats = fs.statSync(browseFullPath)

          if (browseStats.isFile()) {
            const fileEntry = {
              name: path.basename(browseFullPath),
              path: '/' + path.relative(browseBaseDir, browseFullPath),
              type: 'file',
              size: browseStats.size,
              modified: browseStats.mtime.toISOString()
            }
            if (browseStats.size < 512 * 1024) {
              fileEntry.content = fs.readFileSync(browseFullPath, 'utf-8')
            }
            resolve({ output: JSON.stringify(fileEntry), result: fileEntry })
            return
          }

          const browseEntries = fs.readdirSync(browseFullPath, { withFileTypes: true })
            .filter(e => !e.name.startsWith('.') || e.name === '.output')
            .map(e => {
              const ep = path.join(browseFullPath, e.name)
              const es = fs.statSync(ep)
              return {
                name: e.name,
                path: '/' + path.relative(browseBaseDir, ep),
                type: e.isDirectory() ? 'directory' : 'file',
                size: es.size,
                modified: es.mtime.toISOString(),
                children: e.isDirectory() ? fs.readdirSync(ep).length : undefined
              }
            })
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
              return a.name.localeCompare(b.name)
            })

          const browseResult = {
            path: '/' + path.relative(browseBaseDir, browseFullPath),
            type: 'directory',
            entries: browseEntries,
            total_size: browseEntries.reduce((sum, e) => sum + (e.size || 0), 0)
          }
          resolve({ output: JSON.stringify(browseResult), result: browseResult })
          return
        }

        case 'peer_file_download': {
          // Download a file — returns base64 encoded content
          const dlPath = (task.config && task.config.path) || task.prompt || '/'
          const dlBaseDir = this.config ? this.config.dataDir : (process.env.WORKSPACE_DIR || process.cwd())
          const dlFullPath = path.resolve(dlBaseDir, dlPath.replace(/^\//, ''))

          if (!dlFullPath.startsWith(path.resolve(dlBaseDir))) {
            reject(new Error('Access denied — path traversal'))
            return
          }

          if (!fs.existsSync(dlFullPath) || !fs.statSync(dlFullPath).isFile()) {
            reject(new Error(`File not found: ${dlPath}`))
            return
          }

          const dlStats = fs.statSync(dlFullPath)
          if (dlStats.size > 50 * 1024 * 1024) {
            reject(new Error('File too large (>50MB) for relay transfer'))
            return
          }

          const dlContent = fs.readFileSync(dlFullPath)
          const dlResult = {
            name: path.basename(dlFullPath),
            path: '/' + path.relative(dlBaseDir, dlFullPath),
            size: dlStats.size,
            modified: dlStats.mtime.toISOString(),
            content_base64: dlContent.toString('base64')
          }
          resolve({ output: `File downloaded: ${dlPath} (${dlStats.size} bytes)`, result: dlResult })
          return
        }

        case 'peer_exec': {
          // Execute a shell command on this node on behalf of a Hive peer.
          // Dispatched via HiveNodeProxyController.relay() with action='exec'.
          // Returns { command, stdout, stderr, exit_code, duration_ms }.
          const execCommand = (task.config && task.config.command) || task.prompt
          if (!execCommand || typeof execCommand !== 'string') {
            reject(new Error('peer_exec requires config.command (string)'))
            return
          }
          const execTimeout = Math.min(Number(task.timeout_seconds || 30), 60) * 1000
          const execCwd = (task.config && task.config.cwd) ||
            (this.config ? this.config.dataDir : (process.env.WORKSPACE_DIR || process.cwd()))

          const execStarted = Date.now()
          let execStdout = ''
          let execStderr = ''
          let execExit = 0

          try {
            execStdout = execSync(execCommand, {
              cwd: execCwd,
              timeout: execTimeout,
              encoding: 'utf-8',
              maxBuffer: 5 * 1024 * 1024,
              shell: '/bin/bash',
              stdio: ['ignore', 'pipe', 'pipe']
            })
          } catch (err) {
            execExit = err.status || 1
            execStdout = (err.stdout && err.stdout.toString()) || ''
            execStderr = (err.stderr && err.stderr.toString()) || (err.message || '')
          }

          const execResult = {
            command: execCommand,
            stdout: execStdout,
            stderr: execStderr,
            exit_code: execExit,
            duration_ms: Date.now() - execStarted,
            cwd: execCwd
          }
          resolve({ output: execStdout || execStderr || '(no output)', result: execResult })
          return
        }

        case 'execute_file': {
          // Execute a script already on the node's filesystem
          const filePath = task.config?.file_path
          if (!filePath) {
            reject(new Error('execute_file requires config.file_path'))
            return
          }

          const dataDir = this.workspaces.dataDir
          const fullScriptPath = path.resolve(dataDir, filePath.replace(/^\//, ''))

          // Security: must be within dataDir
          if (!fullScriptPath.startsWith(path.resolve(dataDir))) {
            reject(new Error('file_path must be within data directory'))
            return
          }

          if (!fs.existsSync(fullScriptPath)) {
            reject(new Error(`Script not found: ${filePath}`))
            return
          }

          fs.chmodSync(fullScriptPath, '755')

          // Auto-detect interpreter by extension
          const ext = path.extname(fullScriptPath).toLowerCase()
          const interpreters = { '.py': 'python3', '.js': 'node', '.ts': 'npx ts-node' }
          cmd = interpreters[ext] || '/bin/bash'
          args = [fullScriptPath, ...(task.config?.args || [])]

          // Optional cwd override (also sandboxed)
          if (task.config?.cwd) {
            const cwdPath = path.resolve(dataDir, task.config.cwd.replace(/^\//, ''))
            if (cwdPath.startsWith(path.resolve(dataDir))) {
              workspace.projectDir = cwdPath
            }
          }
          break
        }

        default:
          // Default: treat prompt as a shell command
          cmd = '/bin/bash'
          args = ['-c', task.prompt]
      }

      console.log(`[executor] Running: ${cmd} ${args.slice(0, 2).join(' ')}...`)

      // Prepend Node 18+ and IRIS CLI to PATH for spawned processes
      const irisPath = path.join(os.homedir(), '.iris', 'bin')
      const basePath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin'
      const spawnPath = [_node18BinDir, irisPath, basePath].filter(Boolean).join(':')

      const child = spawn(cmd, args, {
        cwd: workspace.projectDir,
        env: {
          ...process.env,
          ...loadProjectEnv(),
          PATH: spawnPath,
          TASK_ID: task.id,
          TASK_TYPE: task.type,
          WORKSPACE_DIR: workspace.dir,
          PROJECT_DIR: workspace.projectDir,
          ...(task.config?.env_vars || {})
        },
        stdio: ['pipe', 'pipe', 'pipe']
      })

      child._startedAt = Date.now()
      child._taskTitle = task.title || task.type
      child._taskType = task.type
      this.runningTasks.set(task.id, child)

      // Stream stdout
      child.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean)
        outputLines.push(...lines)
        lines.forEach((line) => {
          if (line.trim()) {
            console.log(`[task:${task.id.substring(0, 8)}] ${line}`)
          }
        })
      })

      // Stream stderr
      child.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean)
        outputLines.push(...lines.map((l) => `[stderr] ${l}`))
        lines.forEach((line) => {
          if (line.trim()) {
            console.log(`[task:${task.id.substring(0, 8)}:err] ${line}`)
          }
        })
      })

      // Timeout — SOM/enrich tasks get 1 hour, others 10 minutes
      // Note: API defaults timeout_seconds to 600 in DB, so we override for long-running types
      const longRunningTypes = ['som_batch', 'enrich_batch', 'discover', 'som', 'inbox_scan']
      const isLongRunning = longRunningTypes.includes(task.type)
      const typeDefault = isLongRunning ? 3600 : 600
      // Only honor task.timeout_seconds if it was explicitly set above the DB default (600)
      const explicit = task.config?.timeout_seconds || (task.timeout_seconds > 600 ? task.timeout_seconds : null)
      const timeout = (explicit || typeDefault) * 1000
      const timeoutLabel = timeout / 1000
      const gracefulTypes = ['discover', 'enrich_batch', 'som_batch', 'som', 'inbox_scan']
      const isGraceful = gracefulTypes.includes(task.type)

      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL')
        }, 5000)
        // Browser tasks resolve even on timeout — partial work (scrape, DMs sent)
        // is still valuable. Report exit code 124 so status shows the timeout.
        if (isGraceful) {
          resolve({ exitCode: 124, timedOut: true })
        } else {
          reject(new Error(`Task timed out after ${timeoutLabel}s`))
        }
      }, timeout)

      child.on('close', (code) => {
        clearTimeout(timer)
        // Browser tasks resolve even on non-zero exit — Playwright often exits
        // non-zero for benign reasons (browser closed early, nav timeout, etc.)
        if (code === 0 || isGraceful) {
          resolve({ exitCode: code || 0 })
        } else {
          reject(new Error(`Process exited with code ${code}`))
        }
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  /**
   * Run a task using an external agent runtime (Claude Code, Gemini CLI, OpenCode, Local LLM).
   * Spawns the appropriate CLI process and streams output.
   */
  runRuntimeProcess (task, runtime, workspace, outputLines) {
    return new Promise((resolve, reject) => {
      let cmd, args

      switch (runtime) {
        case 'claude_code':
          cmd = 'claude'
          args = ['--print', task.prompt]
          break

        case 'opencode':
          cmd = 'opencode'
          args = ['--non-interactive', '--prompt', task.prompt]
          break

        case 'gemini_cli':
          cmd = 'gemini'
          args = ['--prompt', task.prompt]
          break

        case 'local_llm': {
          // HTTP request to local Ollama server — use curl to stream
          const model = task.model || task.config?.model || 'qwen3:8b'
          const payload = JSON.stringify({
            model,
            prompt: task.prompt,
            stream: false
          })
          cmd = 'curl'
          args = [
            '-s', '-X', 'POST',
            'http://localhost:11434/api/generate',
            '-H', 'Content-Type: application/json',
            '-d', payload
          ]
          break
        }

        case 'openclaw':
          // OpenClaw runs as a Docker container — execute via docker exec
          cmd = 'docker'
          args = ['exec', 'openclaw', 'openclaw', 'process', '--message', task.prompt]
          break

        default:
          reject(new Error(`Unknown runtime: ${runtime}`))
          return
      }

      console.log(`[executor] Runtime ${runtime}: ${cmd} ${args.slice(0, 2).join(' ')}...`)

      const irisPathRuntime = path.join(os.homedir(), '.iris', 'bin')
      const child = spawn(cmd, args, {
        cwd: workspace.projectDir,
        env: {
          ...process.env,
          ...loadProjectEnv(),
          PATH: `${irisPathRuntime}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
          TASK_ID: task.id,
          TASK_TYPE: task.type,
          RUNTIME: runtime,
          ...(task.config?.env_vars || {})
        },
        stdio: ['pipe', 'pipe', 'pipe']
      })

      child._startedAt = Date.now()
      child._taskTitle = task.title || task.type
      child._taskType = task.type
      this.runningTasks.set(task.id, child)

      child.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean)
        outputLines.push(...lines)
        lines.forEach((line) => {
          if (line.trim()) {
            console.log(`[task:${task.id.substring(0, 8)}:${runtime}] ${line}`)
          }
        })
      })

      child.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean)
        outputLines.push(...lines.map((l) => `[stderr] ${l}`))
        lines.forEach((line) => {
          if (line.trim()) {
            console.log(`[task:${task.id.substring(0, 8)}:${runtime}:err] ${line}`)
          }
        })
      })

      const rtLongRunning = ['som_batch', 'enrich_batch', 'discover', 'som', 'inbox_scan']
      const rtIsLongRunning = rtLongRunning.includes(task.type)
      const rtTypeDefault = rtIsLongRunning ? 3600 : 600
      const rtExplicit = task.config?.timeout_seconds || (task.timeout_seconds > 600 ? task.timeout_seconds : null)
      const timeout = (rtExplicit || rtTypeDefault) * 1000
      const rtTimeoutLabel = timeout / 1000
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL')
        }, 5000)
        reject(new Error(`Runtime ${runtime} timed out after ${rtTimeoutLabel}s`))
      }, timeout)

      child.on('close', (code) => {
        clearTimeout(timer)

        // For local_llm, parse the JSON response from Ollama
        if (runtime === 'local_llm' && code === 0 && outputLines.length > 0) {
          try {
            const lastLine = outputLines[outputLines.length - 1]
            const parsed = JSON.parse(lastLine)
            if (parsed.response) {
              // Replace raw JSON with the actual model response
              outputLines[outputLines.length - 1] = parsed.response
            }
          } catch { /* output as-is if not valid JSON */ }
        }

        if (code === 0) {
          resolve({ exitCode: 0 })
        } else {
          reject(new Error(`Runtime ${runtime} exited with code ${code}`))
        }
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  /**
   * Send a Discord webhook notification when a task completes or fails.
   */
  async notifyDiscord (task, status, durationMs, outputLines, errorMsg) {
    const webhookUrl = process.env.DISCORD_TASK_WEBHOOK_URL ||
      process.env.PLATFORM_UPDATES_DISCORD_CHANNEL_WEBHOOK_URL
    if (!webhookUrl) return

    const isSuccess = status === 'completed'
    const isStarted = status === 'started'
    const duration = this.formatDuration(durationMs)
    const stats = this.parseTaskOutput(outputLines)

    // Build embed fields
    const fields = [
      { name: 'Type', value: `\`${task.type}\``, inline: true },
      { name: 'Status', value: isStarted ? '🚀 Started' : isSuccess ? '✅ Completed' : '❌ Failed', inline: true },
    ]
    if (!isStarted) {
      fields.push({ name: 'Duration', value: duration, inline: true })
    }

    if (stats.scraped) fields.push({ name: 'Scraped', value: `${stats.scraped}`, inline: true })
    if (stats.created) fields.push({ name: 'Created', value: `${stats.created}`, inline: true })
    if (stats.dupes) fields.push({ name: 'Dupes', value: `${stats.dupes}`, inline: true })
    if (stats.errors) fields.push({ name: 'Errors', value: `${stats.errors}`, inline: true })
    if (stats.board) fields.push({ name: 'Board', value: `${stats.board}`, inline: true })
    if (stats.mode) fields.push({ name: 'Mode', value: stats.mode, inline: true })
    if (stats.videos) fields.push({ name: 'Videos', value: `${stats.videos}`, inline: true })

    // Top profiles / content preview
    let description = ''
    if (stats.topProfiles.length > 0) {
      const preview = stats.topProfiles.slice(0, 8)
        .map(p => `\`@${p.username}\` — ${p.comment}`)
        .join('\n')
      description = preview
    } else if (errorMsg) {
      description = `\`\`\`${errorMsg.substring(0, 300)}\`\`\``
    } else if (stats.summary) {
      description = stats.summary
    }

    // Truncate description for Discord's 4096 limit
    if (description.length > 1500) description = description.substring(0, 1500) + '...'

    const embed = {
      title: `${isStarted ? '\ud83d\ude80' : isSuccess ? '\u2705' : '\u274c'} ${task.title || task.type}`,
      description: isStarted ? `Task \`${task.type}\` starting on daemon` : (description || undefined),
      color: isStarted ? 0x3b82f6 : isSuccess ? 0x22c55e : 0xef4444,
      fields,
      footer: { text: `Hive Daemon \u2022 ${task.id.substring(0, 8)}` },
      timestamp: new Date().toISOString()
    }

    const payload = JSON.stringify({
      username: 'Hive Daemon',
      embeds: [embed]
    })

    try {
      await this.postWebhook(webhookUrl, payload)
      console.log(`[executor] Discord notification sent for ${task.id.substring(0, 8)}`)
    } catch (err) {
      console.warn(`[executor] Discord notification failed: ${err.message}`)
    }
  }

  /**
   * Parse task output to extract stats for the Discord embed.
   */
  parseTaskOutput (outputLines) {
    const stats = { topProfiles: [] }
    const output = outputLines.join('\n')

    // Leadgen stats: "Scraped: 79" / "Created: 50" / "Dupes: 0" / "Errors: 0"
    const scrapedMatch = output.match(/Scraped:\s+(\d+)/)
    if (scrapedMatch) stats.scraped = parseInt(scrapedMatch[1])

    const createdMatch = output.match(/Created:\s+(\d+)/)
    if (createdMatch) stats.created = parseInt(createdMatch[1])

    const dupesMatch = output.match(/Dupes:\s+(\d+)/)
    if (dupesMatch) stats.dupes = parseInt(dupesMatch[1])

    const errorsMatch = output.match(/Errors:\s+(\d+)/)
    if (errorsMatch) stats.errors = parseInt(errorsMatch[1])

    const boardMatch = output.match(/Board:\s+(\d+)/)
    if (boardMatch) stats.board = parseInt(boardMatch[1])

    const modeMatch = output.match(/Mode:\s+(\w+)/)
    if (modeMatch) stats.mode = modeMatch[1]

    // YouTube stats: "Scraped N videos"
    const videoMatch = output.match(/Scraped\s+(\d+)\s+videos/)
    if (videoMatch) stats.videos = parseInt(videoMatch[1])

    // Top profiles: lines like "    @username              "comment text...""
    const profilePattern = /^\s+@(\S+)\s+"(.+)"$/gm
    let match
    while ((match = profilePattern.exec(output)) !== null && stats.topProfiles.length < 10) {
      stats.topProfiles.push({
        username: match[1],
        comment: match[2].length > 60 ? match[2].substring(0, 57) + '...' : match[2]
      })
    }

    // General summary from the BATCH COMPLETE block
    const batchBlock = output.match(/BATCH COMPLETE[\s\S]*?━{10,}/g)
    if (batchBlock) {
      stats.summary = batchBlock[batchBlock.length - 1]
        .replace(/[━═╗╚╔╝║│┌┐└┘├┤┬┴┼─]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 300)
    }

    return stats
  }

  /**
   * Format milliseconds as human-readable duration.
   */
  formatDuration (ms) {
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const secs = seconds % 60
    if (minutes < 60) return `${minutes}m ${secs}s`
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    return `${hours}h ${mins}m`
  }

  /**
   * POST JSON to a Discord webhook URL.
   */
  postWebhook (url, payload) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const lib = parsed.protocol === 'https:' ? https : http
      const req = lib.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body)
          } else {
            reject(new Error(`Discord webhook returned ${res.statusCode}: ${body}`))
          }
        })
      })
      req.on('error', reject)
      req.setTimeout(5000, () => {
        req.destroy()
        reject(new Error('Discord webhook timeout'))
      })
      req.write(payload)
      req.end()
    })
  }

  /**
   * Find iris-code binary. Checks common install locations.
   */
  findIrisCode () {
    const locations = [
      '/usr/local/bin/iris-code',
      '/usr/bin/iris-code',
      path.join(process.env.HOME || '', '.local/bin/iris-code'),
      'iris-code' // fallback to PATH
    ]

    for (const loc of locations) {
      try {
        if (loc === 'iris-code' || fs.existsSync(loc)) return loc
      } catch { /* continue */ }
    }

    // Fall back to bash for now
    console.warn('[executor] iris-code not found — falling back to bash')
    return '/bin/bash'
  }

  /**
   * Estimate task progress from output lines.
   */
  estimateProgress (outputLines, task) {
    const total = outputLines.length
    if (total === 0) return 5

    // Look for percentage patterns in output
    for (let i = total - 1; i >= Math.max(0, total - 10); i--) {
      const match = outputLines[i].match(/(\d{1,3})%/)
      if (match) {
        const pct = parseInt(match[1])
        if (pct >= 0 && pct <= 100) return Math.min(pct, 95)
      }
    }

    // Estimate based on output volume (rough heuristic)
    return Math.min(Math.floor(total / 2), 90)
  }

  /**
   * Kill all running tasks (used during shutdown).
   */
  killAll () {
    for (const [taskId, child] of this.runningTasks) {
      console.log(`[executor] Killing task ${taskId}`)
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 3000)
    }
    this.runningTasks.clear()
  }
}

module.exports = { TaskExecutor }
