#!/usr/bin/env node
/**
 * Production-slim Coding Agent Bridge
 *
 * Only boots the messaging bots (Discord, Telegram) + health endpoint.
 * Skips: Claude Code CLI, OpenCode CLI, Ollama, filesystem bridge, terminal opener.
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=xxx DISCORD_API_BASE_URL=https://apiv2.heyiris.io node production.js
 */

const express = require('express')
const path = require('path')
const fs = require('fs')

// Load .env
try {
  const envPath = process.env.BRIDGE_ENV_FILE || path.join(__dirname, '.env')
  require('dotenv').config({ path: envPath })
} catch { /* fine */ }

const app = express()
app.use(express.json({ limit: '1mb' }))

const PORT = process.env.BRIDGE_PORT || 3200
const IRIS_API_URL = process.env.IRIS_API_URL || 'https://web.heyiris.io'
const VERSION = require('./package.json').version

// ─── Messaging Bot State ────────────────────────────────────────

let telegramBot = null
let telegramBotUsername = null
const discordBots = new Map()

// ─── Telegram Bot ───────────────────────────────────────────────

async function startTelegram (token, apiBaseUrl) {
  if (telegramBot) {
    try { telegramBot.stopPolling() } catch { /* ignore */ }
    telegramBot = null
    telegramBotUsername = null
  }

  const TelegramBot = require('node-telegram-bot-api')
  const bot = new TelegramBot(token, { polling: true })
  const baseUrl = apiBaseUrl || IRIS_API_URL

  const me = await bot.getMe()
  bot.options.username = me.username
  telegramBotUsername = me.username
  console.log(`[telegram] Connected as @${me.username}`)

  bot.on('message', async (message) => {
    if (!message.text) return
    if (message.text.startsWith('/start') || message.text.startsWith('/help')) {
      await bot.sendMessage(message.chat.id, 'IRIS AI assistant is ready. Send me a message!')
      return
    }

    const chatType = message.chat.type
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

    try { await bot.sendChatAction(message.chat.id, 'typing') } catch { /* ignore */ }

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

// ─── Discord Bot (Multi-Bot) ────────────────────────────────────

async function startDiscordBot (token, bloqId, apiBaseUrl) {
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

  const baseUrl = apiBaseUrl || IRIS_API_URL

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Discord login timed out')), 30000)
    client.once('ready', () => { clearTimeout(timeout); resolve() })
    client.login(token).catch((err) => { clearTimeout(timeout); reject(err) })
  })

  const botUsername = client.user.tag
  console.log(`[discord] Connected as ${botUsername}${bloqId ? ` (bloq ${bloqId})` : ''}`)

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return
    const isDM = !message.guild
    const botMentioned = message.mentions.has(client.user)
    if (!isDM && !botMentioned) return

    // Fetch recent message history for conversation context
    let messageHistory = []
    try {
      const messages = await message.channel.messages.fetch({ limit: 15, before: message.id })
      messageHistory = messages
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map(m => ({
          id: m.id,
          content: m.content,
          author: { id: m.author.id, username: m.author.username, bot: m.author.bot },
          timestamp: m.createdAt.toISOString()
        }))
        .filter(m => m.content) // skip empty messages (embeds-only, etc.)
    } catch (err) {
      console.warn(`[discord] Could not fetch message history: ${err.message}`)
    }

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
        },
        message_history: messageHistory
      }
    }

    try {
      const resp = await fetch(`${baseUrl}/api/v6/channels/discord`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await resp.json()

      // V6 async mode: iris-api returns {type:1} and sends response directly via Discord API
      if (data.type === 1) {
        console.log(`[discord] Message forwarded to V6 engine (bloq ${bloqId}, author: ${message.author.username})`)
        return
      }

      // Legacy sync mode: fl-api returns {ok, response} — bridge posts the reply
      if (data.ok && data.response) {
        await message.reply(data.response.slice(0, 2000))
        return
      }

      // Error response from API
      if (data.error) {
        console.error(`[discord] API error (bloq ${bloqId}): ${data.error}`)
      }
    } catch (err) {
      console.error(`[discord] Forward error (bloq ${bloqId}): ${err.message}`)
    }
  })

  client.on('error', (err) => console.error(`[discord] Client error (${botUsername}): ${err.message}`))
  discordBots.set(token, { client, bloqId, botUsername, apiBaseUrl: baseUrl })
  return botUsername
}

function stopDiscordBot (token) {
  const entry = discordBots.get(token)
  if (entry) {
    try { entry.client.destroy() } catch { /* ignore */ }
    discordBots.delete(token)
    console.log(`[discord] Stopped ${entry.botUsername}`)
    return true
  }
  return false
}

// ─── Health ─────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: VERSION,
    mode: 'production',
    uptime_seconds: Math.floor(process.uptime()),
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
        : { status: 'stopped' }
    }
  })
})

// ─── Dynamic bot management (API can add/remove bots at runtime) ─

app.post('/api/providers/discord', async (req, res) => {
  const { token, api_base_url, bloq_id } = req.body
  if (!token) return res.status(400).json({ error: 'token is required' })
  try {
    const username = await startDiscordBot(token, bloq_id || null, api_base_url)
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
    for (const [t, entry] of discordBots) {
      if (entry.bloqId === bloq_id) { stopDiscordBot(t); break }
    }
  } else if (token) {
    stopDiscordBot(token)
  } else {
    for (const [t] of discordBots) stopDiscordBot(t)
  }
  res.json({ status: 'stopped' })
})

app.post('/api/providers/telegram', async (req, res) => {
  const { token, api_base_url } = req.body
  if (!token) return res.status(400).json({ error: 'token is required' })
  try {
    const username = await startTelegram(token, api_base_url)
    res.json({ status: 'running', bot_username: username })
  } catch (err) {
    console.error(`[telegram] Start failed: ${err.message}`)
    res.status(400).json({ error: `Failed to start Telegram bot: ${err.message}` })
  }
})

app.delete('/api/providers/telegram', (req, res) => {
  if (telegramBot) {
    try { telegramBot.stopPolling() } catch { /* ignore */ }
    telegramBot = null
    telegramBotUsername = null
  }
  res.json({ status: 'stopped' })
})

// ─── Auto-start bots ───────────────────────────────────────────

async function autoStartBots () {
  const apiUrl = process.env.DISCORD_API_BASE_URL || IRIS_API_URL

  // Fetch bloq-linked Discord bots from the API
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

  // Fallback: env token
  if (process.env.DISCORD_BOT_TOKEN && !discordBots.has(process.env.DISCORD_BOT_TOKEN)) {
    console.log('[auto-start] Starting Discord from env token...')
    try {
      await startDiscordBot(process.env.DISCORD_BOT_TOKEN, process.env.DISCORD_BLOQ_ID ? parseInt(process.env.DISCORD_BLOQ_ID) : null, apiUrl)
    } catch (err) {
      console.error(`[auto-start] Discord (env) failed: ${err.message}`)
    }
  }

  // Telegram
  if (process.env.TELEGRAM_BOT_TOKEN) {
    console.log('[auto-start] Starting Telegram...')
    try {
      await startTelegram(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_API_BASE_URL || apiUrl)
    } catch (err) {
      console.error(`[auto-start] Telegram failed: ${err.message}`)
    }
  }
}

// ─── Start ──────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nCoding Agent Bridge (production) v${VERSION}`)
  console.log(`Listening on http://0.0.0.0:${PORT}`)
  console.log(`IRIS API: ${IRIS_API_URL}\n`)
  autoStartBots()
})
