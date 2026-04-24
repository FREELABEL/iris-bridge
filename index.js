const express = require('express')
const { spawn } = require('child_process')
const { randomUUID } = require('crypto')
const fs = require('fs')
const path = require('path')

// Load .env from ~/.iris/bridge/.env if it exists
const BRIDGE_ENV_DIR = path.join(process.env.HOME, '.iris', 'bridge')
const BRIDGE_ENV_FILE = path.join(BRIDGE_ENV_DIR, '.env')
try {
  require('dotenv').config({ path: BRIDGE_ENV_FILE })
} catch { /* dotenv or file missing — fine */ }

const app = express()
app.use(express.json({ limit: '10mb' }))

// CORS — allowlist of known origins (security: never use wildcard *)
const CORS_ALLOWLIST = new Set([
  'http://localhost:3200',
  'http://localhost:9300',
  'http://127.0.0.1:3200',
  'http://127.0.0.1:9300',
  'https://freelabel.net',
  'https://web.freelabel.net',
  'https://heyiris.io',
  'https://web.heyiris.io',
  'https://app.heyiris.io',
  ...(process.env.BRIDGE_CORS_ORIGINS || '').split(',').filter(Boolean)
])
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && CORS_ALLOWLIST.has(origin)) {
    res.header('Access-Control-Allow-Origin', origin)
    res.header('Vary', 'Origin')
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Bridge-Key, X-Mesh-Key')
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

const PORT = process.env.BRIDGE_PORT || 3200

// ─── Auth — protect mutating endpoints with auto-generated token ───
const { bridgeAuth, getToken, TOKEN_PATH } = require('./lib/bridge-auth')
app.use(bridgeAuth({
  openPaths: new Set([
    '/health',
    '/.well-known/security.txt',
    '/api/config',
    '/api/environment',
    '/api/discover',
    '/api/ollama/models',
    '/daemon/health',
    '/daemon/capacity',
    '/daemon/profile',
    '/daemon/queue'
  ]),
  openPrefixes: [
    '/daemon/mesh/' // mesh routes use their own X-Mesh-Key auth
  ]
}))

// Full paths to CLIs (avoids PATH issues in subprocess)
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/opt/homebrew/bin/claude'
const OPENCODE_BIN = process.env.OPENCODE_BIN || '/opt/homebrew/bin/opencode'
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434'
const IRIS_API_URL = process.env.IRIS_API_URL || 'https://web.heyiris.io'
const BRIDGE_VERSION = require('./package.json').version

// ─── Messaging Bot State ────────────────────────────────────────

let telegramBot = null
let telegramBotUsername = null
const discordBots = new Map() // token → { client, bloqId, botUsername, apiBaseUrl }

// ─── Embedded Daemon State ──────────────────────────────────────

let embeddedDaemon = null

// ─── iMessage Channel (OpenClaw pattern) ────────────────────────

const IMessageChannel = require('./channels/imessage')
let iMessageChannel = null

// ─── Helpers ──────────────────────────────────────────────────────

function runCLI (cmd, args, { timeoutMs = 120000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    console.log(`[exec] ${cmd} ${args.join(' ')} (cwd: ${cwd || '~'})`)
    const proc = spawn(cmd, args, {
      cwd: cwd || process.env.HOME,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', PATH: process.env.PATH }
    })

    let stdout = ''
    let stderr = ''
    let killed = false

    const timer = setTimeout(() => {
      killed = true
      proc.kill('SIGTERM')
      reject(new Error(`${cmd} timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)

    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (killed) return
      if (code !== 0) {
        reject(new Error(`${cmd} exited ${code}: ${(stderr || stdout).slice(0, 500)}`))
      } else {
        resolve(stdout)
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function tryJSON (str) {
  try { return JSON.parse(str) } catch { return null }
}

/**
 * Read/write the bridge .env file for persisting messaging bot tokens.
 */
function readBridgeEnv () {
  try {
    if (!fs.existsSync(BRIDGE_ENV_FILE)) return {}
    const lines = fs.readFileSync(BRIDGE_ENV_FILE, 'utf8').split('\n')
    const env = {}
    for (const line of lines) {
      const match = line.match(/^([^#=]+)=(.*)$/)
      if (match) env[match[1].trim()] = match[2].trim()
    }
    return env
  } catch { return {} }
}

function writeBridgeEnv (env) {
  try {
    fs.mkdirSync(BRIDGE_ENV_DIR, { recursive: true })
    const content = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
    fs.writeFileSync(BRIDGE_ENV_FILE, content, 'utf8')
  } catch (err) {
    console.error(`[bridge-env] Failed to write .env: ${err.message}`)
  }
}

// ─── Telegram Bot Logic ─────────────────────────────────────────

async function startTelegram (token, apiBaseUrl) {
  if (telegramBot) {
    try { telegramBot.stopPolling() } catch { /* ignore */ }
    telegramBot = null
    telegramBotUsername = null
  }

  const TelegramBot = require('node-telegram-bot-api')
  const bot = new TelegramBot(token, { polling: true })
  const baseUrl = apiBaseUrl || 'http://localhost:8000'

  // Get bot info to validate token
  const me = await bot.getMe()
  bot.options.username = me.username
  telegramBotUsername = me.username

  console.log(`[telegram] Connected as @${me.username}`)

  bot.on('message', async (message) => {
    if (!message.text) return
    if (message.text.startsWith('/start') || message.text.startsWith('/help')) {
      await bot.sendMessage(message.chat.id, 'IRIS AI assistant is ready. Send me a message!', { parse_mode: 'Markdown' })
      return
    }

    const chatType = message.chat.type
    // In groups, only respond if bot is mentioned or replied to
    if (chatType === 'group' || chatType === 'supergroup') {
      let shouldProcess = false
      if (message.entities) {
        for (const entity of message.entities) {
          if (entity.type === 'mention') {
            const mention = message.text.substring(entity.offset, entity.offset + entity.length)
            if (me.username && mention.toLowerCase() === `@${me.username.toLowerCase()}`) {
              shouldProcess = true
            }
          }
        }
      }
      if (message.reply_to_message && message.reply_to_message.from?.is_bot) {
        shouldProcess = true
      }
      if (!shouldProcess) return
    }

    // Show typing
    try { await bot.sendChatAction(message.chat.id, 'typing') } catch { /* ignore */ }

    // Forward to IRIS API
    const payload = {
      update_id: Date.now(),
      message: {
        message_id: message.message_id,
        from: {
          id: message.from.id,
          is_bot: message.from.is_bot || false,
          first_name: message.from.first_name,
          last_name: message.from.last_name,
          username: message.from.username,
          language_code: message.from.language_code
        },
        chat: {
          id: message.chat.id,
          type: chatType,
          title: message.chat.title,
          username: message.chat.username,
          first_name: message.chat.first_name,
          last_name: message.chat.last_name
        },
        date: message.date,
        text: message.text
      }
    }

    try {
      const resp = await fetch(`${baseUrl}/api/v6/channels/telegram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await resp.json()
      if (data.ok && data.response) {
        const text = data.response
        if (text.length > 4096) {
          const chunks = text.match(/.{1,4096}/gs) || [text]
          for (let i = 0; i < chunks.length; i++) {
            await bot.sendMessage(message.chat.id, chunks[i], i === 0 ? { parse_mode: 'Markdown', reply_to_message_id: message.message_id } : { parse_mode: 'Markdown' })
          }
        } else {
          await bot.sendMessage(message.chat.id, text, { parse_mode: 'Markdown', reply_to_message_id: message.message_id })
        }
      }
    } catch (err) {
      console.error(`[telegram] Forward error: ${err.message}`)
      if (chatType === 'private') {
        try { await bot.sendMessage(message.chat.id, 'Sorry, having trouble connecting right now.') } catch { /* ignore */ }
      }
    }
  })

  bot.on('polling_error', (err) => console.error(`[telegram] Polling error: ${err.message}`))

  telegramBot = bot
  return me.username
}

function stopTelegram () {
  if (telegramBot) {
    try { telegramBot.stopPolling() } catch { /* ignore */ }
    telegramBot = null
    telegramBotUsername = null
    console.log('[telegram] Stopped')
  }
}

// ─── Discord Bot Logic (Multi-Bot) ──────────────────────────────

async function startDiscordBot (token, bloqId, apiBaseUrl) {
  // If this token already has a running bot, destroy it first
  const existing = discordBots.get(token)
  if (existing) {
    try { existing.client.destroy() } catch { /* ignore */ }
    discordBots.delete(token)
  }

  const { Client, GatewayIntentBits, Partials } = require('discord.js')
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel, Partials.Message]
  })

  const baseUrl = apiBaseUrl || 'http://localhost:8000'

  // Login and wait for ready
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Discord login timed out')), 30000)
    client.once('ready', () => {
      clearTimeout(timeout)
      resolve()
    })
    client.login(token).catch((err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })

  const botUsername = client.user.tag
  console.log(`[discord] Connected as ${botUsername}${bloqId ? ` (bloq ${bloqId})` : ''}`)

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return
    const isDM = !message.guild
    const botMentioned = message.mentions.has(client.user)
    if (!isDM && !botMentioned) return

    const payload = {
      t: 'MESSAGE_CREATE',
      bloq_id: bloqId || null,
      d: {
        id: message.id,
        content: message.content,
        channel_id: message.channelId,
        guild_id: message.guildId || null,
        author: {
          id: message.author.id,
          username: message.author.username,
          bot: message.author.bot
        }
      }
    }

    try {
      const resp = await fetch(`${baseUrl}/api/v6/channels/discord`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await resp.json()
      if (data.ok && data.response) {
        await message.reply(data.response.slice(0, 2000))
      }
    } catch (err) {
      console.error(`[discord] Forward error (bloq ${bloqId}): ${err.message}`)
    }
  })

  client.on('error', (err) => console.error(`[discord] Client error (${botUsername}): ${err.message}`))

  discordBots.set(token, { client, bloqId, botUsername, apiBaseUrl: baseUrl })
  return botUsername
}

// Backward compat wrapper — starts a bot without bloq association
async function startDiscord (token, apiBaseUrl) {
  return startDiscordBot(token, null, apiBaseUrl)
}

function stopDiscordBot (token) {
  const entry = discordBots.get(token)
  if (entry) {
    try { entry.client.destroy() } catch { /* ignore */ }
    discordBots.delete(token)
    console.log(`[discord] Stopped ${entry.botUsername}${entry.bloqId ? ` (bloq ${entry.bloqId})` : ''}`)
    return true
  }
  return false
}

function stopDiscordByBloqId (bloqId) {
  for (const [token, entry] of discordBots) {
    if (entry.bloqId === bloqId) {
      stopDiscordBot(token)
      return true
    }
  }
  return false
}

function stopAllDiscordBots () {
  for (const [token] of discordBots) {
    stopDiscordBot(token)
  }
}

// ─── OBS Studio (WebSocket Control) ──────────────────────────────

const OBSChannel = require('./channels/obs')
let obsChannel = null

app.post('/api/providers/obs', async (req, res) => {
  const { ws_url, password } = req.body
  try {
    if (obsChannel) await obsChannel.stop()
    obsChannel = new OBSChannel({ wsUrl: ws_url || 'ws://localhost:4455', password: password || undefined })
    await obsChannel.start()
    res.json({ status: 'running', host: obsChannel.config.wsUrl })
  } catch (err) {
    console.error('[obs] Start failed:', err.message)
    res.status(400).json({ error: err.message })
  }
})

app.delete('/api/providers/obs', async (req, res) => {
  if (obsChannel) { await obsChannel.stop(); obsChannel = null }
  res.json({ ok: true })
})

app.get('/api/obs/scenes', async (req, res) => {
  if (!obsChannel?.isRunning) return res.status(503).json({ error: 'OBS not connected. POST /api/providers/obs to connect.' })
  try { res.json(await obsChannel.getScenes()) } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/obs/scene', async (req, res) => {
  if (!obsChannel?.isRunning) return res.status(503).json({ error: 'OBS not connected' })
  const { scene_name } = req.body
  if (!scene_name) return res.status(400).json({ error: 'scene_name required' })
  try { res.json(await obsChannel.setScene(scene_name)) } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/obs/stream/start', async (req, res) => {
  if (!obsChannel?.isRunning) return res.status(503).json({ error: 'OBS not connected' })
  try { res.json(await obsChannel.startStream()) } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/obs/stream/stop', async (req, res) => {
  if (!obsChannel?.isRunning) return res.status(503).json({ error: 'OBS not connected' })
  try { res.json(await obsChannel.stopStream()) } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/obs/stream/status', async (req, res) => {
  if (!obsChannel?.isRunning) return res.status(503).json({ error: 'OBS not connected' })
  try { res.json(await obsChannel.getStreamStatus()) } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/obs/record/start', async (req, res) => {
  if (!obsChannel?.isRunning) return res.status(503).json({ error: 'OBS not connected' })
  try { res.json(await obsChannel.startRecord()) } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/obs/record/stop', async (req, res) => {
  if (!obsChannel?.isRunning) return res.status(503).json({ error: 'OBS not connected' })
  try { res.json(await obsChannel.stopRecord()) } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/obs/record/status', async (req, res) => {
  if (!obsChannel?.isRunning) return res.status(503).json({ error: 'OBS not connected' })
  try { res.json(await obsChannel.getRecordStatus()) } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/obs/marker', async (req, res) => {
  if (!obsChannel?.isRunning) return res.status(503).json({ error: 'OBS not connected' })
  try { res.json(await obsChannel.createMarker(req.body.description)) } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/obs/audio/mute', async (req, res) => {
  if (!obsChannel?.isRunning) return res.status(503).json({ error: 'OBS not connected' })
  const { input, muted } = req.body
  if (!input) return res.status(400).json({ error: 'input name required' })
  try { res.json(await obsChannel.setInputMute(input, muted !== false)) } catch (e) { res.status(400).json({ error: e.message }) }
})

app.get('/api/obs/inputs', async (req, res) => {
  if (!obsChannel?.isRunning) return res.status(503).json({ error: 'OBS not connected' })
  try { res.json(await obsChannel.getInputList()) } catch (e) { res.status(500).json({ error: e.message }) }
})

// ─── OBS Dashboard (browser-based scene controller) ──────────────

