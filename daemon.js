#!/usr/bin/env node
/**
 * IRIS Hive — Sovereign Compute Node
 *
 * "The supreme art of war is to subdue the enemy without fighting."  — Sun Tzu
 *
 * AWS, Google, and Microsoft built cloud infrastructure for Fortune 500
 * enterprises — not for builders, creators, and independent teams. Every
 * prompt sent to their APIs is logged, billed at their rates, and one TOS
 * update away from changing what you can do with your own data.
 *
 * Hive inverts this. We don't compete with AWS by building a bigger data
 * center. We turn the user's existing hardware — MacBooks, Raspberry Pis,
 * GPU workstations, VPS boxes — into a distributed sovereign cloud.
 * Zero-latency, zero-subscription inference on hardware they already own.
 *
 * The Innovator's Dilemma protects us: if Amazon ships a tool that runs
 * 100% of AI offline on local hardware, they lose billions in AWS cloud
 * revenue. They can't fully commit to this space. We can.
 *
 * Architecture: Sovereign when you can, proxied when you must.
 *   - Local Ollama models = zero proxy, zero API keys, full sovereignty
 *   - Cloud LLM calls = proxied through iris-api hub, node never sees keys
 *   - The node has nothing worth stealing and nothing worth preserving.
 *
 * Usage:
 *   node daemon.js                          Start the daemon
 *   node daemon.js --pause                  Pause the running daemon
 *   node daemon.js --resume                 Resume the running daemon
 *   node daemon.js --status                 Show current daemon status
 *   node daemon.js --api-key node_live_xxx  Specify API key
 *   node daemon.js --api-url https://...    Specify hub URL
 *   node daemon.js --fl-api-path /path      Override auto-detected Laravel root
 *   OR via env: NODE_API_KEY=node_live_xxx IRIS_API_URL=... node daemon.js
 *
 * Lifecycle: Uses a Unix domain socket (~/.iris/daemon.sock) for single-instance
 * locking and IPC. The OS automatically cleans up the socket when the process dies.
 * No PID files, no pgrep, no orphan races.
 */

const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')

const IRIS_DIR = path.join(os.homedir(), '.iris')
const CONFIG_FILE = path.join(IRIS_DIR, 'config.json')
const STATUS_FILE = path.join(IRIS_DIR, 'status.json')
const SOCK_FILE = process.platform === 'win32'
  ? '\\\\.\\pipe\\iris-daemon'
  : path.join(IRIS_DIR, 'daemon.sock')

// Ensure ~/.iris directory exists
if (!fs.existsSync(IRIS_DIR)) fs.mkdirSync(IRIS_DIR, { recursive: true })

// Helper: clean up socket file (no-op on Windows named pipes)
function cleanupSocket () {
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(SOCKET_PATH) } catch {}
  }
}

// Load .env
try {
  const envPath = process.env.BRIDGE_ENV_FILE || path.join(__dirname, '.env')
  require('dotenv').config({ path: envPath })
} catch { /* fine */ }

// Parse CLI args
const args = process.argv.slice(2)

// ─── CLI Commands (talk to running daemon via socket) ────────────

