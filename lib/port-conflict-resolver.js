/**
 * Port Conflict Resolver — Detects and resolves EADDRINUSE conflicts.
 *
 * Checks for Docker containers and launchd agents that may be holding
 * the bridge port. In local mode (IRIS_LOCAL=1), auto-stops them.
 *
 * Extracted from index.js for testability.
 */

const { execSync: defaultExecSync } = require('child_process')

/**
 * Attempt to resolve a port conflict.
 *
 * @param {number} port - The port that's in use
 * @param {Object} options
 * @param {boolean} options.isLocal - Whether IRIS_LOCAL=1 or --local flag is set
 * @param {Function} options.execSync - Injected execSync for testing
 * @returns {{ action: 'retry'|'monitor', stopped?: string, target?: string }}
 */
function resolvePortConflict (port, options = {}) {
  const isLocal = options.isLocal || false
  const exec = options.execSync || defaultExecSync

  // ─── Check 1: Docker container ────────────────────────────────
  try {
    const container = exec(
      `docker ps --filter "publish=${port}" --format "{{.Names}}" 2>/dev/null`,
      { encoding: 'utf-8' }
    ).trim()

    if (container) {
      console.log(`\n[bridge] Port ${port} is owned by Docker container "${container}"`)
      if (isLocal) {
        console.log(`[bridge] Local mode requested — stopping "${container}" to free port...`)
        exec(`docker stop ${container} 2>/dev/null`)
        console.log(`[bridge] Container stopped. Retrying bind...\n`)
        return { action: 'retry', stopped: 'docker', target: container }
      } else {
        console.log(`[bridge] Tip: run "docker stop ${container}" first, or use --local flag to auto-stop`)
        return { action: 'monitor', stopped: null, target: container }
      }
    }
  } catch { /* docker not available or command failed — fall through */ }

  // ─── Check 2: launchd daemon ──────────────────────────────────
  try {
    const launchdCheck = exec(
      'launchctl list io.heyiris.daemon 2>/dev/null',
      { encoding: 'utf-8' }
    )

    if (launchdCheck && !launchdCheck.includes('Could not find')) {
      console.log(`\n[bridge] Port ${port} is owned by launchd agent "io.heyiris.daemon" (standalone daemon)`)
      if (isLocal) {
        console.log(`[bridge] Local mode requested — stopping launchd agent to free port...`)
        try {
          exec('launchctl bootout gui/$(id -u)/io.heyiris.daemon 2>/dev/null')
        } catch {
          // bootout may error if already stopping — try kill as fallback
          try {
            exec('launchctl kill SIGTERM gui/$(id -u)/io.heyiris.daemon 2>/dev/null')
          } catch { /* ignore */ }
        }
        console.log(`[bridge] Launchd agent stopped. Retrying bind...\n`)
        return { action: 'retry', stopped: 'launchd', target: 'io.heyiris.daemon' }
      } else {
        console.log(`[bridge] Tip: run "launchctl bootout gui/$(id -u)/io.heyiris.daemon" first, or use --local flag to auto-stop`)
        return { action: 'monitor', stopped: null, target: 'io.heyiris.daemon' }
      }
    }
  } catch { /* launchctl not available or command failed — fall through */ }

  // ─── Nothing found ────────────────────────────────────────────
  return { action: 'monitor' }
}

module.exports = { resolvePortConflict }