app.get('/obs-dashboard', async (req, res) => {
  // Fetch live scenes from OBS if connected
  let scenes = []
  let current = ''
  let streamActive = false
  let recordActive = false
  if (obsChannel?.isRunning) {
    try {
      const s = await obsChannel.getScenes()
      scenes = s.scenes || []
      current = s.current || ''
    } catch {}
    try { const st = await obsChannel.getStreamStatus(); streamActive = st.active } catch {}
    try { const rc = await obsChannel.getRecordStatus(); recordActive = rc.active } catch {}
  }

  // Load event timeline from local JSON
  let eventData = null
  try {
    const fs = require('fs')
    const path = require('path')
    const home = process.env.HOME || ''
    const eventsDir = path.join(home, '.iris', 'events')
    // Find event files, prefer the one from query param or most recent
    const eventId = req.query.event || '1343'
    const files = fs.readdirSync(eventsDir).filter(f => f.startsWith(eventId + '-') && f.endsWith('.json'))
    if (files.length > 0) {
      eventData = JSON.parse(fs.readFileSync(path.join(eventsDir, files[0]), 'utf8'))
    }
  } catch {}

  // Build merged timeline — one entry per time block, Performance Stage takes priority
  const timeline = []
  if (eventData) {
    const stages = eventData.stages || eventData.event_stages || []
    // Group set times by time slot, prioritize Performance > Host > Judges
    const stagePriority = { 'Performance Stage': 1, 'Host Stage': 2, 'Judges Stage': 3 }
    const timeSlots = new Map() // key: start_time, value: best entry

    for (const stage of stages) {
      const setTimes = stage.set_times || stage.event_stage_set_times || []
      for (const st of setTimes) {
        const key = st.start_time || ''
        const priority = stagePriority[stage.title] || 99
        const existing = timeSlots.get(key)
        if (!existing || priority < existing._priority) {
          timeSlots.set(key, {
            time: st.start_time || '',
            end: st.end_time || '',
            title: st.title || st.name || '',
            stage: stage.title || '',
            description: st.description || '',
            _priority: priority,
          })
        }
      }
    }

    // Add show entries from merged set times
    for (const entry of timeSlots.values()) {
      delete entry._priority
      timeline.push(entry)
    }

    // Add production timeline
    const prodTimeline = (eventData.metadata || {}).production_timeline || []
    for (const pt of prodTimeline) {
      timeline.push({ time: pt.time, title: pt.task, stage: 'Production', description: '', isProd: true })
    }
    timeline.sort((a, b) => (a.time || '').localeCompare(b.time || ''))
  }

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>${eventData?.title || 'Stream Control'} — FreeLabel</title>
<link rel="icon" href="https://iris-cdn.sfo3.cdn.digitaloceanspaces.com/assets/freelabel/favicon.png">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a0a; color: #fff; font-family: -apple-system, system-ui, sans-serif; padding: 12px; min-height: 100vh; }
  h1 { font-size: 16px; text-align: center; margin-bottom: 4px; color: #eab308; }
  .subtitle { text-align: center; font-size: 12px; color: #666; margin-bottom: 12px; }
  .status-bar { display: flex; justify-content: center; gap: 16px; margin-bottom: 12px; font-size: 12px; color: #666; }
  .status-bar .live { color: #ef4444; font-weight: 700; }
  .status-bar .ready { color: #22c55e; }
  .current { text-align: center; font-size: 13px; color: #eab308; margin-bottom: 12px; font-weight: 600; }
  .tabs { display: flex; gap: 0; margin-bottom: 12px; border-bottom: 1px solid #222; }
  .tab { flex: 1; padding: 10px; text-align: center; font-size: 12px; font-weight: 600; color: #666; cursor: pointer; border-bottom: 2px solid transparent; }
  .tab.active { color: #eab308; border-bottom-color: #eab308; }
  .panel { display: none; }
  .panel.active { display: block; }
  .section-label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #555; margin: 12px 0 6px; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-bottom: 10px; }
  .grid-3 { grid-template-columns: repeat(3, 1fr); }
  .btn {
    background: #1a1a1a; border: 1px solid #333; border-radius: 10px;
    color: #fff; padding: 14px 8px; font-size: 12px; font-weight: 600;
    cursor: pointer; transition: all 0.15s; text-align: center;
    -webkit-tap-highlight-color: transparent;
  }
  .btn:active { background: #333; transform: scale(0.97); }
  .btn.active { border-color: #eab308; background: #1a1800; color: #eab308; }
  .btn.cam { background: #0a1628; border-color: #1e3a5f; }
  .btn.cam.active { background: #0a2040; border-color: #3b82f6; color: #60a5fa; }
  .btn.sm { padding: 10px 6px; font-size: 11px; }
  .btn.danger { border-color: #7f1d1d; color: #ef4444; }
  .btn.success { border-color: #14532d; color: #22c55e; }
  .msg { text-align: center; font-size: 11px; color: #555; margin-top: 4px; min-height: 16px; }
  .msg.ok { color: #22c55e; }
  .msg.err { color: #ef4444; }
  /* Timeline */
  .tl-item { display: flex; gap: 10px; padding: 10px; border-left: 3px solid #222; margin-left: 4px; margin-bottom: 2px; transition: all 0.3s; }
  .tl-item.now { border-left-color: #eab308; background: #1a1800; border-radius: 0 8px 8px 0; }
  .tl-item.past { opacity: 0.4; }
  .tl-item.prod { border-left-color: #333; }
  .tl-item.prod.past { opacity: 0.25; }
  .tl-time { font-size: 12px; font-weight: 700; color: #888; min-width: 50px; }
  .tl-item.now .tl-time { color: #eab308; }
  .tl-content { flex: 1; }
  .tl-title { font-size: 13px; font-weight: 600; }
  .tl-stage { font-size: 10px; color: #666; margin-top: 2px; }
  .tl-desc { font-size: 11px; color: #555; margin-top: 3px; }
  .tl-now-label { font-size: 9px; color: #eab308; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
  .tl-next-label { font-size: 9px; color: #60a5fa; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
  .tl-item.next { border-left-color: #3b82f6; background: #0a1628; border-radius: 0 8px 8px 0; }
  .clock { text-align: center; font-size: 28px; font-weight: 700; color: #fff; margin-bottom: 4px; font-variant-numeric: tabular-nums; }
</style>
</head><body>

<div style="text-align:center;margin-bottom:8px"><img src="https://iris-cdn.sfo3.cdn.digitaloceanspaces.com/assets/freelabel/fl-logo-white.png" alt="FreeLabel" style="height:28px;opacity:0.85" onerror="this.style.display='none'"><span style="display:block;font-size:10px;color:#555;letter-spacing:2px;margin-top:2px">STREAM CONTROL</span></div>
<h1>${eventData?.title || 'OBS Controller'}</h1>
<div class="subtitle">${eventData?.venue_name || ''} · ${eventData?.start_date || ''} · ${eventData?.start_time || ''}–${eventData?.end_time || ''}</div>

<div class="clock" id="clock"></div>

<div class="status-bar">
  <span>Stream: <span id="stream-status" class="${streamActive ? 'live' : 'ready'}">${streamActive ? '● LIVE' : 'Ready'}</span></span>
  <span>Rec: <span id="record-status" class="${recordActive ? 'live' : 'ready'}">${recordActive ? '● REC' : 'Ready'}</span></span>
  <span>Scene: <span id="current-scene" style="color:#eab308">${current || '—'}</span></span>
</div>

<div class="tabs">
  <div class="tab active" onclick="showPanel('cameras')">Cameras</div>
  <div class="tab" onclick="showPanel('timeline')">Timeline</div>
  <div class="tab" onclick="showPanel('controls')">Controls</div>
</div>

<!-- Cameras Panel -->
<div class="panel active" id="panel-cameras">
  <div class="section-label">Quick Switch</div>
  <div class="grid grid-3" id="cam-grid"></div>
  <div class="section-label">All Scenes</div>
  <div class="grid" id="scene-grid"></div>
</div>

<!-- Timeline Panel -->
<div class="panel" id="panel-timeline">
  <div id="timeline-list"></div>
</div>

<!-- Controls Panel -->
<div class="panel" id="panel-controls">
  <div class="section-label">Stream</div>
  <div class="grid grid-3">
    <button class="btn success sm" onclick="streamAction('start')">▶ Go Live</button>
    <button class="btn danger sm" onclick="streamAction('stop')">■ End Stream</button>
    <button class="btn sm" onclick="streamStatus()">📊 Status</button>
  </div>
  <div class="section-label">Recording</div>
  <div class="grid grid-3">
    <button class="btn success sm" onclick="recordAction('start')">⏺ Start</button>
    <button class="btn danger sm" onclick="recordAction('stop')">■ Stop</button>
    <button class="btn sm" onclick="recordStatus()">📊 Status</button>
  </div>
  <div class="section-label">Production</div>
  <div class="grid grid-3">
    <button class="btn sm" onclick="doMarker()">📌 Marker</button>
    <button class="btn sm" onclick="switchScene('BE RIGHT BACK')">☕ BRB</button>
    <button class="btn sm" onclick="switchScene('INTRO')">🎬 Intro</button>
  </div>
</div>

<div class="msg" id="msg"></div>

<script>
const API = 'http://' + location.hostname + ':3200';
const scenes = ${JSON.stringify(scenes.map(s => s.name))};
const timeline = ${JSON.stringify(timeline)};
let currentScene = '${current}';

// Clock
function updateClock() {
  const now = new Date();
  document.getElementById('clock').textContent = now.toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true});
  updateTimeline();
}
setInterval(updateClock, 1000);
updateClock();

// Tabs
function showPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  event.target.classList.add('active');
}

// Messages
function msg(text, type) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = 'msg ' + (type || '');
  if (type === 'ok') setTimeout(() => { el.textContent = ''; }, 2000);
}

// OBS Controls
async function switchScene(name) {
  try {
    msg('Switching...', '');
    await fetch(API + '/api/obs/scene', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({scene_name: name}) });
    currentScene = name;
    document.getElementById('current-scene').textContent = name;
    updateButtons();
    msg('✓ ' + name, 'ok');
  } catch(e) { msg('Failed: ' + e.message, 'err'); }
}

async function streamAction(action) {
  try {
    msg(action === 'start' ? 'Going live...' : 'Stopping...', '');
    await fetch(API + '/api/obs/stream/' + action, { method: 'POST' });
    const s = document.getElementById('stream-status');
    if (action === 'start') { s.textContent = '● LIVE'; s.className = 'live'; }
    else { s.textContent = 'Ready'; s.className = 'ready'; }
    msg('✓ Stream ' + action + 'ed', 'ok');
  } catch(e) { msg('Failed: ' + e.message, 'err'); }
}

async function streamStatus() {
  try {
    const r = await fetch(API + '/api/obs/stream/status').then(r=>r.json());
    msg(r.active ? 'LIVE ' + (r.timecode||'') + ' | ' + Math.round((r.bytes||0)/1024/1024) + 'MB' : 'Not streaming', r.active ? 'ok' : '');
  } catch(e) { msg('Cannot reach OBS', 'err'); }
}

async function recordAction(action) {
  try {
    await fetch(API + '/api/obs/record/' + action, { method: 'POST' });
    const s = document.getElementById('record-status');
    if (action === 'start') { s.textContent = '● REC'; s.className = 'live'; msg('✓ Recording', 'ok'); }
    else { s.textContent = 'Ready'; s.className = 'ready'; msg('✓ Stopped', 'ok'); }
  } catch(e) { msg('Failed', 'err'); }
}

async function recordStatus() {
  try {
    const r = await fetch(API + '/api/obs/record/status').then(r=>r.json());
    msg(r.active ? 'REC ' + (r.timecode||'') : 'Not recording', r.active ? 'ok' : '');
  } catch(e) { msg('Cannot reach OBS', 'err'); }
}

async function doMarker() {
  try {
    await fetch(API + '/api/obs/marker', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({description: 'Marker @ ' + new Date().toLocaleTimeString()}) });
    msg('✓ Marker set', 'ok');
  } catch(e) { msg('Failed', 'err'); }
}

function updateButtons() {
  document.querySelectorAll('[data-scene]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.scene === currentScene);
  });
}

// Build camera + scene buttons
const camGrid = document.getElementById('cam-grid');
const sceneGrid = document.getElementById('scene-grid');
const camPatterns = ['cam 1', 'cam 2', 'cam 3', 'eagle', 'webcam solo', 'webcam +'];
scenes.forEach(name => {
  const isCam = camPatterns.some(p => name.toLowerCase().includes(p));
  const btn = document.createElement('button');
  btn.className = 'btn sm' + (isCam ? ' cam' : '') + (name === currentScene ? ' active' : '');
  btn.dataset.scene = name;
  btn.textContent = name;
  btn.onclick = () => switchScene(name);
  (isCam ? camGrid : sceneGrid).appendChild(btn);
});

// Convert 24h "HH:MM" to "H:MM AM/PM"
function to12h(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
}

// Build timeline
function updateTimeline() {
  const list = document.getElementById('timeline-list');
  const now = new Date();
  const nowTime = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');

  // Find the last item that has started (its time <= now)
  let nowIndex = -1;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].time <= nowTime) { nowIndex = i; break; }
  }

  let html = '';
  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    const isPast = i < nowIndex;
    const isNow = i === nowIndex;
    const cls = item.isProd ? 'tl-item prod' : 'tl-item';
    const isNext = i === nowIndex + 1;
    const state = isNow ? ' now' : isNext ? ' next' : isPast ? ' past' : '';

    html += '<div class="' + cls + state + '" id="tl-' + i + '">';
    html += '<div class="tl-time">' + to12h(item.time) + '</div>';
    html += '<div class="tl-content">';
    if (isNow) html += '<div class="tl-now-label">● NOW</div>';
    if (i === nowIndex + 1) html += '<div class="tl-next-label">▸ NEXT</div>';
    html += '<div class="tl-title">' + (item.title || '') + '</div>';
    if (item.stage && !item.isProd) html += '<div class="tl-stage">' + item.stage + (item.end ? ' · until ' + to12h(item.end) : '') + '</div>';
    if (item.description && !item.isProd) html += '<div class="tl-desc">' + item.description + '</div>';
    html += '</div></div>';
  }
  list.innerHTML = html;

  // Auto-scroll to NOW item
  const nowEl = document.getElementById('tl-' + nowIndex);
  if (nowEl) nowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
updateTimeline();

// Poll OBS status every 5s
setInterval(async () => {
  try {
    const r = await fetch(API + '/api/obs/scenes');
    const d = await r.json();
    if (d.current && d.current !== currentScene) {
      currentScene = d.current;
      document.getElementById('current-scene').textContent = currentScene;
      updateButtons();
    }
  } catch {}
}, 5000);
</script>
</body></html>`;

  res.type('html').send(html)
})

// ─── Security disclosure ─────────────────────────────────────────

app.get('/.well-known/security.txt', (req, res) => {
  res.type('text/plain').send([
    'Contact: mailto:security@freelabel.net',
    'Preferred-Languages: en',
    `Expires: ${new Date(Date.now() + 365 * 86400000).toISOString()}`
  ].join('\n'))
})

// ─── Health ───────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  // Check Ollama availability
  let ollamaStatus = 'stopped'
  let ollamaModels = 0
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (r.ok) {
      ollamaStatus = 'running'
      const d = await r.json()
      ollamaModels = (d.models || []).length
    }
  } catch { /* not available */ }

  res.json({
    status: 'ok',
    providers: ['claude_code', 'opencode', 'ollama'],
    ollama: { status: ollamaStatus, host: OLLAMA_HOST, sessions: ollamaSessions.size, models: ollamaModels },
    daemon: embeddedDaemon
      ? { status: 'running', node_id: embeddedDaemon.nodeId, node_name: embeddedDaemon.nodeName }
      : { status: 'stopped' },
    node_id: embeddedDaemon?.nodeId || null,
    messaging: {
      telegram: telegramBot
        ? { status: 'running', username: telegramBotUsername }
        : { status: 'stopped' },
      discord: discordBots.size > 0
        ? {
            status: 'running',
            bots: Array.from(discordBots.values()).map(b => ({
              username: b.botUsername,
              bloq_id: b.bloqId,
              ready: b.client?.isReady() || false
            }))
          }
        : { status: 'stopped' },
      imessage: iMessageChannel
        ? iMessageChannel.getStatus()
        : { status: 'stopped' },
      obs: obsChannel
        ? obsChannel.getStatus()
        : { status: 'stopped' }
    }
  })
})

// ─── Config / Version ───────────────────────────────────────────

app.get('/api/config', (req, res) => {
  // Read current config to include daemon key info
  let daemonConfig = {}
  try {
    const configPath = path.join(process.env.HOME, '.iris', 'config.json')
    if (fs.existsSync(configPath)) {
      daemonConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    }
  } catch { /* fine */ }

  res.json({
    version: BRIDGE_VERSION,
    iris_api_url: IRIS_API_URL,
    ollama_host: OLLAMA_HOST,
    container: fs.existsSync('/.dockerenv'),
    has_api_key: !!(daemonConfig.node_api_key || daemonConfig.local_api_key),
    local_mode: process.env.IRIS_LOCAL === '1'
  })
})

// ─── Sync API Key from UI ───────────────────────────────────────

app.post('/api/config/key', (req, res) => {
  const { api_key, mode } = req.body
  if (!api_key || !api_key.startsWith('node_live_')) {
    return res.status(400).json({ error: 'Invalid API key format' })
  }

  const configPath = path.join(process.env.HOME, '.iris', 'config.json')
  let config = {}
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    }
  } catch { /* fresh config */ }

  // Update the appropriate key based on mode
  const keyField = mode === 'local' ? 'local_api_key' : 'node_api_key'
  config[keyField] = api_key
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

  console.log(`[config] API key updated (${keyField}) — restart bridge to apply`)
  res.json({ ok: true, field: keyField, message: 'Key saved. Restart bridge to apply.' })
})

// ─── Environment Detection ──────────────────────────────────────

app.get('/api/environment', (req, res) => {
  const home = process.env.HOME
  const components = {
    cli: {
      name: 'IRIS CLI',
      installed: fs.existsSync(path.join(home, '.iris', 'bin', 'iris')),
      path: path.join(home, '.iris', 'bin', 'iris')
    },
    sdk: {
      name: 'IRIS SDK',
      installed: fs.existsSync(path.join(home, '.iris', 'sdk', 'package.json')),
      path: path.join(home, '.iris', 'sdk')
    },
    desktop: {
      name: 'Desktop App',
      installed: fs.existsSync('/Applications/IRIS.app') ||
                 fs.existsSync(path.join(home, 'Applications', 'IRIS.app')),
      path: '/Applications/IRIS.app'
    },
    bridge: {
      name: 'Agent Bridge',
      installed: true,
      version: require('./package.json').version
    }
  }
  res.json({ components })
})

// ─── Messaging Provider Management ──────────────────────────────

app.post('/api/providers/telegram', async (req, res) => {
  const { token, api_base_url } = req.body
  if (!token) return res.status(400).json({ error: 'token is required' })

  try {
    const username = await startTelegram(token, api_base_url)

    // Persist to .env
    const env = readBridgeEnv()
    env.TELEGRAM_BOT_TOKEN = token
    if (api_base_url) env.TELEGRAM_API_BASE_URL = api_base_url
    writeBridgeEnv(env)

    res.json({ status: 'running', bot_username: username })
  } catch (err) {
    stopTelegram()
    console.error(`[telegram] Start failed: ${err.message}`)
    res.status(400).json({ error: `Failed to start Telegram bot: ${err.message}` })
  }
})

app.delete('/api/providers/telegram', (req, res) => {
  stopTelegram()

  // Remove from .env
  const env = readBridgeEnv()
  delete env.TELEGRAM_BOT_TOKEN
  delete env.TELEGRAM_API_BASE_URL
  writeBridgeEnv(env)

  res.json({ status: 'stopped' })
})

app.post('/api/providers/discord', async (req, res) => {
  const { token, api_base_url, bloq_id } = req.body
  if (!token) return res.status(400).json({ error: 'token is required' })

  try {
    const username = await startDiscordBot(token, bloq_id || null, api_base_url)

    // Persist legacy token to .env (only when no bloq_id — bloq bots are fetched from API)
    if (!bloq_id) {
      const env = readBridgeEnv()
      env.DISCORD_BOT_TOKEN = token
      if (api_base_url) env.DISCORD_API_BASE_URL = api_base_url
      writeBridgeEnv(env)
    }

    res.json({ status: 'running', bot_username: username, bloq_id: bloq_id || null })
  } catch (err) {
    if (token) stopDiscordBot(token)
    console.error(`[discord] Start failed: ${err.message}`)
    res.status(400).json({ error: `Failed to start Discord bot: ${err.message}` })
  }
})

app.delete('/api/providers/discord', (req, res) => {
  const { token, bloq_id } = req.body || {}

  if (bloq_id) {
    stopDiscordByBloqId(bloq_id)
  } else if (token) {
    stopDiscordBot(token)
  } else {
    // Legacy: stop all and clear env
    stopAllDiscordBots()
  }

  // Remove legacy token from .env only when no specific target
  if (!bloq_id && !token) {
    const env = readBridgeEnv()
    delete env.DISCORD_BOT_TOKEN
    delete env.DISCORD_API_BASE_URL
    writeBridgeEnv(env)
  }

  res.json({ status: 'stopped' })
})

// ─── iMessage Provider (BlueBubbles) ─────────────────────────────

app.post('/api/providers/imessage', async (req, res) => {
  const { driver, bluebubbles_url, bluebubbles_password, poll_interval, chat_db_path, api_base_url, dm_policy, group_policy, allowlist } = req.body

  const driverType = driver || 'bluebubbles'

  // Validate per driver
  if (driverType === 'bluebubbles') {
    if (!bluebubbles_url || !bluebubbles_password) {
      return res.status(400).json({ error: 'bluebubbles driver requires bluebubbles_url and bluebubbles_password' })
    }
  } else if (driverType === 'native' || driverType === 'native-imessage') {
    if (process.platform !== 'darwin') {
      return res.status(400).json({ error: 'native driver requires macOS' })
    }
  } else {
    return res.status(400).json({ error: `Unknown driver: ${driverType}` })
  }

  try {
    // Stop existing channel if running
    if (iMessageChannel) {
      await iMessageChannel.stop()
      iMessageChannel = null
    }

    const config = {
      enabled: true,
      driver: driverType,
      ...(driverType === 'bluebubbles' && {
        bluebubbles: {
          url: bluebubbles_url,
          password: bluebubbles_password,
          webhookPath: '/webhook/bluebubbles'
        }
      }),
      ...((driverType === 'native' || driverType === 'native-imessage') && {
        native: {
          pollInterval: poll_interval || 3000,
          ...(chat_db_path && { chatDbPath: chat_db_path })
        }
      }),
      dmPolicy: dm_policy || 'open',
      groupPolicy: group_policy || 'closed',
      allowlist: allowlist || [],
      apiBaseUrl: api_base_url || 'http://localhost:8000'
    }

    iMessageChannel = new IMessageChannel(config)
    await iMessageChannel.start()

    // Persist to .env
    const env = readBridgeEnv()
    env.IMESSAGE_ENABLED = 'true'
    env.IMESSAGE_DRIVER = driverType
    if (driverType === 'bluebubbles') {
      env.BLUEBUBBLES_URL = bluebubbles_url
      env.BLUEBUBBLES_PASSWORD = bluebubbles_password
    }
    if (poll_interval) env.IMESSAGE_POLL_INTERVAL = String(poll_interval)
    if (api_base_url) env.IMESSAGE_API_BASE_URL = api_base_url
    if (dm_policy) env.IMESSAGE_DM_POLICY = dm_policy
    if (group_policy) env.IMESSAGE_GROUP_POLICY = group_policy
    if (allowlist?.length) env.IMESSAGE_ALLOWLIST = allowlist.join(',')
    writeBridgeEnv(env)

    res.json({ status: 'running', driver: driverType })
  } catch (err) {
    if (iMessageChannel) {
      try { await iMessageChannel.stop() } catch { /* ignore */ }
      iMessageChannel = null
    }
    console.error(`[imessage] Start failed: ${err.message}`)
    res.status(400).json({ error: `Failed to start iMessage: ${err.message}` })
  }
})

app.delete('/api/providers/imessage', async (req, res) => {
  if (iMessageChannel) {
    try { await iMessageChannel.stop() } catch { /* ignore */ }
    iMessageChannel = null
  }

  // Remove from .env
  const env = readBridgeEnv()
  delete env.IMESSAGE_ENABLED
  delete env.IMESSAGE_DRIVER
  delete env.BLUEBUBBLES_URL
  delete env.BLUEBUBBLES_PASSWORD
  delete env.IMESSAGE_API_BASE_URL
  delete env.IMESSAGE_DM_POLICY
  delete env.IMESSAGE_GROUP_POLICY
  delete env.IMESSAGE_ALLOWLIST
  delete env.IMESSAGE_POLL_INTERVAL
  writeBridgeEnv(env)

  res.json({ status: 'stopped' })
})

// ─── iMessage Direct Endpoints ───────────────────────────────────

/**
 * GET /api/imessage/conversations
 * Returns all conversations tracked by the native iMessage driver.
 * Requires iMessage channel to be running with the native driver.
 */
app.get('/api/imessage/conversations', (req, res) => {
  if (!iMessageChannel || !iMessageChannel.driver) {
    return res.status(503).json({ error: 'iMessage channel not running. Start it first via POST /api/providers/imessage' })
  }

  const driver = iMessageChannel.driver
  if (!driver.conversations) {
    return res.status(503).json({ error: 'iMessage driver does not support conversation listing (use native driver)' })
  }

  const conversations = []
  driver.conversations.forEach((conv, guid) => {
    conversations.push({
      guid,
      display_name: conv.displayName || conv.groupName || guid,
      is_group: conv.isGroup || false,
      last_message_at: conv.lastMessageAt || null,
      participant_count: conv.participants ? conv.participants.length : null
    })
  })

  // Sort by most recent message
  conversations.sort((a, b) => {
    if (!a.last_message_at) return 1
    if (!b.last_message_at) return -1
    return new Date(b.last_message_at) - new Date(a.last_message_at)
  })

  res.json({ conversations, count: conversations.length })
})

/**
 * POST /api/imessage/direct-send
 * Send an iMessage by chat GUID or phone/email handle.
 * Body: { chat_guid?: string, handle?: string, text: string }
 * - chat_guid: send directly to a known chat GUID
 * - handle: phone number or email — resolves to chat GUID automatically
 * At least one of chat_guid or handle is required.
 */
app.post('/api/imessage/direct-send', async (req, res) => {
  const { chat_guid, handle, text } = req.body

  if (!text) {
    return res.status(400).json({ error: 'text is required' })
  }
  if (!chat_guid && !handle) {
    return res.status(400).json({ error: 'chat_guid or handle (phone/email) is required' })
  }

  // If we have a chat_guid, require the channel driver
  if (chat_guid) {
    if (!iMessageChannel || !iMessageChannel.driver) {
      return res.status(503).json({ error: 'iMessage channel not running. Start it first via POST /api/providers/imessage' })
    }

    try {
      await iMessageChannel.driver.sendMessage(chat_guid, text)
      return res.json({ ok: true, chat_guid, preview: text.slice(0, 80) })
    } catch (err) {
      console.error(`[imessage/direct-send] Failed: ${err.message}`)
      return res.status(500).json({ error: err.message })
    }
  }

  // Handle-based send — try driver resolution first, fallback to AppleScript
  if (iMessageChannel && iMessageChannel.driver && iMessageChannel.driver.sendToHandle) {
    try {
      const result = await iMessageChannel.driver.sendToHandle(handle, text)
      return res.json({ ok: true, handle, method: result.method || 'chat_guid', preview: text.slice(0, 80) })
    } catch (err) {
      console.error(`[imessage/direct-send] Driver sendToHandle failed: ${err.message}`)
      // Fall through to AppleScript fallback
    }
  }

  // Standalone fallback: AppleScript buddy-based send (works even without driver running)
  if (process.platform !== 'darwin') {
    return res.status(503).json({ error: 'iMessage send requires macOS' })
  }

  try {
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const script =
      `tell application "Messages"\n` +
      `  set targetService to 1st account whose service type = iMessage\n` +
      `  set targetBuddy to participant "${handle}" of targetService\n` +
      `  send "${escaped}" to targetBuddy\n` +
      `end tell`

    const { execFile } = require('child_process')
    await new Promise((resolve, reject) => {
      execFile('/usr/bin/osascript', ['-e', script], { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').trim()
          return reject(new Error(msg.slice(0, 300)))
        }
        resolve(stdout)
      })
    })

    res.json({ ok: true, handle, method: 'applescript_buddy', preview: text.slice(0, 80) })
  } catch (err) {
    console.error(`[imessage/direct-send] AppleScript fallback failed: ${err.message}`)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/imessage/send
 * Send an iMessage by phone number or email (handle-first convenience endpoint).
 * Body: { handle: string, text: string }
 * Alias for /api/imessage/direct-send with handle param.
 */
app.post('/api/imessage/send', async (req, res) => {
  // Rewrite to direct-send format and forward
  req.body.handle = req.body.handle || req.body.to || req.body.phone
  req.url = '/api/imessage/direct-send'
  app.handle(req, res)
})

/**
 * GET /api/imessage/resolve
 * Resolve a phone number or email to a chat GUID without sending.
 * Query: ?handle=<phone_or_email>
 * Returns: { chat_guid, handle_id } or { error }
 */
app.get('/api/imessage/resolve', async (req, res) => {
  const handle = (req.query.handle || '').toString().trim()
  if (!handle) {
    return res.status(400).json({ error: 'handle query param is required (phone or email)' })
  }

  if (iMessageChannel && iMessageChannel.driver && iMessageChannel.driver.resolveHandleToGuid) {
    try {
      const guid = await iMessageChannel.driver.resolveHandleToGuid(handle)
      if (guid) {
        return res.json({ chat_guid: guid, handle, resolved: true })
      }
      return res.json({ chat_guid: null, handle, resolved: false, hint: 'No existing chat found for this handle' })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  // Standalone fallback: query chat.db directly
  if (process.platform !== 'darwin') {
    return res.status(503).json({ error: 'iMessage resolve requires macOS' })
  }

  const digits = handle.replace(/\D/g, '')
  const lower = handle.toLowerCase()
  const conditions = []
  if (digits.length >= 7) {
    conditions.push(
      `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(h.id, '+', ''), '-', ''), ' ', ''), '(', ''), ')', '') LIKE '%${digits}%'`
    )
  }
  conditions.push(`LOWER(h.id) LIKE '%${lower.replace(/'/g, "''").replace(/%/g, '')}%'`)

  const chatDbPath = path.join(process.env.HOME, 'Library', 'Messages', 'chat.db')
  const sql = `
    SELECT c.guid AS chat_guid, c.chat_identifier, h.id AS handle_id,
      MAX(m.date) AS last_date
    FROM chat c
    INNER JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
    INNER JOIN handle h ON h.ROWID = chj.handle_id
    LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
    LEFT JOIN message m ON m.ROWID = cmj.message_id
    WHERE (${conditions.join(' OR ')})
    GROUP BY c.guid
    ORDER BY last_date DESC
    LIMIT 5`

  try {
    const { execFile } = require('child_process')
    const rows = await new Promise((resolve, reject) => {
      execFile('/usr/bin/sqlite3', ['-readonly', '-json', '-bail', chatDbPath, sql],
        { timeout: 10000 }, (err, stdout, stderr) => {
          if (err) {
            const msg = (stderr || err.message || '').trim()
            if (msg.includes('unable to open') || msg.includes('authorization denied')) {
              return reject(new Error('Cannot read chat.db. Grant Full Disk Access.'))
            }
            return reject(new Error(msg.slice(0, 300)))
          }
          try { resolve(stdout.trim() ? JSON.parse(stdout) : []) }
          catch (e) { reject(new Error(`parse: ${e.message}`)) }
        })
    })

    if (rows.length > 0) {
      return res.json({ chat_guid: rows[0].chat_guid, handle, handle_id: rows[0].handle_id, resolved: true, all: rows })
    }
    res.json({ chat_guid: null, handle, resolved: false, hint: 'No existing chat found' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/mail/send
 * Send an email via Apple Mail.app using AppleScript.
 * Body: { to_email: string, to_name?: string, subject: string, body_text: string }
 * Requires macOS with Mail.app installed.
 */
app.post('/api/mail/send', async (req, res) => {
  if (process.platform !== 'darwin') {
    return res.status(503).json({ error: 'Apple Mail is only available on macOS' })
  }

  const { to_email, to_name, cc_email, subject, body_text, attachments, draft } = req.body

  if (!to_email || !subject || !body_text) {
    return res.status(400).json({ error: 'to_email, subject, and body_text are required' })
  }

  // Escape for AppleScript string literals
  const escapeForAppleScript = (str) => (str || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')

  const escapedTo = escapeForAppleScript(to_email)
  const escapedName = escapeForAppleScript(to_name || to_email)
  const escapedSubject = escapeForAppleScript(subject)
  const escapedBody = escapeForAppleScript(body_text)

  // Build attachment lines (array of absolute file paths)
  let attachmentLines = ''
  if (attachments && Array.isArray(attachments) && attachments.length > 0) {
    attachmentLines = attachments.map(fp =>
      `  make new attachment with properties {file name:POSIX file "${escapeForAppleScript(fp)}"} at after the last paragraph of content of msg`
    ).join('\n')
  }

  // Build CC line
  let ccLine = ''
  if (cc_email) {
    const ccAddresses = Array.isArray(cc_email) ? cc_email : [cc_email]
    ccLine = ccAddresses.map(addr =>
      `  make new cc recipient at beginning of cc recipients of msg with properties {address:"${escapeForAppleScript(addr)}"}`
    ).join('\n')
  }

  // draft=true opens compose window without sending; default sends immediately
  const isDraft = draft === true || draft === 'true'
  const sendOrShow = isDraft
    ? `  set visible of msg to true\n  activate`
    : `  delay 1\n  send msg`

  const script = `tell application "Mail"
  set msg to make new outgoing message with properties {subject:"${escapedSubject}", content:"${escapedBody}", visible:false}
  make new to recipient at beginning of to recipients of msg with properties {name:"${escapedName}", address:"${escapedTo}"}
${ccLine}
${attachmentLines}
${sendOrShow}
end tell`

  try {
    await new Promise((resolve, reject) => {
      const { execFile } = require('child_process')
      execFile('/usr/bin/osascript', ['-e', script], { timeout: 20000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message))
        } else {
          resolve(stdout)
        }
      })
    })

    const action = isDraft ? 'Drafted' : 'Sent'
    console.log(`[apple-mail] ${action} to ${to_email}: ${subject}`)
    res.json({ ok: true, provider: 'apple-mail', mode: isDraft ? 'draft' : 'sent', to_email, subject })
  } catch (err) {
    console.error(`[apple-mail] Send failed: ${err.message}`)
    res.status(500).json({ error: `Apple Mail send failed: ${err.message}` })
  }
})

/**
 * GET /api/imessage/search
 * Read recent iMessages directly from ~/Library/Messages/chat.db (read-only).
 * Query: ?handle=<email_or_phone>&days=14&limit=100
 * Returns: { messages: [{ ts, from_me, sender, text }], count }
 *
 * Requires Full Disk Access for the bridge process. Does NOT require the
 * iMessage channel/driver to be running — queries chat.db directly.
 */
app.get('/api/imessage/search', async (req, res) => {
  if (process.platform !== 'darwin') {
    return res.status(503).json({ error: 'iMessage search is only available on macOS' })
  }

  const handle = (req.query.handle || '').toString().trim()
  const days = Math.max(1, Math.min(365, parseInt(req.query.days || '14', 10)))
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '100', 10)))

  if (!handle) {
    return res.status(400).json({ error: 'handle query param is required (email or phone)' })
  }

  // Normalize handle for matching (digits only for phones, lowercase for emails)
  const digits = handle.replace(/\D/g, '')
  const lower = handle.toLowerCase()

  const chatDbPath = path.join(process.env.HOME, 'Library', 'Messages', 'chat.db')

  // Apple's date column is nanoseconds since 2001-01-01
  // Cutoff = (now - N days) - (2001-01-01) seconds, then * 1e9
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
  LOWER(h.id) LIKE '%${lower.replace(/'/g, "''")}%'
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
        { timeout: 15000 },
        (err, stdout, stderr) => {
          if (err) {
            const msg = (stderr || err.message || '').trim()
            if (msg.includes('unable to open') || msg.includes('authorization denied')) {
              return reject(new Error(
                'Cannot read chat.db. Grant Full Disk Access to the bridge process ' +
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
      messages: result,
      count: result.length,
      handle,
      days,
    })
  } catch (err) {
    console.error(`[imessage/search] Failed: ${err.message}`)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/mail/search
 * Search Apple Mail.app inbox by sender (substring match) within N days.
 * Query: ?from=<email_or_name>&days=14&limit=20&include_body=1
 * Returns: { messages: [{ date, sender, subject, body }], count }
 *
 * Uses AppleScript via osascript. Requires Mail.app to be running and
 * accessible to automation (System Settings > Privacy > Automation).
 */
app.get('/api/mail/search', async (req, res) => {
  if (process.platform !== 'darwin') {
    return res.status(503).json({ error: 'Mail search is only available on macOS' })
  }

  const from = (req.query.from || '').toString().trim()
  const days = Math.max(1, Math.min(90, parseInt(req.query.days || '14', 10)))
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || '20', 10)))
  const includeBody = req.query.include_body === '1' || req.query.include_body === 'true'
  const maxBody = Math.max(100, Math.min(50000, parseInt(req.query.max_body || '4000', 10)))
  const subject = (req.query.subject || '').toString().trim()

  if (!from) {
    return res.status(400).json({ error: 'from query param is required (email or name substring)' })
  }

  const escapeForAppleScript = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const fromEscaped = escapeForAppleScript(from)
  const subjectEscaped = subject ? escapeForAppleScript(subject) : ''

  // The script returns a delimited string we parse in JS to avoid AppleScript JSON pain.
  // Format per row: DATE\tSENDER\tSUBJECT\tBODY (body truncated to max_body chars, default 4000)
  const subjectFilter = subjectEscaped
    ? ` and subject contains "${subjectEscaped}"`
    : ''
  const script = `
tell application "Mail"
  set output to ""
  set cutoffDate to (current date) - (${days} * days)
  set msgCount to 0
  try
    set msgs to (messages of inbox whose sender contains "${fromEscaped}"${subjectFilter} and date received > cutoffDate)
    repeat with msg in msgs
      if msgCount >= ${limit} then exit repeat
      set msgCount to msgCount + 1
      try
        set theDate to (date received of msg) as string
      on error
        set theDate to "unknown"
      end try
      try
        set theSender to sender of msg
      on error
        set theSender to ""
      end try
      try
        set theSubject to subject of msg
      on error
        set theSubject to "(no subject)"
      end try
      set theBody to ""
      ${includeBody ? `try
        set theBody to content of msg
        if length of theBody > ${maxBody} then set theBody to (text 1 thru ${maxBody} of theBody) & "..."
      end try` : ''}
      set output to output & theDate & "\\t" & theSender & "\\t" & theSubject & "\\t" & theBody & "\\n---ROW---\\n"
    end repeat
  end try
  return output
end tell
`.trim()

  try {
    const stdout = await new Promise((resolve, reject) => {
      const { execFile } = require('child_process')
      execFile('/usr/bin/osascript', ['-e', script], { timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
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

    const messages = stdout
      .split(/\n---ROW---\n/)
      .map((row) => row.trim())
      .filter((row) => row.length > 0)
      .map((row) => {
        const [date, sender, subject, ...bodyParts] = row.split('\t')
        return {
          date: date || '',
          sender: sender || '',
          subject: subject || '',
          body: bodyParts.join('\t') || '',
        }
      })

    res.json({
      messages,
      count: messages.length,
      from,
      days,
    })
  } catch (err) {
    console.error(`[mail/search] Failed: ${err.message}`)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/calendar/events
 * List upcoming events from macOS Calendar.app using AppleScript.
 * Query: ?days=7&calendar=<name>&limit=20
 * Returns: { events: [{ title, start_date, end_date, location, notes, calendar, all_day }], count }
 */
app.get('/api/calendar/events', async (req, res) => {
  if (process.platform !== 'darwin') {
    return res.status(503).json({ error: 'Calendar.app is only available on macOS' })
  }

  const days = Math.max(1, Math.min(90, parseInt(req.query.days || '7', 10)))
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '20', 10)))
  const calendarFilter = (req.query.calendar || '').toString().trim()

  const escapeForAppleScript = (s) => (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')

  // Build calendar filter clause
  const calFilter = calendarFilter
    ? `whose name is "${escapeForAppleScript(calendarFilter)}"`
    : ''

  const script = `
tell application "Calendar"
  set output to ""
  set startDate to (current date)
  set hours of startDate to 0
  set minutes of startDate to 0
  set seconds of startDate to 0
  set endDate to startDate + (${days} * days)
  set eventCount to 0
  set cals to (calendars ${calFilter})
  repeat with cal in cals
    set calName to name of cal
    try
      set evts to (every event of cal whose start date >= startDate and start date <= endDate)
      repeat with evt in evts
        if eventCount >= ${limit} then exit repeat
        set eventCount to eventCount + 1
        set evtTitle to summary of evt
        set evtStart to (start date of evt) as string
        set evtEnd to (end date of evt) as string
        set evtLocation to ""
        try
          set evtLocation to location of evt
        end try
        set evtNotes to ""
        try
          set evtNotes to description of evt
          if length of evtNotes > 500 then set evtNotes to (text 1 thru 500 of evtNotes) & "..."
        end try
        set evtAllDay to allday event of evt
        set output to output & evtTitle & "\\t" & evtStart & "\\t" & evtEnd & "\\t" & evtLocation & "\\t" & evtNotes & "\\t" & calName & "\\t" & evtAllDay & "\\n---ROW---\\n"
      end repeat
    end try
    if eventCount >= ${limit} then exit repeat
  end repeat
  return output
end tell
`.trim()

  try {
    const stdout = await new Promise((resolve, reject) => {
      const { execFile } = require('child_process')
      execFile('/usr/bin/osascript', ['-e', script], { timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').trim()
          if (msg.includes('-1743') || msg.includes('not allowed')) {
            return reject(new Error(
              'Calendar.app automation not authorized. Grant access in System Settings > Privacy > Automation.'
            ))
          }
          return reject(new Error(`osascript: ${msg.slice(0, 300)}`))
        }
        resolve(stdout)
      })
    })

    const events = stdout
      .split(/\n---ROW---\n/)
      .map((row) => row.trim())
      .filter((row) => row.length > 0)
      .map((row) => {
        const [title, start_date, end_date, location, notes, calendar, all_day] = row.split('\t')
        return {
          title: title || '',
          start_date: start_date || '',
          end_date: end_date || '',
          location: location || '',
          notes: notes || '',
          calendar: calendar || '',
          all_day: all_day === 'true',
        }
      })

    // Sort by start_date
    events.sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())

    res.json({
      events,
      count: events.length,
      days,
    })
  } catch (err) {
    console.error(`[calendar/events] Failed: ${err.message}`)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/calendar/create
 * Create a new event in macOS Calendar.app using AppleScript.
 * Body: { title, start_date (ISO), end_date (ISO), location, notes, calendar (default "Meetings"), draft (boolean) }
 * Returns: { ok: true, title, calendar, start_date }
 */
app.post('/api/calendar/create', async (req, res) => {
  if (process.platform !== 'darwin') {
    return res.status(503).json({ error: 'Calendar.app is only available on macOS' })
  }

  const { title, start_date, end_date, location, notes, calendar, draft } = req.body
  const calName = calendar || 'Meetings'

  if (!title || !start_date) {
    return res.status(400).json({ error: 'title and start_date are required' })
  }

  const escapeForAppleScript = (s) => (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')

  // Convert ISO date to AppleScript-friendly format
  // AppleScript parses dates like: date "Monday, April 14, 2026 at 4:30:00 PM"
  const formatDateForAppleScript = (isoStr) => {
    const d = new Date(isoStr)
    // Use toLocaleString to get the full date string macOS understands
    return d.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    })
  }

  const startFormatted = formatDateForAppleScript(start_date)
  // Default end_date to 1 hour after start if not provided
  const endIso = end_date || new Date(new Date(start_date).getTime() + 60 * 60 * 1000).toISOString()
  const endFormatted = formatDateForAppleScript(endIso)

  const locationLine = location
    ? `set location of newEvent to "${escapeForAppleScript(location)}"`
    : ''
  const notesLine = notes
    ? `set description of newEvent to "${escapeForAppleScript(notes)}"`
    : ''

  const isDraft = draft === true || draft === 'true'
  const activateLine = isDraft ? `\n  activate` : ''

  const script = `
tell application "Calendar"
  set targetCal to null
  repeat with cal in calendars
    if name of cal is "${escapeForAppleScript(calName)}" then
      set targetCal to cal
      exit repeat
    end if
  end repeat
  if targetCal is null then
    error "Calendar \\"${escapeForAppleScript(calName)}\\" not found"
  end if
  set newEvent to make new event at end of events of targetCal with properties {summary:"${escapeForAppleScript(title)}", start date:date "${startFormatted}", end date:date "${endFormatted}"}
  ${locationLine}
  ${notesLine}${activateLine}
end tell
`.trim()

  try {
    await new Promise((resolve, reject) => {
      const { execFile } = require('child_process')
      execFile('/usr/bin/osascript', ['-e', script], { timeout: 20000 }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').trim()
          if (msg.includes('-1743') || msg.includes('not allowed')) {
            return reject(new Error(
              'Calendar.app automation not authorized. Grant access in System Settings > Privacy > Automation.'
            ))
          }
          return reject(new Error(`osascript: ${msg.slice(0, 300)}`))
        }
        resolve(stdout)
      })
    })

    console.log(`[calendar] Created event "${title}" in ${calName} at ${start_date}`)
    res.json({ ok: true, title, calendar: calName, start_date })
  } catch (err) {
    console.error(`[calendar/create] Failed: ${err.message}`)
    res.status(500).json({ error: `Calendar event creation failed: ${err.message}` })
  }
})

// BlueBubbles webhook receiver — BB POSTs here when a message arrives
app.post('/webhook/bluebubbles', (req, res) => {
  if (iMessageChannel && iMessageChannel.driver && iMessageChannel.driver.handleWebhook) {
    iMessageChannel.driver.handleWebhook(req.body)
  } else {
    console.warn('[bluebubbles] Webhook received but iMessage channel not running')
  }
  res.sendStatus(200)
})

// ─── Claude Code Endpoints ───────────────────────────────────────

app.post('/api/sessions/claude-code', async (req, res) => {
  const { session_id, project_path, initial_prompt, model } = req.body
  const sid = session_id || randomUUID()
  const cwd = project_path || process.env.HOME

  try {
    const args = [
      '-p', initial_prompt || 'Start a new coding session. Introduce yourself briefly.',
      '--session-id', sid,
      '--output-format', 'json'
    ]
    if (model) args.push('--model', model)

    console.log(`[claude-code] Creating session ${sid} in ${cwd}`)
    const raw = await runCLI(CLAUDE_BIN, args, { timeoutMs: 90000, cwd })
    const data = tryJSON(raw)

    const result = {
      session_id: data?.session_id || sid,
      status: 'active',
      response: data?.result || raw,
      model: data?.model || model || null,
      tokens_used: (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0),
      cost_usd: data?.total_cost_usd || 0
    }

    console.log(`[claude-code] Session ${sid} created OK (${data?.duration_ms || '?'}ms)`)
    res.json(result)
  } catch (err) {
    console.error(`[claude-code] Create failed: ${err.message}`)
    res.status(500).json({ session_id: sid, status: 'error', error: err.message })
  }
})

app.post('/api/sessions/claude-code/:id/message', async (req, res) => {
  const { message } = req.body
  const sid = req.params.id

  try {
    const args = ['-p', message, '--resume', sid, '--output-format', 'json']

    console.log(`[claude-code] Message to session ${sid}`)
    const raw = await runCLI(CLAUDE_BIN, args, { timeoutMs: 180000 })
    const data = tryJSON(raw)

    res.json({
      response: data?.result || raw,
      model: data?.model || null,
      tokens_used: (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0),
      cost_usd: data?.total_cost_usd || 0
    })
  } catch (err) {
    console.error(`[claude-code] Message failed: ${err.message}`)
    res.status(500).json({ error: err.message })
  }
})

// ─── Session History (reads JSONL from disk) ────────────────────

app.get('/api/sessions/claude-code/:id/history', (req, res) => {
  const sessionId = req.params.id
  const claudeDir = path.join(process.env.HOME, '.claude', 'projects')

  // Find the JSONL file across all project dirs
  let filePath = null
  try {
    const dirs = fs.readdirSync(claudeDir).filter(d =>
      fs.statSync(path.join(claudeDir, d)).isDirectory()
    )
    for (const dir of dirs) {
      const candidate = path.join(claudeDir, dir, `${sessionId}.jsonl`)
      if (fs.existsSync(candidate)) {
        filePath = candidate
        break
      }
    }
  } catch (err) {
    return res.status(404).json({ error: 'Session not found' })
  }

  if (!filePath) {
    return res.status(404).json({ error: `Session ${sessionId} not found` })
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const lines = content.split('\n').filter(Boolean)

    const messages = []
    const filesEdited = new Set()
    const filesRead = new Set()
    const commandsRun = []
    const toolCounts = {}
    let cwd = null
    let gitBranch = null
    let totalCostUsd = 0

    for (const line of lines) {
      const obj = tryJSON(line)
      if (!obj) continue

      if (obj.cwd && !cwd) cwd = obj.cwd
      if (obj.gitBranch && !gitBranch) gitBranch = obj.gitBranch

      const msg = obj.message || {}
      const role = msg.role || obj.type
      const msgContent = msg.content || obj.content || ''

      // Cost tracking
      if (obj.costUSD) totalCostUsd += obj.costUSD

      // Skip non-message types
      if (!['user', 'assistant'].includes(role)) continue

      // Parse content blocks
      if (typeof msgContent === 'string' && msgContent.trim()) {
        messages.push({
          role,
          type: 'text',
          text: msgContent.slice(0, 2000),
          timestamp: obj.timestamp || null
        })
      } else if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (!block || typeof block !== 'object') continue

          if (block.type === 'text' && block.text) {
            messages.push({
              role,
              type: 'text',
              text: block.text.slice(0, 2000),
              timestamp: obj.timestamp || null
            })
          } else if (block.type === 'tool_use') {
            const toolName = block.name || 'unknown'
            const input = block.input || {}
            toolCounts[toolName] = (toolCounts[toolName] || 0) + 1

            if (['Edit', 'Write', 'NotebookEdit'].includes(toolName)) {
              const fp = input.file_path || input.notebook_path || ''
              if (fp) filesEdited.add(fp)
              messages.push({
                role,
                type: 'tool_use',
                tool: toolName,
                file_path: fp,
                timestamp: obj.timestamp || null
              })
            } else if (toolName === 'Read') {
              const fp = input.file_path || ''
              if (fp) filesRead.add(fp)
              messages.push({
                role,
                type: 'tool_use',
                tool: 'Read',
                file_path: fp || null,
                command: null,
                timestamp: obj.timestamp || null
              })
            } else if (toolName === 'Bash') {
              const cmd = (input.command || '').slice(0, 200)
              if (cmd) commandsRun.push(cmd)
              messages.push({
                role,
                type: 'tool_use',
                tool: 'Bash',
                command: cmd,
                timestamp: obj.timestamp || null
              })
            } else if (toolName === 'Grep' || toolName === 'Glob') {
              messages.push({
                role,
                type: 'tool_use',
                tool: toolName,
                file_path: input.path || input.pattern || null,
                command: input.pattern || null,
                timestamp: obj.timestamp || null
              })
            } else {
              messages.push({
                role,
                type: 'tool_use',
                tool: toolName,
                timestamp: obj.timestamp || null
              })
            }
          } else if (block.type === 'tool_result') {
            // skip tool results to keep response small
          }
        }
      }
    }

    const stat = fs.statSync(filePath)

    res.json({
      session_id: sessionId,
      project_path: cwd,
      git_branch: gitBranch,
      created_at: stat.birthtime.toISOString(),
      updated_at: stat.mtime.toISOString(),
      total_cost_usd: totalCostUsd,
      summary: {
        total_messages: messages.filter(m => m.type === 'text').length,
        user_messages: messages.filter(m => m.role === 'user' && m.type === 'text').length,
        assistant_messages: messages.filter(m => m.role === 'assistant' && m.type === 'text').length,
        files_edited: [...filesEdited],
        files_read: [...filesRead],
        commands_run: commandsRun.slice(0, 50),
        tools_used: toolCounts
      },
      messages: messages.slice(0, parseInt(req.query.limit) || 200)
    })
  } catch (err) {
    console.error(`[claude-code] History read error: ${err.message}`)
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/sessions/claude-code/:id', (req, res) => {
  res.json({ ok: true })
})

// ─── OpenCode Endpoints ──────────────────────────────────────────

function parseOpenCodeOutput (raw, fallbackModel) {
  // OpenCode --format json outputs newline-delimited JSON events
  const lines = raw.trim().split('\n')
  let response = ''
  let model = fallbackModel || 'opencode'
  let sessionId = null

  for (const line of lines) {
    const evt = tryJSON(line)
    if (!evt) continue
    // Accumulate text content from assistant
    if (evt.type === 'text' || evt.type === 'assistant' || evt.role === 'assistant') {
      response += evt.content || evt.text || ''
    }
    if (evt.model) model = evt.model
    if (evt.session_id || evt.sessionId) sessionId = evt.session_id || evt.sessionId
  }

  // Fallback: if no structured events parsed, use raw output
  if (!response) response = raw.trim()

  return { response, model, sessionId }
}

app.post('/api/sessions/opencode', async (req, res) => {
  const { session_id, project_path, initial_prompt, model } = req.body
  const sid = session_id || randomUUID()
  const cwd = project_path || process.env.HOME

  try {
    const args = [
      'run',
      initial_prompt || 'Start a new coding session. Introduce yourself briefly.',
      '--format', 'json'
    ]
    if (model) args.push('-m', model)

    console.log(`[opencode] Creating session in ${cwd}`)
    const raw = await runCLI(OPENCODE_BIN, args, { timeoutMs: 90000, cwd })
    const parsed = parseOpenCodeOutput(raw, model)

    res.json({
      session_id: parsed.sessionId || sid,
      status: 'active',
      response: parsed.response,
      model: parsed.model,
      tokens_used: 0
    })
  } catch (err) {
    console.error(`[opencode] Create failed: ${err.message}`)
    res.status(500).json({ session_id: sid, status: 'error', error: err.message })
  }
})

app.post('/api/sessions/opencode/:id/message', async (req, res) => {
  const { message } = req.body
  const sid = req.params.id

  try {
    const args = ['run', message, '-s', sid, '--format', 'json']

    console.log(`[opencode] Message to session ${sid}`)
    const raw = await runCLI(OPENCODE_BIN, args, { timeoutMs: 180000 })
    const parsed = parseOpenCodeOutput(raw)

    res.json({
      response: parsed.response,
      model: parsed.model,
      tokens_used: 0
    })
  } catch (err) {
    console.error(`[opencode] Message failed: ${err.message}`)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/sessions/opencode/:id/history', (req, res) => {
  const sessionId = req.params.id
  const limit = parseInt(req.query.limit) || 200
  const msgDir = path.join(process.env.HOME, '.local', 'share', 'opencode', 'storage', 'message', sessionId)

  if (!fs.existsSync(msgDir)) {
    return res.status(404).json({ error: `OpenCode session ${sessionId} not found` })
  }

  try {
    const files = fs.readdirSync(msgDir)
      .filter(f => f.endsWith('.json'))
      .sort() // alphabetical = chronological for OpenCode

    const messages = []
    const filesEdited = new Set()
    const commandsRun = []
    const toolCounts = {}

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(msgDir, file), 'utf8')
        const data = JSON.parse(raw)
        if (!data.role) continue

        const role = data.role === 'assistant' ? 'assistant' : 'user'

        // OpenCode messages can have parts array or direct content
        const parts = data.parts || []
        if (parts.length > 0) {
          for (const part of parts) {
            if (part.type === 'text' && part.content) {
              messages.push({
                role,
                type: 'text',
                text: part.content.slice(0, 2000),
                timestamp: data.time ? new Date(data.time.created || data.time).toISOString() : null
              })
            } else if (part.type === 'tool-invocation' || part.type === 'tool_use') {
              const toolName = part.toolName || part.name || 'unknown'
              toolCounts[toolName] = (toolCounts[toolName] || 0) + 1
              const input = part.input || part.args || {}

              if (['file_edit', 'file_write', 'write', 'edit'].includes(toolName)) {
                const fp = input.file_path || input.path || ''
                if (fp) filesEdited.add(fp)
              }
              if (['bash', 'shell', 'command'].includes(toolName)) {
                const cmd = (input.command || input.cmd || '').slice(0, 200)
                if (cmd) commandsRun.push(cmd)
              }

              messages.push({
                role,
                type: 'tool_use',
                tool: toolName,
                file_path: input.file_path || input.path || null,
                command: input.command || input.cmd || null,
                timestamp: data.time ? new Date(data.time.created || data.time).toISOString() : null
              })
            }
          }
        } else if (data.content) {
          // Direct content string
          messages.push({
            role,
            type: 'text',
            text: (typeof data.content === 'string' ? data.content : JSON.stringify(data.content)).slice(0, 2000),
            timestamp: data.time ? new Date(data.time.created || data.time).toISOString() : null
          })
        }
      } catch { /* skip unreadable message files */ }
    }

    // Load session metadata if available
    const sessionDir = path.join(process.env.HOME, '.local', 'share', 'opencode', 'storage', 'session')
    let sessionMeta = null
    try {
      // Find session file across project dirs
      const projDirs = fs.readdirSync(sessionDir).filter(d => {
        try { return fs.statSync(path.join(sessionDir, d)).isDirectory() } catch { return false }
      })
      for (const projDir of projDirs) {
        const candidate = path.join(sessionDir, projDir, `${sessionId}.json`)
        if (fs.existsSync(candidate)) {
          sessionMeta = JSON.parse(fs.readFileSync(candidate, 'utf8'))
          break
        }
      }
    } catch { /* skip */ }

    const limited = messages.slice(0, limit)

    res.json({
      session_id: sessionId,
      project_path: sessionMeta?.directory || null,
      created_at: sessionMeta?.time?.created ? new Date(sessionMeta.time.created).toISOString() : null,
      updated_at: sessionMeta?.time?.updated ? new Date(sessionMeta.time.updated).toISOString() : null,
      summary: {
        total_messages: limited.filter(m => m.type === 'text').length,
        user_messages: limited.filter(m => m.role === 'user' && m.type === 'text').length,
        assistant_messages: limited.filter(m => m.role === 'assistant' && m.type === 'text').length,
        files_edited: [...filesEdited],
        commands_run: commandsRun.slice(0, 50),
        tools_used: toolCounts
      },
      messages: limited
    })
  } catch (err) {
    console.error(`[opencode] History read error: ${err.message}`)
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/sessions/opencode/:id', (req, res) => {
  res.json({ ok: true })
})

// ─── Ollama Endpoints ───────────────────────────────────────────

// In-memory session store: { sessionId: { model, messages: [{role,content}], created_at, updated_at } }
const ollamaSessions = new Map()
const OLLAMA_SESSIONS_DIR = path.join(process.env.HOME, '.iris', 'bridge', 'ollama-sessions')

function saveOllamaSession (sid) {
  const session = ollamaSessions.get(sid)
  if (!session) return
  try {
    fs.mkdirSync(OLLAMA_SESSIONS_DIR, { recursive: true })
    fs.writeFileSync(path.join(OLLAMA_SESSIONS_DIR, `${sid}.json`), JSON.stringify(session), 'utf8')
  } catch { /* ignore */ }
}

function loadOllamaSessions () {
  try {
    if (!fs.existsSync(OLLAMA_SESSIONS_DIR)) return
    const files = fs.readdirSync(OLLAMA_SESSIONS_DIR).filter(f => f.endsWith('.json'))
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(OLLAMA_SESSIONS_DIR, file), 'utf8'))
        const sid = path.basename(file, '.json')
        ollamaSessions.set(sid, data)
      } catch { /* skip corrupt files */ }
    }
    if (ollamaSessions.size > 0) {
      console.log(`[ollama] Loaded ${ollamaSessions.size} saved sessions`)
    }
  } catch { /* ignore */ }
}

// List available Ollama models
app.get('/api/ollama/models', async (req, res) => {
  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(5000) })
    if (!resp.ok) return res.status(resp.status).json({ error: 'Ollama not reachable' })
    const data = await resp.json()
    res.json({ models: (data.models || []).map(m => ({ name: m.name, size: m.size, modified_at: m.modified_at })) })
  } catch (err) {
    res.status(503).json({ error: `Ollama not available: ${err.message}` })
  }
})

// Create new Ollama session
app.post('/api/sessions/ollama', async (req, res) => {
  const { session_id, initial_prompt, model } = req.body
  const sid = session_id || randomUUID()
  const chosenModel = model || 'llama3.2'

  const userMsg = initial_prompt || 'Hello! Introduce yourself briefly.'
  const messages = [{ role: 'user', content: userMsg }]

  try {
    console.log(`[ollama] Creating session ${sid} with model ${chosenModel}`)
    const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: chosenModel, messages, stream: false }),
      signal: AbortSignal.timeout(120000)
    })

    if (!resp.ok) {
      const errText = await resp.text()
      throw new Error(`Ollama returned ${resp.status}: ${errText.slice(0, 200)}`)
    }

    const data = await resp.json()
    const assistantContent = data.message?.content || ''

    // Store session
    const session = {
      model: chosenModel,
      messages: [...messages, { role: 'assistant', content: assistantContent }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    ollamaSessions.set(sid, session)
    saveOllamaSession(sid)

    console.log(`[ollama] Session ${sid} created (${data.eval_count || '?'} tokens)`)
    res.json({
      session_id: sid,
      status: 'active',
      response: assistantContent,
      model: data.model || chosenModel,
      tokens_used: (data.prompt_eval_count || 0) + (data.eval_count || 0)
    })
  } catch (err) {
    console.error(`[ollama] Create failed: ${err.message}`)
    res.status(500).json({ session_id: sid, status: 'error', error: err.message })
  }
})

// Send message to existing Ollama session
app.post('/api/sessions/ollama/:id/message', async (req, res) => {
  const { message, model } = req.body
  const sid = req.params.id

  const session = ollamaSessions.get(sid)
  if (!session) {
    return res.status(404).json({ error: `Ollama session ${sid} not found` })
  }

  const chosenModel = model || session.model
  session.messages.push({ role: 'user', content: message })

  try {
    console.log(`[ollama] Message to session ${sid}`)
    const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: chosenModel, messages: session.messages, stream: false }),
      signal: AbortSignal.timeout(180000)
    })

    if (!resp.ok) {
      // Remove the user message we just pushed since it failed
      session.messages.pop()
      const errText = await resp.text()
      throw new Error(`Ollama returned ${resp.status}: ${errText.slice(0, 200)}`)
    }

    const data = await resp.json()
    const assistantContent = data.message?.content || ''

    session.messages.push({ role: 'assistant', content: assistantContent })
    session.model = data.model || chosenModel
    session.updated_at = new Date().toISOString()
    saveOllamaSession(sid)

    res.json({
      response: assistantContent,
      model: session.model,
      tokens_used: (data.prompt_eval_count || 0) + (data.eval_count || 0)
    })
  } catch (err) {
    console.error(`[ollama] Message failed: ${err.message}`)
    res.status(500).json({ error: err.message })
  }
})

// Get Ollama session history
app.get('/api/sessions/ollama/:id/history', (req, res) => {
  const sid = req.params.id
  const session = ollamaSessions.get(sid)
  if (!session) {
    return res.status(404).json({ error: `Ollama session ${sid} not found` })
  }

  const limit = parseInt(req.query.limit) || 200
  const messages = session.messages.slice(0, limit).map((m, i) => ({
    role: m.role,
    type: 'text',
    text: (m.content || '').slice(0, 2000),
    timestamp: i === 0 ? session.created_at : session.updated_at
  }))

  res.json({
    session_id: sid,
    model: session.model,
    created_at: session.created_at,
    updated_at: session.updated_at,
    summary: {
      total_messages: messages.length,
      user_messages: messages.filter(m => m.role === 'user').length,
      assistant_messages: messages.filter(m => m.role === 'assistant').length,
      files_edited: [],
      commands_run: [],
      tools_used: {}
    },
    messages
  })
})

// List Ollama sessions
app.get('/api/sessions/ollama', (req, res) => {
  const limit = parseInt(req.query.limit) || 50
  const sessions = []

  for (const [sid, session] of ollamaSessions.entries()) {
    // Get name from first user message
    const firstUserMsg = session.messages.find(m => m.role === 'user')
    const name = firstUserMsg
      ? (firstUserMsg.content.length > 80 ? firstUserMsg.content.slice(0, 77) + '...' : firstUserMsg.content)
      : 'Ollama Session'

    sessions.push({
      session_id: sid,
      name,
      project_path: null,
      git_branch: null,
      model: session.model,
      created_at: session.created_at,
      updated_at: session.updated_at,
      message_count: session.messages.length,
      provider: 'ollama'
    })
  }

  sessions.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
  res.json({ sessions: sessions.slice(0, limit) })
})

// Delete Ollama session
app.delete('/api/sessions/ollama/:id', (req, res) => {
  const sid = req.params.id
  ollamaSessions.delete(sid)
  try {
    const fp = path.join(OLLAMA_SESSIONS_DIR, `${sid}.json`)
    if (fs.existsSync(fp)) fs.unlinkSync(fp)
  } catch { /* ignore */ }
  res.json({ ok: true })
})

// ─── Helpers: Session metadata extraction ───────────────────────

/**
 * Extract a meaningful session name from the first user message in JSONL.
 * Falls back to the project directory name if no user message found.
 */
function extractSessionName (lines, projectPath) {
  for (const line of lines) {
    const evt = tryJSON(line)
    if (!evt) continue
    if (evt.type === 'user' && evt.message && evt.message.role === 'user') {
      const content = typeof evt.message.content === 'string'
        ? evt.message.content
        : Array.isArray(evt.message.content)
          ? evt.message.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
          : ''
      if (content.trim()) {
        // Clean up: remove command markup, system injections, trim to 80 chars
        const cleaned = content
          .replace(/<[^>]+>/g, '') // strip HTML/XML tags
          .replace(/\s+/g, ' ')   // collapse whitespace
          .trim()
        // Skip system-injected messages (not real user input)
        if (!cleaned ||
            cleaned.startsWith('Caveat:') ||
            cleaned.startsWith('clear') ||
            cleaned.startsWith('/clear') ||
            cleaned.length < 3) {
          continue
        }
        if (cleaned.length > 80) return cleaned.slice(0, 77) + '...'
        return cleaned
      }
    }
  }
  // Fallback: use last segment of project path
  if (projectPath) {
    const segments = projectPath.replace(/\/+$/, '').split('/')
    return segments[segments.length - 1] || 'Coding Session'
  }
  return 'Coding Session'
}

/**
 * Reconstruct project path from Claude Code's directory name.
 * Directory names use leading dash + path separators as dashes:
 *   -Users-AlexMayo-Sites-freelabel-fl-docker-dev-fl-api
 * But we can't naively replace all dashes because directory names
 * contain dashes too (e.g. fl-docker-dev, fl-elon-web-ui).
 * Strategy: check which reconstruction actually exists on disk.
 */
function reconstructPath (dirName) {
  // Remove leading dash
  const raw = dirName.startsWith('-') ? dirName.slice(1) : dirName
  const parts = raw.split('-')

  // Greedy path reconstruction: try combining adjacent segments
  // by checking which paths actually exist on the filesystem
  let bestPath = '/'
  let i = 0
  while (i < parts.length) {
    let matched = false
    // Try longest match first (up to 4 segments joined by dash)
    for (let len = Math.min(4, parts.length - i); len >= 1; len--) {
      const candidate = parts.slice(i, i + len).join('-')
      const testPath = path.join(bestPath, candidate)
      try {
        if (fs.existsSync(testPath)) {
          bestPath = testPath
          i += len
          matched = true
          break
        }
      } catch {
        // ignore
      }
    }
    if (!matched) {
      // No match found, just append single segment as slash-separated
      bestPath = path.join(bestPath, parts[i])
      i++
    }
  }
  return bestPath
}

// ─── List / Discover Sessions ────────────────────────────────────

app.get('/api/sessions/claude-code', async (req, res) => {
  try {
    // Read sessions directly from Claude Code's local storage
    const claudeDir = path.join(process.env.HOME, '.claude', 'projects')
    if (!fs.existsSync(claudeDir)) {
      return res.json({ sessions: [] })
    }

    const limit = parseInt(req.query.limit) || 20
    const sessions = []

    // Scan all project dirs for .jsonl session files
    const projectDirs = fs.readdirSync(claudeDir).filter(d => {
      return fs.statSync(path.join(claudeDir, d)).isDirectory()
    })

    for (const dir of projectDirs) {
      const dirPath = path.join(claudeDir, dir)
      const files = fs.readdirSync(dirPath)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({
          name: f,
          path: path.join(dirPath, f),
          mtime: fs.statSync(path.join(dirPath, f)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit)

      for (const file of files) {
        try {
          const content = fs.readFileSync(file.path, 'utf8')
          const allLines = content.split('\n').filter(Boolean)

          // Read first 40 lines for metadata (cwd, branch, first user msg)
          // Some sessions have many system lines before the first user message
          const headLines = allLines.slice(0, 40)
          let sessionId = path.basename(file.name, '.jsonl')
          let cwd = null
          let gitBranch = null
          let model = null

          for (const line of headLines) {
            const evt = tryJSON(line)
            if (!evt) continue
            if (evt.sessionId) sessionId = evt.sessionId
            if (evt.cwd && !cwd) cwd = evt.cwd
            if (evt.gitBranch && !gitBranch) gitBranch = evt.gitBranch
            if (evt.message && evt.message.model && !model) model = evt.message.model
          }

          // Fix: use cwd from JSONL, or reconstruct path by checking filesystem
          const projectPath = cwd || reconstructPath(dir)

          // Generate meaningful name from first user message
          const sessionName = extractSessionName(headLines, projectPath)

          // Count approximate messages (lines with "role")
          const messageCount = allLines.filter(l => l.includes('"role"')).length

          const stat = fs.statSync(file.path)

          sessions.push({
            session_id: sessionId,
            name: sessionName,
            project_path: projectPath,
            git_branch: gitBranch,
            model,
            created_at: stat.birthtime.toISOString(),
            updated_at: file.mtime.toISOString(),
            message_count: messageCount,
            provider: 'claude_code'
          })
        } catch (readErr) {
          // Skip unreadable files
        }
      }
    }

    // Sort by most recent update and limit
    sessions.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    res.json({ sessions: sessions.slice(0, limit) })
  } catch (err) {
    console.log(`[claude-code] List sessions failed: ${err.message}`)
    res.json({ sessions: [], error: err.message })
  }
})

app.get('/api/sessions/opencode', async (req, res) => {
  try {
    const ocDir = path.join(process.env.HOME, '.local', 'share', 'opencode', 'storage', 'session')
    if (!fs.existsSync(ocDir)) {
      return res.json({ sessions: [] })
    }

    const limit = parseInt(req.query.limit) || 50
    const sessions = []

    // Scan all project dirs for session JSON files
    const projectDirs = fs.readdirSync(ocDir).filter(d => {
      try { return fs.statSync(path.join(ocDir, d)).isDirectory() } catch { return false }
    })

    for (const projDir of projectDirs) {
      const projPath = path.join(ocDir, projDir)
      const files = fs.readdirSync(projPath).filter(f => f.endsWith('.json'))

      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(projPath, file), 'utf8')
          const data = JSON.parse(raw)
          if (!data.id) continue

          // Count messages for this session
          let messageCount = 0
          const msgDir = path.join(process.env.HOME, '.local', 'share', 'opencode', 'storage', 'message', data.id)
          if (fs.existsSync(msgDir)) {
            try { messageCount = fs.readdirSync(msgDir).filter(f => f.endsWith('.json')).length } catch { /* skip */ }
          }

          sessions.push({
            session_id: data.id,
            name: data.title || data.slug || 'OpenCode Session',
            project_path: data.directory || null,
            git_branch: null,
            model: null,
            created_at: data.time && data.time.created ? new Date(data.time.created).toISOString() : null,
            updated_at: data.time && data.time.updated ? new Date(data.time.updated).toISOString() : null,
            message_count: messageCount,
            provider: 'opencode',
            summary: data.summary || null,
            parent_id: data.parentID || null
          })
        } catch { /* skip unreadable files */ }
      }
    }

    // Sort by most recent update, limit
    sessions.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
    res.json({ sessions: sessions.slice(0, limit) })
  } catch (err) {
    console.log(`[opencode] List sessions failed: ${err.message}`)
    res.json({ sessions: [], error: err.message })
  }
})

