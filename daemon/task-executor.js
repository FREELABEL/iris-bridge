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
const https = require('https')
const http = require('http')

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

// Auto-detect freelabel project root (looks for som:creators npm script)
function findFreelabelPath () {
  // 1. Explicit env var
  if (process.env.FREELABEL_PATH) {
    const pkg = path.join(process.env.FREELABEL_PATH, 'package.json')
    if (fs.existsSync(pkg)) return process.env.FREELABEL_PATH
  }
  // 2. Relative paths from daemon/ directory
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
    execSync('docker compose ps api --quiet 2>/dev/null', { stdio: 'pipe' })
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
    if (this.flApiPath) {
      console.log(`[executor] fl-api path: ${this.flApiPath}`)
    } else {
      console.warn('[executor] fl-api not found — artisan tasks will fail. Set FL_API_PATH env var.')
    }
    this.freelabelPath = findFreelabelPath()
    if (this.freelabelPath) {
      console.log(`[executor] freelabel path: ${this.freelabelPath}`)
    } else {
      console.warn('[executor] freelabel root not found — som tasks will fail. Set FREELABEL_PATH env var.')
    }
  }

  async execute (task) {
    const taskId = task.id
    const runtime = task.runtime || task.config?.runtime || process.env.RUNTIME || 'iris_agent'
    const startTime = Date.now()

    console.log(`[executor] Starting task: ${taskId}`)
    console.log(`[executor]   Type: ${task.type}`)
    console.log(`[executor]   Runtime: ${runtime}`)
    console.log(`[executor]   Title: ${task.title}`)

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
          credentialFilePath = path.join(workspace.dir, 'session-auth.json')
          fs.writeFileSync(credentialFilePath, JSON.stringify(credResult.credentials), 'utf-8')
          fs.chmodSync(credentialFilePath, '600')
          // Inject into task config so spawn picks it up via env vars
          task.config.env_vars = task.config.env_vars || {}
          task.config.env_vars.BROWSER_SESSION_FILE = credentialFilePath
          console.log(`[executor] Credentials written to ${credentialFilePath}`)
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

      // Collect output files
      const files = this.workspaces.collectOutputFiles(taskId)

      // Submit result
      await this.cloud.submitResult(taskId, {
        status: 'completed',
        output: outputLines.join('\n'),
        files,
        duration_ms: Date.now() - startTime,
        metadata: { exit_code: result.exitCode }
      })

      console.log(`[executor] Task ${taskId} completed in ${Date.now() - startTime}ms`)

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

      console.error(`[executor] Task ${taskId} failed: ${err.message}`)

      // Discord notification
      this.notifyDiscord(task, 'failed', Date.now() - startTime, outputLines, err.message).catch(() => {})
    } finally {
      // Clean up credential temp file immediately — never persist sessions on disk
      if (credentialFilePath && fs.existsSync(credentialFilePath)) {
        fs.unlinkSync(credentialFilePath)
        console.log(`[executor] Credential file cleaned up: ${credentialFilePath}`)
      }
      this.runningTasks.delete(taskId)
      // Clean up workspace after a delay (keep for debugging)
      setTimeout(() => this.workspaces.cleanup(taskId), 60000)
    }
  }

  runProcess (task, workspace, outputLines) {
    return new Promise((resolve, reject) => {
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

          cmd = 'npm'
          args = ['run', `som:${campaign}`, '--', ...somExtraArgs]
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
          cmd = 'curl'
          args = [
            '-s', '-X', 'POST',
            `${irisApiUrl}/api/v1/users/${userId}/integrations/execute-direct`,
            '-H', 'Content-Type: application/json',
            '-d', payload,
            '--insecure'
          ]
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
          const pName = pConfig.process_name || pWsName || `proc-${task.id.substring(0, 8)}`
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

        default:
          // Default: treat prompt as a shell command
          cmd = '/bin/bash'
          args = ['-c', task.prompt]
      }

      console.log(`[executor] Running: ${cmd} ${args.slice(0, 2).join(' ')}...`)

      const child = spawn(cmd, args, {
        cwd: workspace.projectDir,
        env: {
          ...process.env,
          TASK_ID: task.id,
          TASK_TYPE: task.type,
          WORKSPACE_DIR: workspace.dir,
          PROJECT_DIR: workspace.projectDir,
          ...(task.config?.env_vars || {})
        },
        stdio: ['pipe', 'pipe', 'pipe']
      })

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

      // Timeout
      const timeout = (task.timeout_seconds || 600) * 1000
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL')
        }, 5000)
        reject(new Error(`Task timed out after ${task.timeout_seconds || 600}s`))
      }, timeout)

      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          resolve({ exitCode: 0 })
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

      const child = spawn(cmd, args, {
        cwd: workspace.projectDir,
        env: {
          ...process.env,
          TASK_ID: task.id,
          TASK_TYPE: task.type,
          RUNTIME: runtime,
          ...(task.config?.env_vars || {})
        },
        stdio: ['pipe', 'pipe', 'pipe']
      })

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

      const timeout = (task.timeout_seconds || 600) * 1000
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL')
        }, 5000)
        reject(new Error(`Runtime ${runtime} timed out after ${task.timeout_seconds || 600}s`))
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
    const duration = this.formatDuration(durationMs)
    const stats = this.parseTaskOutput(outputLines)

    // Build embed fields
    const fields = [
      { name: 'Type', value: `\`${task.type}\``, inline: true },
      { name: 'Duration', value: duration, inline: true },
      { name: 'Status', value: isSuccess ? 'Completed' : 'Failed', inline: true }
    ]

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
      title: `${isSuccess ? '\u2705' : '\u274c'} ${task.title || task.type}`,
      description: description || undefined,
      color: isSuccess ? 0x22c55e : 0xef4444,
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
