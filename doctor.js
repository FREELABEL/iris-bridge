#!/usr/bin/env node
/**
 * bridge:doctor — Diagnose and fix bridge/daemon connectivity issues.
 *
 * Runs the same checks Claude Code did in the debug session that found:
 *   1. Docker container stealing port 3200
 *   2. Stale API key in ~/.iris/config.json
 *   3. Daemon not starting due to auth failure
 *
 * Usage: node doctor.js [--fix]
 *   --fix   Automatically apply safe fixes (stop conflicting container, update key)
 */

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PORT = 3200
const IRIS_DIR = path.join(os.homedir(), '.iris')
const CONFIG_FILE = path.join(IRIS_DIR, 'config.json')
const autoFix = process.argv.includes('--fix')

let issues = 0
let fixed = 0

function ok (msg) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`) }
function warn (msg) { issues++; console.log(`  \x1b[33m⚠\x1b[0m ${msg}`) }
function fail (msg) { issues++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`) }
function info (msg) { console.log(`  \x1b[36mℹ\x1b[0m ${msg}`) }
function fixApplied (msg) { fixed++; console.log(`  \x1b[35m→\x1b[0m ${msg}`) }

function exec (cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim()
  } catch {
    return ''
  }
}

async function fetchJSON (url, timeoutMs = 3000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    return await resp.json()
  } catch {
    clearTimeout(timer)
    return null
  }
}