if (args.includes('--pause') || args.includes('pause')) {
  sendIpcCommand({ cmd: 'pause' }).then(() => process.exit(0))
  setTimeout(() => process.exit(1), 3000) // timeout
} else if (args.includes('--resume') || args.includes('resume')) {
  sendIpcCommand({ cmd: 'resume' }).then(() => process.exit(0))
  setTimeout(() => process.exit(1), 3000)
} else if (args.includes('--status') || args.includes('status')) {
  handleStatus()
} else if (args.includes('--mesh-scan')) {
  sendIpcCommand({ cmd: 'mesh-scan' }).then(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000)
} else if (args.includes('--mesh-peers')) {
  sendIpcCommand({ cmd: 'mesh-peers' }).then(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000)
} else if (args.includes('--mesh-invite')) {
  sendIpcCommand({ cmd: 'mesh-invite' }).then(() => process.exit(0))
  setTimeout(() => process.exit(1), 3000)
} else if (args.includes('--mesh-pair')) {
  const pairIdx = args.indexOf('--mesh-pair')
  const code = args[pairIdx + 1]
  if (!code) { console.error('Usage: --mesh-pair XXXX-XXXX'); process.exit(1) }
  sendIpcCommand({ cmd: 'mesh-pair', code }).then(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000)
} else if (args.includes('--mesh-send')) {
  const sendIdx = args.indexOf('--mesh-send')
  const peer = args[sendIdx + 1]
  const type = args[sendIdx + 2]
  const prompt = args.slice(sendIdx + 3).join(' ')
  if (!peer || !type) { console.error('Usage: --mesh-send <peer> <type> <prompt>'); process.exit(1) }
  sendIpcCommand({ cmd: 'mesh-send', peer, type, prompt }).then(() => process.exit(0))
  setTimeout(() => process.exit(1), 15000)
} else if (args.includes('--mesh-chat')) {
  const chatIdx = args.indexOf('--mesh-chat')
  const peer = args[chatIdx + 1]
  const text = args.slice(chatIdx + 2).join(' ')
  if (!peer || !text) { console.error('Usage: --mesh-chat <peer> <message>'); process.exit(1) }
  sendIpcCommand({ cmd: 'mesh-chat', peer, text }).then(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000)
} else if (args.includes('--share')) {
  // Start SSH share — works standalone OR tells running daemon to enable sharing
  const sharePort = getArg('--port') || '2222'
  const shareTtl = getArg('--ttl') || '30' // minutes
  const isPublic = args.includes('--public')
  handleShare(parseInt(sharePort, 10), parseInt(shareTtl, 10) * 60 * 1000, isPublic)
} else if (args.includes('--unshare')) {
  sendIpcCommand({ cmd: 'unshare' }).then(() => process.exit(0))
  setTimeout(() => process.exit(1), 3000)
} else {
  // Normal daemon startup
  startDaemon()
}

// ─── IPC: Send command to running daemon ─────────────────────────

function sendIpcCommand (msg) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCK_FILE, () => {
      client.write(JSON.stringify(msg) + '\n')
    })
    client.on('data', (data) => {
      try {
        const resp = JSON.parse(data.toString().trim())
        if (resp.status === 'ok') {
          console.log(`[iris-daemon] ${resp.message || 'Done'}`)
        } else {
          console.error(`[iris-daemon] Error: ${resp.message || 'Unknown'}`)
        }
      } catch {
        console.log(data.toString().trim())
      }
      client.end()
      resolve()
    })
    client.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        console.log('[iris-daemon] No daemon running.')
        // For pause/resume, update config file as fallback
        if (msg.cmd === 'pause' || msg.cmd === 'resume') {
          updateConfigPaused(msg.cmd === 'pause')
          console.log(`[iris-daemon] Config updated. Will take effect on next start.`)
        }
      } else {
        console.error(`[iris-daemon] Connection failed: ${err.message}`)
      }
      resolve()
    })
  })
}

function updateConfigPaused (paused) {
  let config = {}
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
    }
  } catch { /* fresh */ }
  config.paused = paused
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

// ─── Status command ──────────────────────────────────────────────

function handleStatus () {
  // Try socket first for live status
  const client = net.createConnection(SOCK_FILE, () => {
    client.write(JSON.stringify({ cmd: 'status' }) + '\n')
  })

  client.on('data', (data) => {
    try {
      const resp = JSON.parse(data.toString().trim())
      if (resp.status === 'ok' && resp.data) {
        printStatusBox(resp.data, true)
      }
    } catch {
      console.log(data.toString().trim())
    }
    client.end()
    process.exit(0)
  })

  client.on('error', () => {
    // No live daemon — fall back to status file
    if (fs.existsSync(STATUS_FILE)) {
      try {
        const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'))
        printStatusBox(status, false)
      } catch {
        console.log('Status file exists but is corrupted.')
      }
    } else {
      console.log('No daemon status found. Is the daemon running?')
    }
    process.exit(0)
  })

  setTimeout(() => process.exit(0), 3000) // timeout
}