// ─── Discover All Sessions Across Providers ─────────────────────

app.get('/api/discover', async (req, res) => {
  // Re-use the claude-code list endpoint internally
  try {
    const limit = parseInt(req.query.limit) || 20
    const claudeResp = await new Promise((resolve) => {
      const mockReq = { query: { limit } }
      const mockRes = { json: (data) => resolve(data) }
      // Call the list handler directly isn't clean, so just fetch from self
      resolve({ sessions: [] })
    })

    // Fetch from our own endpoints
    const http = require('http')
    const fetchLocal = (urlPath) => new Promise((resolve) => {
      http.get(`http://localhost:${PORT}${urlPath}?limit=${limit}`, (r) => {
        let body = ''
        r.on('data', d => { body += d })
        r.on('end', () => resolve(tryJSON(body) || { sessions: [] }))
      }).on('error', () => resolve({ sessions: [] }))
    })

    const [claude, opencode, ollama] = await Promise.all([
      fetchLocal('/api/sessions/claude-code'),
      fetchLocal('/api/sessions/opencode'),
      fetchLocal('/api/sessions/ollama')
    ])

    res.json({
      claude_code: claude.sessions || [],
      opencode: opencode.sessions || [],
      ollama: ollama.sessions || []
    })
  } catch (err) {
    console.log(`[discover] Error: ${err.message}`)
    res.json({ claude_code: [], opencode: [], ollama: [] })
  }
})

