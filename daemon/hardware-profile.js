/**
 * HardwareProfile — Detects machine capabilities on first install.
 *
 * Runs once during installation and caches results to ~/.iris/hardware-profile.json.
 * The hub uses this to intelligently route tasks: GPU workstations get heavy LLM
 * inference, Raspberry Pis get lightweight automation, MacBooks get general tasks.
 *
 * Re-run on demand via GET /profile endpoint.
 */

const os = require('os')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const http = require('http')

const CACHE_PATH = path.join(os.homedir(), '.iris', 'hardware-profile.json')

/**
 * Detect full hardware profile.
 * @param {Object} options
 * @param {boolean} options.forceRefresh - Skip cache and re-detect
 * @returns {Object} hardware profile
 */
async function detectProfile (options = {}) {
  // Return cached if exists and not forcing refresh
  if (!options.forceRefresh && fs.existsSync(CACHE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'))
    } catch { /* corrupted cache, re-detect */ }
  }

  const profile = {
    detected_at: new Date().toISOString(),
    os: {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      type: os.type(),
      label: `${os.platform()}-${os.arch()}`
    },
    cpu: detectCPU(),
    memory: {
      total_bytes: os.totalmem(),
      total_gb: Math.round(os.totalmem() / (1024 ** 3) * 10) / 10
    },
    disk: detectDisk(),
    gpu: detectGPU(),
    ollama: await detectOllama(),
    apple_apps: detectAppleApps(),
    node_version: process.version,
    hostname: os.hostname()
  }

  // Cache the result
  const cacheDir = path.dirname(CACHE_PATH)
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true })
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(profile, null, 2))

  return profile
}

function detectCPU () {
  const cpus = os.cpus()
  const model = cpus.length > 0 ? cpus[0].model : 'unknown'
  const cores = cpus.length

  // Detect Apple Silicon specifically
  let chipName = null
  if (os.platform() === 'darwin') {
    try {
      chipName = execSync('sysctl -n machdep.cpu.brand_string 2>/dev/null', { encoding: 'utf-8' }).trim()
    } catch { /* not available */ }
  }

  return {
    model: chipName || model,
    cores,
    speed_mhz: cpus.length > 0 ? cpus[0].speed : 0
  }
}

function detectDisk () {
  try {
    if (os.platform() === 'darwin' || os.platform() === 'linux') {
      const output = execSync('df -k / 2>/dev/null', { encoding: 'utf-8' })
      const lines = output.trim().split('\n')
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/)
        const totalKB = parseInt(parts[1], 10)
        const availKB = parseInt(parts[3], 10)
        return {
          total_gb: Math.round(totalKB / (1024 ** 2) * 10) / 10,
          available_gb: Math.round(availKB / (1024 ** 2) * 10) / 10
        }
      }
    }
  } catch { /* ignore */ }

  return { total_gb: null, available_gb: null }
}

function detectGPU () {
  const result = {
    available: false,
    type: null,
    name: null,
    vram_gb: null,
    metal_support: false
  }

  if (os.platform() === 'darwin') {
    // Check for Metal-capable GPU (Apple Silicon or discrete)
    try {
      const output = execSync('system_profiler SPDisplaysDataType 2>/dev/null', { encoding: 'utf-8' })

      // Check for Metal support
      if (/metal/i.test(output)) {
        result.metal_support = true
        result.available = true
        result.type = 'metal'
      }

      // Extract chipset/GPU name
      const chipMatch = output.match(/Chipset Model:\s*(.+)/i)
      if (chipMatch) {
        result.name = chipMatch[1].trim()
      }

      // Apple Silicon uses unified memory — report total RAM as "VRAM"
      if (/apple/i.test(result.name || '')) {
        result.vram_gb = Math.round(os.totalmem() / (1024 ** 3) * 10) / 10
      }
    } catch { /* system_profiler not available */ }
  } else if (os.platform() === 'linux') {
    // Check for NVIDIA GPU
    try {
      const output = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null', { encoding: 'utf-8' })
      if (output.trim()) {
        const parts = output.trim().split(',')
        result.available = true
        result.type = 'nvidia'
        result.name = parts[0]?.trim()
        const vramMatch = parts[1]?.trim().match(/(\d+)/)
        if (vramMatch) {
          result.vram_gb = Math.round(parseInt(vramMatch[1], 10) / 1024 * 10) / 10
        }
      }
    } catch { /* nvidia-smi not available */ }
  }

  return result
}

/**
 * Check if Ollama is running and what models are available.
 */
function detectOllama () {
  return new Promise((resolve) => {
    const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434'
    const url = new URL('/api/tags', ollamaHost)

    const req = http.request({
      hostname: url.hostname,
      port: url.port || 11434,
      path: url.pathname,
      method: 'GET',
      timeout: 3000
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          const models = (parsed.models || []).map(m => ({
            name: m.name,
            size_gb: m.size ? Math.round(m.size / (1024 ** 3) * 10) / 10 : null,
            family: m.details?.family || null
          }))
          resolve({
            available: true,
            host: ollamaHost,
            model_count: models.length,
            models
          })
        } catch {
          resolve({ available: true, host: ollamaHost, model_count: 0, models: [] })
        }
      })
    })

    req.on('error', () => {
      resolve({ available: false, host: ollamaHost, model_count: 0, models: [] })
    })

    req.on('timeout', () => {
      req.destroy()
      resolve({ available: false, host: ollamaHost, model_count: 0, models: [] })
    })

    req.end()
  })
}

/**
 * Detect macOS-specific app availability for outreach capabilities.
 * Returns platform info + presence of Mail.app, Messages.app, and chat.db.
 * Only meaningful on darwin; returns safe defaults on other platforms.
 */
function detectAppleApps () {
  if (os.platform() !== 'darwin') {
    return {
      platform: os.platform(),
      imessage: false,
      apple_mail: false,
      chat_db: null
    }
  }

  const chatDbPath = path.join(os.homedir(), 'Library', 'Messages', 'chat.db')
  const mailAppPath = '/Applications/Mail.app'
  const messagesAppPath = '/Applications/Messages.app'

  return {
    platform: 'darwin',
    imessage: fs.existsSync(chatDbPath),
    apple_mail: fs.existsSync(mailAppPath),
    messages_app: fs.existsSync(messagesAppPath),
    chat_db: fs.existsSync(chatDbPath) ? chatDbPath : null
  }
}

/**
 * Get cached profile or detect fresh.
 */
function getCachedProfile () {
  if (fs.existsSync(CACHE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'))
    } catch { /* corrupted */ }
  }
  return null
}

module.exports = { detectProfile, getCachedProfile, detectAppleApps, CACHE_PATH }