function printStatusBox (status, live) {
  console.log('┌─────────────────────────────────────────┐')
  console.log('│   IRIS Daemon Status                     │')
  console.log('├─────────────────────────────────────────┤')
  console.log(`│  Status:  ${(status.status || 'unknown').padEnd(30)}│`)
  console.log(`│  Node:    ${(status.node_name || 'unknown').padEnd(30)}│`)
  console.log(`│  Tasks:   ${String(status.running_tasks || 0).padEnd(30)}│`)
  if (status.capacity) {
    console.log(`│  CPU:     ${String(status.capacity.cpu_pct + '%').padEnd(30)}│`)
    console.log(`│  Memory:  ${String(status.capacity.free_mem_mb + 'MB free').padEnd(30)}│`)
    console.log(`│  Battery: ${String(status.capacity.on_battery ? status.capacity.battery_pct + '% (unplugged)' : 'AC Power').padEnd(30)}│`)
    console.log(`│  Level:   ${status.capacity.level.padEnd(30)}│`)
  }
  if (status.heartbeat) {
    const hbLabel = status.heartbeat.state === 'closed' ? 'healthy' : `${status.heartbeat.state} (${status.heartbeat.fail_count} fails)`
    console.log(`│  Hbeat:   ${hbLabel.padEnd(30)}│`)
  }
  if (status.reason) {
    console.log(`│  Reason:  ${status.reason.padEnd(30)}│`)
  }
  console.log(`│  Updated: ${(status.last_updated || '').substring(11, 19).padEnd(30)}│`)
  console.log(`│  PID:     ${String(live ? status.pid || process.pid : 'n/a').padEnd(30)}│`)
  console.log('└─────────────────────────────────────────┘')
  console.log(`Daemon process: ${live ? 'running (live socket)' : 'not running (stale status file)'}`)
}

// ─── Share command (standalone or via running daemon) ────────────

function handleShare (port, ttlMs, isPublic) {
  // Try to tell running daemon to enable sharing
  const probe = net.createConnection(SOCK_FILE, () => {
    probe.write(JSON.stringify({ cmd: 'share', port, ttlMs, isPublic }) + '\n')
  })

  probe.on('data', (data) => {
    try {
      const resp = JSON.parse(data.toString().trim())
      if (resp.status === 'ok' && resp.data) {
        printShareBox(resp.data)
      } else {
        console.error(`[ssh-share] ${resp.message || 'Failed'}`)
      }
    } catch {
      console.log(data.toString().trim())
    }
    probe.end()
    if (!isPublic) process.exit(0)
    // For public mode via daemon, keep alive to show status
  })

  probe.on('error', () => {
    // No running daemon — start SSH share standalone
    console.log('[ssh-share] No running daemon — starting standalone SSH share...')
    startStandaloneShare(port, ttlMs, isPublic)
  })

  setTimeout(() => {
    // Only timeout if we haven't started standalone yet
    if (!probe.destroyed) {
      console.error('[ssh-share] Timeout waiting for daemon response')
      process.exit(1)
    }
  }, 5000)
}