// ─── Open in Terminal ────────────────────────────────────────────

app.post('/api/sessions/open-terminal', (req, res) => {
  const { command, provider, session_id, project_path } = req.body

  // Build the command if not provided directly
  let cmd = command
  if (!cmd) {
    if (provider === 'claude_code' || provider === 'claude-code') {
      cmd = session_id ? `${CLAUDE_BIN} --resume ${session_id}` : CLAUDE_BIN
    } else if (provider === 'opencode') {
      cmd = OPENCODE_BIN
    } else if (provider === 'ollama') {
      cmd = session_id ? `ollama run ${session_id}` : 'ollama run llama3.2'
    } else {
      cmd = 'openclaw'
    }
    if (project_path) cmd = `cd ${project_path} && ${cmd}`
  }

  console.log(`[open-terminal] Opening: ${cmd}`)

  // macOS: use osascript to open a new Terminal.app window with the command
  if (process.platform === 'darwin') {
    const escaped = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const script = `tell application "Terminal"
      activate
      do script "${escaped}"
    end tell`

    const proc = spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true })
    proc.unref()
    return res.json({ ok: true, method: 'terminal.app', command: cmd })
  }

  // Linux: try common terminal emulators
  if (process.platform === 'linux') {
    const terminals = ['gnome-terminal', 'xterm', 'konsole']
    for (const term of terminals) {
      try {
        const proc = spawn(term, ['--', 'bash', '-c', cmd], { stdio: 'ignore', detached: true })
        proc.unref()
        return res.json({ ok: true, method: term, command: cmd })
      } catch { /* try next */ }
    }
  }

  // Fallback: return the command so the frontend can copy it
  res.json({ ok: false, method: 'clipboard', command: cmd })
})

