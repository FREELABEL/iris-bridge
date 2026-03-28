/**
 * iMessage Channel Driver
 *
 * Provides iMessage integration following OpenClaw's channel abstraction pattern.
 * Supports multiple backends:
 * - BlueBubbles: Real-time webhooks + REST API (remote/Docker setups)
 * - Native macOS: chat.db polling + AppleScript sending (zero deps, Mac-only)
 * - imsg CLI: SSH + AppleScript + chat.db polling (future)
 */

const BlueBubblesDriver = require('../drivers/bluebubbles')
const NativeIMessageDriver = require('../drivers/native-imessage')
const EventEmitter = require('events')
const http = require('http')
const https = require('https')

class IMessageChannel extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this.driver = null
    this.isRunning = false
    this.messageCount = 0
    this.errorCount = 0
  }

  /**
   * Start the iMessage channel
   */
  async start() {
    console.log('[imessage] Starting iMessage channel...')

    // Validate config
    if (!this.config.driver) {
      throw new Error('No driver specified (native, bluebubbles, or imsg-cli)')
    }

    // Choose and initialize driver
    const driverType = this.config.driver

    if (driverType === 'bluebubbles') {
      if (!this.config.bluebubbles?.url || !this.config.bluebubbles?.password) {
        throw new Error('BlueBubbles driver requires url and password')
      }
      this.driver = new BlueBubblesDriver(this.config.bluebubbles)
    } else if (driverType === 'native' || driverType === 'native-imessage') {
      if (process.platform !== 'darwin') {
        throw new Error('native-imessage driver requires macOS')
      }
      this.driver = new NativeIMessageDriver(this.config.native || {})
    } else if (driverType === 'imsg-cli') {
      // TODO: Implement imsg CLI driver
      throw new Error('imsg-cli driver not yet implemented')
    } else {
      throw new Error(`Unknown driver: ${driverType}`)
    }

    // Set up message handler
    this.driver.on('message', (event) => this.handleInbound(event))

    // Start driver
    await this.driver.start()
    this.isRunning = true

    console.log(`[imessage] ✓ Channel started with driver: ${driverType}`)

    return {
      driver: driverType,
      status: 'running'
    }
  }

  /**
   * Stop the iMessage channel
   */
  async stop() {
    console.log('[imessage] Stopping iMessage channel...')

    if (this.driver) {
      await this.driver.stop()
      this.driver.removeAllListeners()
      this.driver = null
    }

    this.isRunning = false
    console.log('[imessage] ✓ Channel stopped')
  }

  /**
   * Handle inbound message from driver
   */
  async handleInbound(event) {
    try {
      // Normalize to channel event format
      const normalized = {
        channel: 'imessage',
        conversation_id: event.chatGuid,
        sender_id: event.sender,
        sender_name: event.senderName,
        message_id: event.messageId,
        text: event.text,
        attachments: event.attachments || [],
        timestamp: event.timestamp,
        is_group: event.isGroup || false,
        group_name: event.groupName || null,
        is_from_me: event.isFromMe || false
      }

      console.log(
        `[imessage] New message from ${normalized.sender_id} in ${normalized.is_group ? 'group' : 'DM'}: "${normalized.text.slice(0, 50)}..."`
      )

      // Apply policies
      if (!this.shouldProcess(normalized)) {
        console.log(`[imessage] Ignored by policy: ${normalized.sender_id}`)
        return
      }

      // Forward to IRIS API
      await this.forwardToAPI(normalized)

      this.messageCount++
    } catch (err) {
      console.error(`[imessage] Handle inbound error: ${err.message}`)
      this.errorCount++
    }
  }

  /**
   * Check if message should be processed based on policies
   */
  shouldProcess(event) {
    // Skip messages from ourselves
    if (event.is_from_me) {
      return false
    }

    // Skip empty messages
    if (!event.text?.trim() && event.attachments.length === 0) {
      return false
    }

    // Check DM policy
    if (!event.is_group) {
      const dmPolicy = this.config.dmPolicy || 'open'

      if (dmPolicy === 'pairing') {
        // Only process if sender is in allowlist
        const allowlist = this.config.allowlist || []
        return allowlist.includes(event.sender_id)
      }

      // dmPolicy = 'open': process all DMs
      return true
    }

    // Check group policy
    const groupPolicy = this.config.groupPolicy || 'closed'

    if (groupPolicy === 'closed') {
      return false
    }

    if (groupPolicy === 'allowlist') {
      const allowlist = this.config.allowlist || []
      return allowlist.includes(event.conversation_id)
    }

    // groupPolicy = 'open': process all groups
    return true
  }

  /**
   * Forward normalized event to IRIS API
   */
  async forwardToAPI(event) {
    const apiUrl = this.config.apiBaseUrl || 'http://localhost:8000'
    const endpoint = `${apiUrl}/api/v6/channels/imessage`

    try {
      console.log(`[imessage] Forwarding to ${endpoint}...`)

      const data = await this._postJSON(endpoint, event)

      if (data.ok && data.response) {
        // Send reply via driver
        await this.sendReply(event.conversation_id, data.response)
      } else if (data.error) {
        console.error(`[imessage] API error: ${data.error}`)
      }
    } catch (err) {
      console.error(`[imessage] Forward error: ${err.message}`)
      // Don't auto-reply on error — it can create infinite loops
      // when the driver picks up its own outbound error messages
    }
  }

  /**
   * Send a reply message
   */
  async sendReply(conversationId, text) {
    if (!this.driver) {
      throw new Error('Driver not initialized')
    }

    try {
      // Split long messages (iMessage limit is ~20,000 chars but let's be safe)
      const maxLength = 4096
      if (text.length > maxLength) {
        const chunks = this.splitMessage(text, maxLength)
        console.log(`[imessage] Splitting into ${chunks.length} chunks`)

        for (let i = 0; i < chunks.length; i++) {
          await this.driver.sendMessage(conversationId, chunks[i])
          if (i < chunks.length - 1) {
            // Small delay between chunks
            await new Promise(resolve => setTimeout(resolve, 500))
          }
        }
      } else {
        await this.driver.sendMessage(conversationId, text)
      }

      console.log(`[imessage] ✓ Reply sent to ${conversationId.slice(0, 30)}...`)
    } catch (err) {
      console.error(`[imessage] Send reply error: ${err.message}`)
      throw err
    }
  }

  /**
   * Split long message into chunks at natural breakpoints
   */
  splitMessage(text, maxLength) {
    const chunks = []
    let remaining = text

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining)
        break
      }

      // Try to split at paragraph, sentence, or word boundary
      let splitIndex = maxLength

      // Look for paragraph break
      const paragraphIndex = remaining.lastIndexOf('\n\n', maxLength)
      if (paragraphIndex > maxLength * 0.5) {
        splitIndex = paragraphIndex + 2
      } else {
        // Look for sentence break
        const sentenceIndex = Math.max(
          remaining.lastIndexOf('. ', maxLength),
          remaining.lastIndexOf('! ', maxLength),
          remaining.lastIndexOf('? ', maxLength)
        )
        if (sentenceIndex > maxLength * 0.5) {
          splitIndex = sentenceIndex + 2
        } else {
          // Look for word break
          const wordIndex = remaining.lastIndexOf(' ', maxLength)
          if (wordIndex > maxLength * 0.5) {
            splitIndex = wordIndex + 1
          }
        }
      }

      chunks.push(remaining.slice(0, splitIndex))
      remaining = remaining.slice(splitIndex)
    }

    return chunks
  }

  /**
   * POST JSON using Node built-in http/https (no fetch dependency)
   */
  _postJSON(url, body) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const transport = parsed.protocol === 'https:' ? https : http
      const payload = JSON.stringify(body)

      const req = transport.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 30000
      }, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`API returned ${res.statusCode}: ${data.slice(0, 200)}`))
          }
          try { resolve(JSON.parse(data)) }
          catch { resolve({ raw: data }) }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })
      req.write(payload)
      req.end()
    })
  }

  /**
   * Get channel status
   */
  getStatus() {
    return {
      channel: 'imessage',
      enabled: this.config.enabled,
      running: this.isRunning,
      driver: this.config.driver,
      conversations: this.driver?.getConversationCount() || 0,
      messages_processed: this.messageCount,
      errors: this.errorCount,
      policies: {
        dm_policy: this.config.dmPolicy || 'open',
        group_policy: this.config.groupPolicy || 'closed',
        allowlist_size: this.config.allowlist?.length || 0
      }
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    if (!this.driver) {
      return false
    }

    try {
      if (this.driver.healthCheck) {
        return await this.driver.healthCheck()
      }
      return this.isRunning
    } catch (err) {
      return false
    }
  }
}

module.exports = IMessageChannel