async function startStandaloneShare (port, ttlMs, isPublic) {
  const SSHShare = require('./daemon/ssh-share')
  const share = new SSHShare({ port, ttlMs })

  try {
    const info = await share.start()

    if (isPublic) {
      console.log('[ssh-share] Starting public tunnel via ngrok...')
      try {
        const tunnel = await share.startPublicTunnel()
        // Override the share info with public URL
        info.tunnel = tunnel
        info.commands = {
          ...info.commands,
          public: `ssh iris-hive@${tunnel.host} -p ${tunnel.port}`
        }
        printShareBox(info)
        console.log('\nPublic tunnel active. Press Ctrl+C to stop.\n')
      } catch (err) {
        console.error(`[ssh-share] Tunnel failed: ${err.message}`)
        console.log('[ssh-share] Falling back to LAN-only mode')
        printShareBox(info)
        console.log('\nPress Ctrl+C to stop sharing.\n')
      }
    } else {
      printShareBox(info)
      console.log('\nPress Ctrl+C to stop sharing.\n')
    }
  } catch (err) {
    console.error(`[ssh-share] Failed to start: ${err.message}`)
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is in use. Try: --port 2223`)
    }
    process.exit(1)
  }

  process.on('SIGINT', () => {
    share.stop()
    process.exit(0)
  })
}

function printShareBox (info) {
  const ttlMin = Math.round((info.ttlMs || 1800000) / 60000)
  const ts = info.ips?.tailscale
  const lan = info.ips?.local?.[0]
  const tunnel = info.tunnel
  const publicCmd = info.commands?.public
  const bestCmd = publicCmd || info.commands?.tailscale || info.commands?.lan || info.commands?.generic

  console.log('')
  console.log('┌──────────────────────────────────────────────────────┐')
  if (tunnel) {
    console.log('│   \x1b[1mIRIS Hive — Public Terminal Sharing\x1b[0m                 │')
  } else {
    console.log('│   \x1b[1mIRIS Hive — Terminal Sharing\x1b[0m                        │')
  }
  console.log('├──────────────────────────────────────────────────────┤')
  console.log(`│  Password:  \x1b[33m${info.password.padEnd(40)}\x1b[0m│`)
  console.log(`│  Expires:   ${(ttlMin + ' minutes').padEnd(40)}│`)

  if (tunnel) {
    console.log(`│  Tunnel:    \x1b[36m${tunnel.url.padEnd(40)}\x1b[0m│`)
  }
  if (ts) {
    console.log(`│  Tailscale: \x1b[36m${ts.padEnd(40)}\x1b[0m│`)
  }
  if (lan) {
    console.log(`│  LAN:       \x1b[36m${lan.padEnd(40)}\x1b[0m│`)
  }

  console.log('├──────────────────────────────────────────────────────┤')
  console.log('│  \x1b[1mSend this to your friend:\x1b[0m                            │')
  console.log('│                                                      │')

  // Print the command
  const cmd = bestCmd || `ssh iris-hive@<ip> -p ${info.port}`
  const cmdLines = cmd.length <= 50 ? [cmd] : [cmd.substring(0, 52), cmd.substring(52)]
  for (const line of cmdLines) {
    console.log(`│  \x1b[32m${line.padEnd(52)}\x1b[0m│`)
  }
  console.log(`│  Password: \x1b[33m${info.password.padEnd(41)}\x1b[0m│`)
  console.log('│                                                      │')
  console.log('│  \x1b[90mType "yes" at fingerprint prompt, then paste password\x1b[0m │')
  console.log('└──────────────────────────────────────────────────────┘')
}

// ─── Daemon Startup ──────────────────────────────────────────────

function startDaemon () {
  const { Daemon } = require('./daemon/index')

  // Load config from ~/.iris/config.json if it exists (native install mode)
  let fileConfig = {}
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
    }
  } catch { /* ignore */ }

  // ─── Environment Detection ────────────────────────────────────
  const PRODUCTION_URL = 'https://freelabel.net'
  const LOCAL_URL = 'https://local.iris.freelabel.net'
  const isLocalFlag = args.includes('--local')
  const isProductionFlag = args.includes('--production') || args.includes('--prod')

  function resolveApiUrl () {
    if (isLocalFlag) return LOCAL_URL
    if (isProductionFlag) return PRODUCTION_URL
    const explicit = getArg('--api-url') || process.env.IRIS_API_URL
    if (explicit) return explicit
    const configUrl = fileConfig.api_url || fileConfig.iris_api_url
    if (configUrl && !/local\.|localhost|127\.0\.0\.1/.test(configUrl)) {
      return configUrl
    }
    return PRODUCTION_URL
  }

  const resolvedApiUrl = resolveApiUrl()
  const mode = isLocalFlag ? 'local' : (resolvedApiUrl.includes('local.') || resolvedApiUrl.includes('localhost') ? 'local' : 'production')

  function resolveApiKey () {
    const explicit = getArg('--api-key') || process.env.NODE_API_KEY
    if (explicit) return explicit
    if (mode === 'local' && fileConfig.local_api_key) return fileConfig.local_api_key
    return fileConfig.node_api_key
  }

  const config = {
    apiKey: resolveApiKey(),
    apiUrl: resolvedApiUrl,
    apiUrlFallback: getArg('--api-url-fallback') || process.env.IRIS_API_URL_FALLBACK || fileConfig.iris_api_url_fallback || (mode === 'local' ? PRODUCTION_URL : null),
    dataDir: getArg('--data-dir') || process.env.DAEMON_DATA_DIR || path.join(__dirname, '..', 'daemon-data'),
    flApiPath: getArg('--fl-api-path') || process.env.FL_API_PATH || null,
    pusherKey: process.env.PUSHER_KEY || fileConfig.pusher_key,
    pusherCluster: process.env.PUSHER_CLUSTER || fileConfig.pusher_cluster || 'us2',
    maxCpuThreshold: fileConfig.max_cpu_threshold || null
  }

  if (!config.apiKey) {
    console.error('Error: Node API key required.')
    console.error('  node daemon.js --api-key node_live_xxx')
    console.error('  OR set NODE_API_KEY environment variable')
    console.error('  OR configure ~/.iris/config.json')
    process.exit(1)
  }

  // ─── Socket Lock: Request handoff from existing daemon ────────
  acquireSocketLock(() => {
    // Reset circuit breaker on fresh start
    if (fs.existsSync(STATUS_FILE)) {
      try {
        const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'))
        if (status.heartbeat && (status.heartbeat.state !== 'closed' || status.heartbeat.fail_count > 0)) {
          status.heartbeat = { state: 'closed', fail_count: 0 }
          fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2))
          console.log('[startup] Reset heartbeat circuit breaker')
        }
      } catch { /* fine */ }
    }

    const modeLabel = mode === 'local' ? 'LOCAL DEV' : 'PRODUCTION'
    console.log('┌──────────────────────────────────────────────┐')
    console.log('│   IRIS Compute Node Daemon v2.2               │')
    console.log('│   Sovereign Distributed Agent Network         │')
    console.log('├──────────────────────────────────────────────┤')
    console.log(`│  Mode:     ${modeLabel.padEnd(35)}│`)
    console.log(`│  API:      ${config.apiUrl.substring(0, 35).padEnd(35)}│`)
    console.log(`│  Fallback: ${(config.apiUrlFallback || 'none').substring(0, 35).padEnd(35)}│`)
    console.log(`│  Key:      ${config.apiKey.substring(0, 20)}...${' '.repeat(12)}│`)
    console.log('└──────────────────────────────────────────────┘')

    const daemon = new Daemon(config)

    // ─── IPC Server: Handle commands from CLI ─────────────────
    const ipcServer = net.createServer((conn) => {
      conn.on('data', (data) => {
        try {
          const msg = JSON.parse(data.toString().trim())
          handleIpcMessage(msg, conn, daemon)
        } catch {
          conn.end(JSON.stringify({ status: 'error', message: 'Invalid JSON' }) + '\n')
        }
      })
    })

    ipcServer.listen(SOCK_FILE, () => {
      // Socket is now locked to this process
    })

    ipcServer.on('error', (err) => {
      console.error(`[ipc] Server error: ${err.message}`)
    })

    // ─── Graceful shutdown ────────────────────────────────────
    function cleanup (signal) {
      ipcServer.close()
      cleanupSocket()
      daemon.shutdown(signal)
    }

    process.on('SIGINT', () => cleanup('SIGINT'))
    process.on('SIGTERM', () => cleanup('SIGTERM'))

    daemon.start().catch((err) => {
      console.error('Daemon cloud auth failed:', err.message)
      console.error('[daemon] Running in OFFLINE mode — local schedules and HTTP server still active')
      console.error('[daemon] Cloud tasks will not be dispatched until auth is fixed')
      console.error('[daemon] Retry: iris bridge restart')
    })
  })

  // ─── Handle IPC messages from CLI commands ──────────────────

  function handleIpcMessage (msg, conn, daemon) {
    switch (msg.cmd) {
      case 'replace':
        conn.end(JSON.stringify({ status: 'ok', message: 'Shutting down for replacement' }) + '\n')
        // Give the response a moment to flush, then exit
        setTimeout(() => {
          cleanupSocket()
          daemon.shutdown('replace')
        }, 200)
        break

      case 'pause':
        updateConfigPaused(true)
        daemon._handleConfigReload && daemon._handleConfigReload()
        conn.end(JSON.stringify({ status: 'ok', message: 'Daemon paused' }) + '\n')
        break

      case 'resume':
        updateConfigPaused(false)
        daemon._handleConfigReload && daemon._handleConfigReload()
        conn.end(JSON.stringify({ status: 'ok', message: 'Daemon resumed' }) + '\n')
        break

      case 'status': {
        let statusData = {}
        if (fs.existsSync(STATUS_FILE)) {
          try { statusData = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')) } catch { /* empty */ }
        }
        statusData.pid = process.pid
        conn.end(JSON.stringify({ status: 'ok', data: statusData }) + '\n')
        break
      }

      // ── Mesh networking commands ───────────────────────────────

      case 'mesh-scan': {
        const peers = daemon.meshDiscovery ? [...daemon.meshDiscovery.getPeers().values()] : []
        console.log(`[mesh] ${peers.length} peer(s) discovered via mDNS:`)
        peers.forEach(p => console.log(`  ${p.name} @ ${p.ip || p.host}:${p.port}`))
        conn.end(JSON.stringify({ status: 'ok', data: peers }) + '\n')
        break
      }

      case 'mesh-peers': {
        const allPeers = daemon.meshRegistry ? daemon.meshRegistry.getAllPeers() : []
        console.log(`[mesh] ${allPeers.length} known peer(s):`)
        allPeers.forEach(p => console.log(`  ${p.name} [${p.status}] @ ${p.host}:${p.port} (via ${p.added_via})`))
        conn.end(JSON.stringify({ status: 'ok', data: allPeers }) + '\n')
        break
      }

      case 'mesh-invite': {
        if (!daemon.meshAuth) {
          conn.end(JSON.stringify({ status: 'error', message: 'Mesh not initialized' }) + '\n')
          break
        }
        const invite = daemon.meshAuth.generateInvite()
        console.log(`[mesh] Invite code: ${invite.code} (expires ${invite.expiresAt})`)
        conn.end(JSON.stringify({ status: 'ok', data: invite }) + '\n')
        break
      }

      case 'mesh-pair': {
        if (!daemon.meshAuth) {
          conn.end(JSON.stringify({ status: 'error', message: 'Mesh not initialized' }) + '\n')
          break
        }
        try {
          const pairResult = daemon.meshAuth.acceptInvite(msg.code)
          console.log(`[mesh] Paired successfully`)
          conn.end(JSON.stringify({ status: 'ok', data: { psk: pairResult.psk } }) + '\n')
        } catch (err) {
          conn.end(JSON.stringify({ status: 'error', message: err.message }) + '\n')
        }
        break
      }

      case 'mesh-send': {
        if (!daemon.meshDispatch) {
          conn.end(JSON.stringify({ status: 'error', message: 'Mesh not initialized' }) + '\n')
          break
        }
        daemon.meshDispatch.dispatchToPeer(msg.peer, {
          type: msg.type,
          prompt: msg.prompt,
          title: `CLI mesh task → ${msg.peer}`
        }).then(result => {
          console.log(`[mesh] Task dispatched to ${msg.peer}: ${result.taskId}`)
          conn.end(JSON.stringify({ status: 'ok', data: result }) + '\n')
        }).catch(err => {
          conn.end(JSON.stringify({ status: 'error', message: err.message }) + '\n')
        })
        break
      }

      case 'mesh-chat': {
        if (!daemon.meshChat) {
          conn.end(JSON.stringify({ status: 'error', message: 'Mesh not initialized' }) + '\n')
          break
        }
        daemon.meshChat.sendMessage(msg.peer, msg.text).then(result => {
          console.log(`[mesh] Message sent to ${msg.peer}`)
          conn.end(JSON.stringify({ status: 'ok', data: result }) + '\n')
        }).catch(err => {
          conn.end(JSON.stringify({ status: 'error', message: err.message }) + '\n')
        })
        break
      }

      // ── SSH Share commands ────────────────────────────────────────

      case 'share': {
        const SSHShare = require('./daemon/ssh-share')
        if (daemon._sshShare && daemon._sshShare._running) {
          const status = daemon._sshShare.getStatus()
          conn.end(JSON.stringify({ status: 'ok', message: 'SSH share already running', data: { ...status, commands: daemon._sshShareInfo?.commands } }) + '\n')
          break
        }
        const share = new SSHShare({ port: msg.port || 2222, ttlMs: msg.ttlMs || 1800000 })
        share.start().then((info) => {
          daemon._sshShare = share
          daemon._sshShareInfo = info
          share.on('stopped', () => {
            daemon._sshShare = null
            daemon._sshShareInfo = null
          })
          conn.end(JSON.stringify({ status: 'ok', data: info }) + '\n')
        }).catch((err) => {
          conn.end(JSON.stringify({ status: 'error', message: err.message }) + '\n')
        })
        break
      }

      case 'unshare': {
        if (daemon._sshShare) {
          daemon._sshShare.stop()
          daemon._sshShare = null
          daemon._sshShareInfo = null
          conn.end(JSON.stringify({ status: 'ok', message: 'SSH share stopped' }) + '\n')
        } else {
          conn.end(JSON.stringify({ status: 'ok', message: 'No active SSH share' }) + '\n')
        }
        break
      }

      default:
        conn.end(JSON.stringify({ status: 'error', message: `Unknown command: ${msg.cmd}` }) + '\n')
    }
  }
}

// ─── Socket Lock Acquisition ─────────────────────────────────────
// Try to bind the socket. If another daemon holds it, send "replace"
// and wait for it to exit. If socket is stale (dead process), clean up.

function acquireSocketLock (onAcquired) {
  // First, try to connect to see if someone is already listening
  // On Windows, named pipes don't exist as files — just try connecting
  if (process.platform !== 'win32' && !fs.existsSync(SOCK_FILE)) {
    onAcquired()
    return
  }

  const probe = net.createConnection(SOCK_FILE, () => {
    // Socket is live — another daemon is running. Request handoff.
    console.log('[startup] Requesting handoff from running daemon...')
    probe.write(JSON.stringify({ cmd: 'replace' }) + '\n')
  })

  probe.on('data', (data) => {
    try {
      const resp = JSON.parse(data.toString().trim())
      console.log(`[startup] ${resp.message || 'Previous daemon acknowledged'}`)
    } catch { /* fine */ }
    probe.end()

    // Wait for old daemon to release the socket
    const deadline = Date.now() + 5000
    const waitForRelease = () => {
      // Try to connect — if it fails, the old daemon is gone
      const check = net.createConnection(SOCK_FILE, () => {
        check.end()
        if (Date.now() < deadline) {
          setTimeout(waitForRelease, 200)
        } else {
          console.error('[startup] Previous daemon did not exit in time. Force-cleaning socket.')
          cleanupSocket()
          onAcquired()
        }
      })
      check.on('error', () => {
        // Connection refused or socket gone — old daemon exited
        cleanupSocket()
        console.log('[startup] Previous daemon stopped')
        onAcquired()
      })
    }
    setTimeout(waitForRelease, 500) // brief pause for shutdown
  })

  probe.on('error', (err) => {
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
      // Stale socket from a dead process — clean it up
      console.log('[startup] Cleaning stale socket')
      cleanupSocket()
      onAcquired()
    } else {
      console.error(`[startup] Socket probe failed: ${err.message}`)
      cleanupSocket()
      onAcquired()
    }
  })
}

// ─── Helpers ─────────────────────────────────────────────────────

function getArg (name) {
  const idx = args.indexOf(name)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null
}