// ─── File System Bridge ─────────────────────────────────────────

// Load bridge config
let bridgeConfig = { fileSystem: { enabled: false }, auth: { apiKey: 'bridge-secret-key' } }
try {
  bridgeConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '.bridge-config.json'), 'utf8'))
  console.log('[fs-bridge] Config loaded:', {
    enabled: bridgeConfig.fileSystem?.enabled,
    roots: bridgeConfig.fileSystem?.allowedRoots?.length || 0,
    executeEnabled: bridgeConfig.fileSystem?.executeEnabled
  })
} catch { console.log('[fs-bridge] No .bridge-config.json found, file system endpoints disabled') }

/**
 * Resolve ~ to home directory and normalize path
 */
function resolvePath (p) {
  if (!p) return null
  if (p.startsWith('~/') || p === '~') {
    p = path.join(process.env.HOME, p.slice(1))
  }
  return path.resolve(p)
}

/**
 * Check if a path is within allowed roots
 */
function isPathAllowed (resolvedPath) {
  const roots = (bridgeConfig.fileSystem?.allowedRoots || []).map(r => resolvePath(r))
  if (roots.length === 0) return false
  return roots.some(root => resolvedPath.startsWith(root))
}

/**
 * Check if a path matches denied patterns
 */
function isPathDenied (resolvedPath) {
  const denied = bridgeConfig.fileSystem?.deniedPaths || []
  const basename = path.basename(resolvedPath)
  const fullPath = resolvedPath

  for (const pattern of denied) {
    // Exact basename match
    if (basename === pattern) return true
    // Glob-style match (*.key, credentials*)
    if (pattern.startsWith('*') && basename.endsWith(pattern.slice(1))) return true
    if (pattern.endsWith('*') && basename.startsWith(pattern.slice(0, -1))) return true
    // Directory match (.ssh)
    if (fullPath.includes(`/${pattern}/`) || fullPath.endsWith(`/${pattern}`)) return true
  }
  return false
}