async function main () {
  console.log('\n┌──────────────────────────────────────────┐')
  console.log('│   IRIS Bridge Doctor                      │')
  console.log('└──────────────────────────────────────────┘\n')

  // ─── 1. Port 3200 check ───────────────────────────────
  console.log('Port 3200:')
  const portOwner = exec(`lsof -i :${PORT} -sTCP:LISTEN 2>/dev/null`)

  if (!portOwner) {
    info('Port 3200 is free — no bridge running')
  } else if (portOwner.includes('OrbStack') || portOwner.includes('com.docker')) {
    // Docker/OrbStack is proxying — check if it's our container
    const dockerContainer = exec('docker ps --filter "publish=3200" --format "{{.Names}}" 2>/dev/null')
    if (dockerContainer) {
      fail(`Docker container "${dockerContainer}" is occupying port 3200`)
      info('This prevents npm run bridge:local from binding')
      if (autoFix) {
        exec(`docker stop ${dockerContainer} 2>/dev/null`)
        fixApplied(`Stopped container "${dockerContainer}"`)
      } else {
        info(`Fix: docker stop ${dockerContainer}`)
      }
    } else {
      warn('OrbStack/Docker is on port 3200 but no matching container found')
      info('Fix: kill $(lsof -ti:3200)')
    }
  } else if (portOwner.includes('node')) {
    ok('Bridge process (node) is listening on port 3200')
  } else {
    warn(`Unknown process on port 3200:\n      ${portOwner.split('\n')[1] || portOwner}`)
  }

  // ─── 2. Bridge health check ───────────────────────────
  console.log('\nBridge health:')
  const health = await fetchJSON(`http://localhost:${PORT}/health`)

  if (!health) {
    fail('Cannot reach http://localhost:3200/health')
    info('Start the bridge: npm run bridge:local')
  } else {
    ok(`Bridge v${health.version || '?'} responding`)

    // Daemon status
    const daemonStatus = health.daemon?.status || 'stopped'
    if (daemonStatus === 'running') {
      ok(`Daemon running — node: ${health.daemon?.node_id || 'unknown'}`)
      const activeTasks = health.daemon?.active_tasks ?? '?'
      info(`Active tasks: ${activeTasks}`)
    } else {
      fail(`Daemon is ${daemonStatus}`)
      info('The bridge is up but not accepting tasks from the cloud')
    }
  }

  // ─── 3. Config file check ─────────────────────────────
  console.log('\nConfig (~/.iris/config.json):')

  if (!fs.existsSync(CONFIG_FILE)) {
    fail('Config file not found')
    info('Register a node in the UI or create ~/.iris/config.json manually')
  } else {
    let config = {}
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
    } catch (err) {
      fail(`Config file is corrupted: ${err.message}`)
    }

    if (config.node_api_key) {
      ok(`Production key: ${config.node_api_key.slice(0, 15)}...`)
    } else {
      warn('No node_api_key (production) in config')
    }

    if (config.local_api_key) {
      ok(`Local key: ${config.local_api_key.slice(0, 15)}...`)
    } else {
      warn('No local_api_key in config')
      info('Set one: edit ~/.iris/config.json or use the UI Sync button')
    }

    if (config.paused) {
      warn('Daemon is paused in config — it will not accept tasks')
      info('Fix: npm run bridge:resume')
    }

    if (config.iris_api_url) {
      ok(`Production API: ${config.iris_api_url}`)
    }
  }

  // ─── 4. Key validity check ────────────────────────────
  console.log('\nKey validation:')

  let config = {}
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
  } catch { /* no config */ }

  // Check local key against local iris-api
  const localKey = config.local_api_key
  if (localKey) {
    // Try multiple URLs — local.iris.freelabel.net may not resolve from host
    const localUrls = [
      'http://localhost:8080', // common iris-api local port
      'https://local.iris.freelabel.net'
    ]
    let keyValid = null

    for (const baseUrl of localUrls) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 3000)
        const resp = await fetch(`${baseUrl}/api/v6/nodes/heartbeat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Node-Key': localKey
          },
          body: JSON.stringify({}),
          signal: controller.signal
        })
        clearTimeout(timer)

        if (resp.status === 401 || resp.status === 403) {
          keyValid = false
        } else {
          keyValid = true
        }
        break // Got a response, stop trying
      } catch {
        continue // Try next URL
      }
    }

    if (keyValid === true) {
      ok('Local API key is valid')
    } else if (keyValid === false) {
      fail('Local API key is INVALID (401/403)')
      info('The key in config.json does not match any node in the local DB')
      info('Fix: Use the UI "Connect" modal → "Sync to Bridge"')
      info('Or: Update ~/.iris/config.json local_api_key manually')
    } else {
      info('Could not reach local iris-api to validate key (not running or network issue)')
    }
  } else {
    info('No local key to validate')
  }

  // ─── 5. Docker container check ────────────────────────
  console.log('\nDocker:')
  const dockerRunning = exec('docker ps --format "{{.Names}}" 2>/dev/null')
  if (!dockerRunning) {
    info('Docker not running or no containers')
  } else {
    const bridgeContainer = dockerRunning.split('\n').find(n => n.includes('bridge'))
    if (bridgeContainer) {
      warn(`Docker bridge container "${bridgeContainer}" is running`)
      info('This will conflict with npm run bridge:local')
      if (autoFix) {
        exec(`docker stop ${bridgeContainer} 2>/dev/null`)
        fixApplied(`Stopped "${bridgeContainer}"`)
      } else {
        info(`Fix: docker stop ${bridgeContainer}`)
      }
    } else {
      ok('No conflicting Docker bridge container')
    }

    const irisApi = dockerRunning.split('\n').find(n => n.includes('iris-api'))
    if (irisApi) {
      ok(`Local iris-api running (${irisApi})`)
    } else {
      info('No local iris-api container — local mode may not work')
    }
  }

  // ─── 6. Pusher check ─────────────────────────────────
  console.log('\nPusher:')
  if (config.pusher_cluster) {
    ok(`Cluster: ${config.pusher_cluster}`)
  } else {
    info('No pusher_cluster in config — will use default (us2)')
  }
  if (config.pusher_key) {
    ok('Pusher key configured')
  } else {
    info('No pusher_key in config — will get from cloud on connect')
  }

  // ─── Summary ──────────────────────────────────────────
  console.log('\n──────────────────────────────────────────')
  if (issues === 0) {
    console.log(`\x1b[32m  All checks passed. Bridge is healthy.\x1b[0m`)
  } else {
    console.log(`\x1b[33m  ${issues} issue(s) found.${autoFix ? ` ${fixed} auto-fixed.` : ' Run with --fix to auto-repair.'}\x1b[0m`)
  }
  if (!autoFix && issues > 0) {
    console.log(`  Tip: \x1b[36mnpm run bridge:doctor -- --fix\x1b[0m`)
  }
  console.log()

  process.exit(issues > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`Doctor crashed: ${err.message}`)
  process.exit(2)
})