/**
 * Auth middleware for file system endpoints
 */
function fsAuth (req, res, next) {
  if (!bridgeConfig.fileSystem?.enabled) {
    return res.status(403).json({ error: 'File system bridge is disabled' })
  }
  // Note: global bridgeAuth middleware already validates X-Bridge-Key.
  // This is defense-in-depth — also check the config-level API key if set.
  const key = req.headers['x-bridge-key']
  if (bridgeConfig.auth?.apiKey && key !== bridgeConfig.auth.apiKey) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing X-Bridge-Key header' })
  }
  next()
}

/**
 * Validate and resolve a path, returning error message or null
 */
function validatePath (rawPath) {
  if (!rawPath) return 'path parameter is required'
  const resolved = resolvePath(rawPath)
  if (!isPathAllowed(resolved)) {
    return `Path not allowed: ${rawPath} is outside configured roots`
  }
  if (isPathDenied(resolved)) {
    return `Access denied: ${rawPath} matches a blocked pattern`
  }
  return null
}

// GET /api/files/read - Read a file
app.get('/api/files/read', fsAuth, (req, res) => {
  const rawPath = req.query.path
  const limit = parseInt(req.query.limit) || 200
  const maxBytes = bridgeConfig.fileSystem?.maxReadBytes || 102400

  const err = validatePath(rawPath)
  if (err) return res.status(403).json({ error: err })

  const resolved = resolvePath(rawPath)

  try {
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: `File not found: ${rawPath}` })
    }

    const stat = fs.statSync(resolved)
    if (stat.isDirectory()) {
      return res.status(400).json({ error: `Path is a directory, not a file: ${rawPath}` })
    }

    let content = fs.readFileSync(resolved, 'utf8')
    let truncated = false

    // Truncate by bytes
    if (Buffer.byteLength(content) > maxBytes) {
      content = content.slice(0, maxBytes)
      truncated = true
    }

    // Truncate by lines
    const lines = content.split('\n')
    if (lines.length > limit) {
      content = lines.slice(0, limit).join('\n')
      truncated = true
    }

    res.json({
      path: rawPath,
      content,
      lines: Math.min(lines.length, limit),
      size_bytes: stat.size,
      truncated
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/files/write - Write a file
app.post('/api/files/write', fsAuth, (req, res) => {
  const { path: rawPath, content } = req.body
  const maxBytes = bridgeConfig.fileSystem?.maxWriteBytes || 51200

  const err = validatePath(rawPath)
  if (err) return res.status(403).json({ error: err })

  if (content === undefined || content === null) {
    return res.status(400).json({ error: 'content is required' })
  }

  if (Buffer.byteLength(content) > maxBytes) {
    return res.status(400).json({ error: `Content exceeds max write size (${maxBytes} bytes)` })
  }

  const resolved = resolvePath(rawPath)

  try {
    // Create parent directories if needed
    const dir = path.dirname(resolved)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(resolved, content, 'utf8')
    res.json({
      success: true,
      path: rawPath,
      bytes_written: Buffer.byteLength(content)
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/files/list - List directory contents
app.get('/api/files/list', fsAuth, (req, res) => {
  const rawPath = req.query.path
  const pattern = req.query.pattern || '*'
  const recursive = req.query.recursive === 'true'

  const err = validatePath(rawPath)
  if (err) return res.status(403).json({ error: err })

  const resolved = resolvePath(rawPath)

  try {
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: `Directory not found: ${rawPath}` })
    }

    const stat = fs.statSync(resolved)
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: `Path is a file, not a directory: ${rawPath}` })
    }

    const results = []

    function scanDir (dirPath, depth = 0) {
      if (depth > 5) return // Max depth safety
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        const relativePath = path.relative(resolved, fullPath)

        // Check pattern match (simple glob)
        if (pattern !== '*') {
          const ext = pattern.startsWith('*.') ? pattern.slice(1) : null
          if (ext && !entry.name.endsWith(ext)) {
            if (!entry.isDirectory()) continue
          }
        }

        if (entry.isFile()) {
          results.push({
            name: entry.name,
            path: relativePath,
            type: 'file',
            size: fs.statSync(fullPath).size
          })
        } else if (entry.isDirectory()) {
          results.push({
            name: entry.name,
            path: relativePath,
            type: 'directory'
          })
          if (recursive) {
            scanDir(fullPath, depth + 1)
          }
        }

        if (results.length >= 500) return // Safety limit
      }
    }

    scanDir(resolved)

    res.json({
      path: rawPath,
      pattern,
      recursive,
      files: results,
      count: results.length
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/files/search - Search file contents (like grep)
app.get('/api/files/search', fsAuth, (req, res) => {
  const rawPath = req.query.path
  const query = req.query.query
  const fileGlob = req.query.glob || '*'

  const err = validatePath(rawPath)
  if (err) return res.status(403).json({ error: err })

  if (!query) return res.status(400).json({ error: 'query parameter is required' })

  const resolved = resolvePath(rawPath)

  try {
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: `Directory not found: ${rawPath}` })
    }

    const results = []
    const maxResults = 50

    function searchDir (dirPath, depth = 0) {
      if (depth > 5 || results.length >= maxResults) return
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        if (results.length >= maxResults) break
        const fullPath = path.join(dirPath, entry.name)

        if (entry.isDirectory()) {
          // Skip node_modules, vendor, .git
          if (['node_modules', 'vendor', '.git', 'storage'].includes(entry.name)) continue
          searchDir(fullPath, depth + 1)
        } else if (entry.isFile()) {
          // Check glob pattern
          if (fileGlob !== '*') {
            const ext = fileGlob.startsWith('*.') ? fileGlob.slice(1) : null
            if (ext && !entry.name.endsWith(ext)) continue
          }

          // Skip binary/large files
          try {
            const stat = fs.statSync(fullPath)
            if (stat.size > 1024 * 1024) continue // Skip files > 1MB
          } catch { continue }

          try {
            const content = fs.readFileSync(fullPath, 'utf8')
            const lines = content.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (results.length >= maxResults) break
              if (lines[i].includes(query)) {
                results.push({
                  file: path.relative(resolved, fullPath),
                  line: i + 1,
                  content: lines[i].trim().slice(0, 200)
                })
              }
            }
          } catch { /* skip unreadable files */ }
        }
      }
    }

    searchDir(resolved)

    res.json({
      path: rawPath,
      query,
      glob: fileGlob,
      matches: results,
      count: results.length,
      truncated: results.length >= maxResults
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/files/execute - Execute a shell command
app.post('/api/files/execute', fsAuth, (req, res) => {
  if (!bridgeConfig.fileSystem?.executeEnabled) {
    return res.status(403).json({ error: 'Command execution is disabled in bridge config' })
  }

  const { command, cwd: rawCwd } = req.body
  const timeout = Math.min(
    parseInt(req.body.timeout) || bridgeConfig.fileSystem?.executeTimeout || 30,
    bridgeConfig.fileSystem?.executeMaxTimeout || 120
  )

  if (!command) return res.status(400).json({ error: 'command is required' })

  // Check command denylist
  const denyList = bridgeConfig.fileSystem?.executeDenyCommands || []
  for (const denied of denyList) {
    if (command.includes(denied)) {
      return res.status(403).json({ error: `Command blocked by security policy: contains "${denied}"` })
    }
  }

  // Validate cwd if provided
  let execCwd = process.env.HOME
  if (rawCwd) {
    const resolvedCwd = resolvePath(rawCwd)
    if (!isPathAllowed(resolvedCwd)) {
      return res.status(403).json({ error: `Working directory not allowed: ${rawCwd}` })
    }
    execCwd = resolvedCwd
  }

  const { execSync } = require('child_process')

  try {
    console.log(`[fs-bridge] Execute: ${command.slice(0, 100)} (cwd: ${execCwd}, timeout: ${timeout}s)`)

    const stdout = execSync(command, {
      cwd: execCwd,
      timeout: timeout * 1000,
      maxBuffer: 1024 * 1024, // 1MB
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH }
    })

    res.json({
      stdout: stdout.slice(0, 102400), // 100KB max
      stderr: '',
      exitCode: 0,
      truncated: stdout.length > 102400
    })
  } catch (e) {
    // execSync throws on non-zero exit
    res.json({
      stdout: (e.stdout || '').slice(0, 102400),
      stderr: (e.stderr || e.message || '').slice(0, 10240),
      exitCode: e.status || 1,
      truncated: false
    })
  }
})

// ─── Auto-start previously configured messaging bots ────────────

async function autoStartBots () {
  const env = readBridgeEnv()

  if (env.TELEGRAM_BOT_TOKEN) {
    console.log('[auto-start] Found saved Telegram token, starting...')
    try {
      await startTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_API_BASE_URL)
    } catch (err) {
      console.error(`[auto-start] Telegram failed: ${err.message}`)
    }
  }

  // Fetch bloq-linked Discord bots from API first (they have bloq_id context)
  const apiUrl = env.DISCORD_API_BASE_URL || 'http://localhost:8000'
  try {
    const resp = await fetch(`${apiUrl}/api/v6/channels/discord/active-bots`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    })
    if (resp.ok) {
      const data = await resp.json()
      const bots = data.bots || []
      if (bots.length > 0) {
        console.log(`[auto-start] Found ${bots.length} bloq-linked Discord bot(s) from API`)
      }
      for (const bot of bots) {
        if (discordBots.has(bot.bot_token)) continue
        try {
          await startDiscordBot(bot.bot_token, bot.bloq_id, apiUrl)
        } catch (err) {
          console.error(`[auto-start] Discord (bloq ${bot.bloq_id}) failed: ${err.message}`)
        }
      }
    }
  } catch (err) {
    console.warn(`[auto-start] Could not fetch active Discord bots from API: ${err.message}`)
  }

  // Legacy fallback: start env token only if not already running from API
  if (env.DISCORD_BOT_TOKEN && !discordBots.has(env.DISCORD_BOT_TOKEN)) {
    console.log('[auto-start] Starting Discord from env token (no API match)...')
    try {
      await startDiscord(env.DISCORD_BOT_TOKEN, env.DISCORD_API_BASE_URL)
    } catch (err) {
      console.error(`[auto-start] Discord (legacy) failed: ${err.message}`)
    }
  }

  if (env.IMESSAGE_ENABLED === 'true') {
    const driverType = env.IMESSAGE_DRIVER || 'bluebubbles'

    // Only auto-start BlueBubbles if credentials are present
    const canStart = driverType === 'bluebubbles'
      ? (env.BLUEBUBBLES_URL && env.BLUEBUBBLES_PASSWORD)
      : (driverType === 'native' || driverType === 'native-imessage')

    if (!canStart) {
      console.warn(`[auto-start] iMessage (${driverType}) skipped: missing config`)
    } else {
      console.log(`[auto-start] Found saved iMessage config (driver: ${driverType}), starting...`)
      try {
        const config = {
          enabled: true,
          driver: driverType,
          ...(driverType === 'bluebubbles' && {
            bluebubbles: {
              url: env.BLUEBUBBLES_URL,
              password: env.BLUEBUBBLES_PASSWORD,
              webhookPath: '/webhook/bluebubbles'
            }
          }),
          ...((driverType === 'native' || driverType === 'native-imessage') && {
            native: {
              pollInterval: parseInt(env.IMESSAGE_POLL_INTERVAL) || 3000
            }
          }),
          dmPolicy: env.IMESSAGE_DM_POLICY || 'open',
          groupPolicy: env.IMESSAGE_GROUP_POLICY || 'closed',
          allowlist: env.IMESSAGE_ALLOWLIST ? env.IMESSAGE_ALLOWLIST.split(',') : [],
          apiBaseUrl: env.IMESSAGE_API_BASE_URL || 'http://localhost:8000'
        }
        iMessageChannel = new IMessageChannel(config)
        await iMessageChannel.start()
      } catch (err) {
        console.error(`[auto-start] iMessage failed: ${err.message}`)
        iMessageChannel = null
      }
    }
  }
}

// ─── Auto-Start Daemon (Embedded Mode) ────────────────────────────

async function autoStartDaemon () {
  // Check for daemon credentials: env vars or ~/.iris/config.json
  const isLocalMode = process.argv.includes('--local') || process.env.IRIS_LOCAL === '1'
  const LOCAL_IRIS_URL = 'https://local.iris.freelabel.net'

  let apiKey = process.env.NODE_API_KEY
  let apiUrl = process.env.IRIS_API_URL || (isLocalMode ? LOCAL_IRIS_URL : null)
  let pusherKey = process.env.PUSHER_KEY
  let pusherCluster = process.env.PUSHER_CLUSTER

  if (!apiKey) {
    // Try ~/.iris/config.json
    try {
      const configPath = path.join(process.env.HOME, '.iris', 'config.json')
      if (fs.existsSync(configPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
        // In local mode, prefer local_api_key — skip daemon if not available
        if (isLocalMode) {
          apiKey = fileConfig.local_api_key || null
          if (!apiKey) {
            console.log('[daemon] Local mode but no local_api_key in ~/.iris/config.json — daemon not started')
            console.log('[daemon] To enable: add "local_api_key" to ~/.iris/config.json (register a node on local iris-api)')
            console.log('[daemon] Bridge is running in bridge-only mode (no daemon)')
            return
          }
        } else {
          apiKey = fileConfig.node_api_key
        }
        // Accept both field names: api_url (installer writes this) and iris_api_url (legacy)
        apiUrl = apiUrl || (isLocalMode ? LOCAL_IRIS_URL : (fileConfig.api_url || fileConfig.iris_api_url))
        pusherKey = pusherKey || fileConfig.pusher_key
        pusherCluster = pusherCluster || fileConfig.pusher_cluster
      }
    } catch { /* no config file */ }
  }

  if (!apiKey) {
    console.log('[daemon] No NODE_API_KEY found — daemon not started (bridge-only mode)')
    console.log('[daemon] To enable: set NODE_API_KEY env var or run the IRIS installer')
    return
  }

  console.log('[daemon] NODE_API_KEY detected — starting embedded daemon...')

  try {
    const { Daemon } = require('./daemon/index')
    const daemonConfig = {
      apiKey,
      apiUrl: apiUrl || 'https://iris-api.freelabel.net',
      dataDir: process.env.DAEMON_DATA_DIR || path.join(__dirname, '..', 'daemon-data'),
      flApiPath: process.env.FL_API_PATH || null,
      pusherKey,
      pusherCluster: pusherCluster || 'us2',
      externalApp: app // mount daemon routes on bridge's express app
    }

    embeddedDaemon = new Daemon(daemonConfig)
    await embeddedDaemon.start()
    console.log('[daemon] Embedded daemon started successfully — bridge + daemon on single port')

    // Alias daemon routes at root level so frontend can call /files, /processes, etc.
    // without the /daemon prefix (which is only used in embedded mode)
    const daemonPaths = ['/files', '/processes', '/capacity', '/profile', '/sessions', '/pause', '/resume', '/ingest']
    app.use((req, res, next) => {
      if (embeddedDaemon && daemonPaths.some(p => req.path === p || req.path.startsWith(p + '/'))) {
        req.url = '/daemon' + req.url
      }
      next()
    })
    console.log('[daemon] Alias routes: /files, /processes, /capacity → /daemon/*')
  } catch (err) {
    console.error(`[daemon] Failed to start embedded daemon: ${err.message}`)
    embeddedDaemon = null
  }
}

// ─── Start ───────────────────────────────────────────────────────

function fetchHealth (cb) {
  const http = require('http')
  http.get(`http://localhost:${PORT}/health`, (res) => {
    let body = ''
    res.on('data', d => { body += d })
    res.on('end', () => {
      try { cb(null, JSON.parse(body)) } catch { cb(new Error('parse')) }
    })
  }).on('error', cb)
}

function attachToExistingBridge () {
  let lastLine = ''

  function printStatus (h) {
    const daemonStatus = h.daemon?.status || 'stopped'
    const nodeId = h.daemon?.node_id ? h.daemon.node_id.substring(0, 8) + '...' : 'n/a'
    const activeTasks = h.daemon?.active_tasks ?? '?'
    const ts = new Date().toLocaleTimeString()
    const line = `[${ts}] bridge=ok  daemon=${daemonStatus}  node=${nodeId}  tasks=${activeTasks}`
    if (line !== lastLine) {
      process.stdout.write('\r\x1b[K' + line)
      lastLine = line
    }
  }

  fetchHealth((err, h) => {
    if (err || !h) {
      console.log(`\n⚡ Port ${PORT} is in use by an unknown process.`)
      console.log(`   Free it: kill $(lsof -ti:${PORT})\n`)
      process.exit(1)
      return
    }

    const nodeId = h.daemon?.node_id ? h.daemon.node_id.substring(0, 8) + '...' : 'n/a'
    console.log(`\n⚡ Bridge already running on :${PORT} — attaching as monitor`)
    console.log(`   Daemon : ${h.daemon?.status || 'stopped'}  node=${nodeId}`)
    console.log(`   Ctrl+C to detach  |  npm run bridge:kill to stop\n`)

    printStatus(h)

    const interval = setInterval(() => {
      fetchHealth((err2, h2) => {
        if (err2) {
          clearInterval(interval)
          console.log('\n[monitor] Bridge stopped.')
          process.exit(0)
        } else {
          printStatus(h2)
        }
      })
    }, 3000)

    process.on('SIGINT', () => {
      clearInterval(interval)
      console.log('\n[monitor] Detached (bridge still running).')
      process.exit(0)
    })
  })
}

const BIND_HOST = process.env.BRIDGE_BIND_HOST || '127.0.0.1'
const server = app.listen(PORT, BIND_HOST, () => {
  console.log(`\nCoding Agent Bridge on http://${BIND_HOST}:${PORT}`)
  console.log(`Auth token: ${TOKEN_PATH} (${getToken().substring(0, 8)}...)`)
  console.log(`Providers: claude (${process.env.HOME}), opencode, ollama (${OLLAMA_HOST})`)
  console.log(`\nEndpoints:`)
  console.log(`  GET  /health`)
  console.log(`  GET  /api/config`)
  console.log(`  GET  /api/environment`)
  console.log(`  GET  /api/discover`)
  console.log(`  POST /api/providers/telegram`)
  console.log(`  DELETE /api/providers/telegram`)
  console.log(`  POST /api/providers/discord`)
  console.log(`  DELETE /api/providers/discord`)
  console.log(`  POST /api/providers/imessage`)
  console.log(`  DELETE /api/providers/imessage`)
  console.log(`  POST /webhook/bluebubbles`)
  console.log(`  GET  /api/sessions/claude-code`)
  console.log(`  POST /api/sessions/claude-code`)
  console.log(`  POST /api/sessions/claude-code/:id/message`)
  console.log(`  GET  /api/sessions/opencode`)
  console.log(`  POST /api/sessions/opencode`)
  console.log(`  POST /api/sessions/opencode/:id/message`)
  console.log(`  GET  /api/sessions/opencode/:id/history`)
  console.log(`  GET  /api/ollama/models`)
  console.log(`  GET  /api/sessions/ollama`)
  console.log(`  POST /api/sessions/ollama`)
  console.log(`  POST /api/sessions/ollama/:id/message`)
  console.log(`  GET  /api/sessions/ollama/:id/history`)
  console.log(`  DELETE /api/sessions/ollama/:id`)
  console.log(`  POST /api/sessions/open-terminal`)
  console.log(`  GET  /daemon/health          (if daemon enabled)`)
  console.log(`  GET  /daemon/capacity         (if daemon enabled)`)
  console.log(`  GET  /daemon/sessions         (if daemon enabled)`)
  if (bridgeConfig.fileSystem?.enabled) {
    console.log(`  GET  /api/files/read`)
    console.log(`  POST /api/files/write`)
    console.log(`  GET  /api/files/list`)
    console.log(`  GET  /api/files/search`)
    console.log(`  POST /api/files/execute`)
  }
  console.log()

  // Load persisted Ollama sessions
  loadOllamaSessions()

  // Auto-start saved messaging bots after server is listening
  autoStartBots()

  // Auto-start daemon if credentials are available (embedded mode — one process)
  autoStartDaemon()
})

// Graceful shutdown — clean up daemon, Pusher connections, and exit cleanly
async function gracefulShutdown (signal) {
  console.log(`\n[bridge] ${signal} received — shutting down...`)
  if (embeddedDaemon) {
    try { await embeddedDaemon.shutdown(signal) } catch { /* best effort */ }
  }
  server.close(() => {
    console.log('[bridge] Server closed.')
    process.exit(0)
  })
  // Force exit after 5s if connections hang
  setTimeout(() => process.exit(0), 5000)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const { resolvePortConflict } = require('./lib/port-conflict-resolver')
    const isLocal = process.env.IRIS_LOCAL === '1' || process.argv.includes('--local')
    const result = resolvePortConflict(PORT, { isLocal })

    if (result.action === 'retry') {
      const delay = result.stopped === 'launchd' ? 2000 : 1500
      setTimeout(() => {
        server.listen(PORT, '0.0.0.0')
      }, delay)
      return
    }

    attachToExistingBridge()
  } else {
    console.error(`[bridge] Server error: ${err.message}`)
    process.exit(1)
  }
})
