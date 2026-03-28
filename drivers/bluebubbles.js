/**
 * BlueBubbles Driver for iMessage
 *
 * Communicates with BlueBubbles server running on Mac:
 * - Receives webhooks when new messages arrive
 * - Sends messages via REST API
 * - Handles attachments and media
 * - Supports group chats
 */

const EventEmitter = require('events')

class BlueBubblesDriver extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this.baseUrl = config.url  // e.g., http://192.168.1.100:1234
    this.password = config.password
    this.webhookPath = config.webhookPath || '/webhook/bluebubbles'
    this.conversations = new Map()
    this.serverInfo = null
  }

  /**
   * Start the driver - test connection and get server info
   */
  async start() {
    console.log(`[bluebubbles] Connecting to ${this.baseUrl}...`)

    try {
      // Test connection
      const response = await fetch(`${this.baseUrl}/api/v1/server/info`, {
        headers: {
          'Authorization': this.password
        }
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      this.serverInfo = await response.json()
      const version = this.serverInfo.data?.version || 'unknown'
      const macosVersion = this.serverInfo.data?.os_version || 'unknown'

      console.log(`[bluebubbles] ✓ Connected to BlueBubbles v${version}`)
      console.log(`[bluebubbles]   macOS: ${macosVersion}`)
      console.log(`[bluebubbles]   Webhook: ${this.webhookPath}`)

      // Get initial chat list
      await this.loadChats()

      return true
    } catch (err) {
      console.error(`[bluebubbles] ✗ Connection failed: ${err.message}`)
      throw new Error(`BlueBubbles connection failed: ${err.message}`)
    }
  }

  /**
   * Stop the driver - cleanup
   */
  async stop() {
    console.log('[bluebubbles] Stopping driver...')
    this.conversations.clear()
    this.serverInfo = null
  }

  /**
   * Load chat list from BlueBubbles
   */
  async loadChats() {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/chat?limit=50&offset=0`, {
        headers: {
          'Authorization': this.password
        }
      })

      if (!response.ok) {
        console.warn(`[bluebubbles] Failed to load chats: ${response.status}`)
        return
      }

      const data = await response.json()
      const chats = data.data || []

      chats.forEach(chat => {
        this.conversations.set(chat.guid, {
          guid: chat.guid,
          displayName: chat.displayName,
          isGroup: chat.participants?.length > 1
        })
      })

      console.log(`[bluebubbles] Loaded ${this.conversations.size} conversations`)
    } catch (err) {
      console.error(`[bluebubbles] Failed to load chats: ${err.message}`)
    }
  }

  /**
   * Handle incoming webhook from BlueBubbles
   * Called by main server when BB POSTs to /webhook/bluebubbles
   */
  handleWebhook(payload) {
    const { type, data } = payload

    console.log(`[bluebubbles] Webhook: ${type}`)

    if (type === 'new-message') {
      const event = this.normalizeMessage(data)

      // Skip if from ourselves
      if (event.isFromMe) {
        console.log(`[bluebubbles] Skipping outbound message`)
        return
      }

      // Track conversation
      if (event.chatGuid) {
        this.conversations.set(event.chatGuid, {
          guid: event.chatGuid,
          displayName: event.groupName || event.sender,
          isGroup: event.isGroup
        })
      }

      // Emit to channel handler
      this.emit('message', event)
    } else if (type === 'updated-message') {
      // Handle edited messages
      console.log(`[bluebubbles] Message updated: ${data.guid}`)
    } else if (type === 'group-name-change') {
      // Handle group name changes
      console.log(`[bluebubbles] Group name changed: ${data.newName}`)
    } else {
      console.log(`[bluebubbles] Unhandled webhook type: ${type}`)
    }
  }

  /**
   * Normalize BlueBubbles webhook format to our standard format
   */
  normalizeMessage(data) {
    // Extract chat GUID (BlueBubbles sends array of chats)
    const chat = data.chats?.[0]
    const chatGuid = chat?.guid || data.chatGuid

    // Extract sender info
    const handle = data.handle || {}
    const sender = handle.address || handle.id || 'unknown'

    // Extract text (handle attributed bodies for group mentions)
    let text = data.text || ''

    // If has attributedBody, try to parse it (may contain rich text)
    if (data.attributedBody && data.attributedBody.length > 0) {
      try {
        const attributed = data.attributedBody[0]
        if (attributed.string) {
          text = attributed.string
        }
      } catch (err) {
        console.warn(`[bluebubbles] Failed to parse attributedBody: ${err.message}`)
      }
    }

    // Handle attachments
    const attachments = (data.attachments || []).map(a => ({
      guid: a.guid,
      name: a.transferName,
      mimeType: a.mimeType,
      size: a.totalBytes,
      url: `${this.baseUrl}/api/v1/attachment/${a.guid}/download`,
      width: a.width,
      height: a.height
    }))

    // Determine if group
    const isGroup = chat?.isGroup || (chat?.participants?.length > 1) || false
    const groupName = isGroup ? (chat?.displayName || 'Group Chat') : null

    return {
      chatGuid,
      messageId: data.guid,
      sender,
      senderName: handle.unformattedId || sender,
      text,
      attachments,
      timestamp: data.dateCreated || Date.now(),
      isGroup,
      groupName,
      isFromMe: data.isFromMe || false,
      hasAttachments: attachments.length > 0
    }
  }

  /**
   * Send a text message via BlueBubbles API
   */
  async sendMessage(chatGuid, text, options = {}) {
    try {
      const payload = {
        chatGuid,
        message: text,
        method: options.method || 'apple-script',  // or 'private-api'
        tempGuid: `temp-${Date.now()}`
      }

      // Add subject if provided (for group chats)
      if (options.subject) {
        payload.subject = options.subject
      }

      console.log(`[bluebubbles] Sending to ${chatGuid.slice(0, 30)}...`)

      const response = await fetch(`${this.baseUrl}/api/v1/message/text`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.password
        },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
      }

      const result = await response.json()

      console.log(`[bluebubbles] ✓ Sent message (${text.length} chars)`)

      return result
    } catch (err) {
      console.error(`[bluebubbles] ✗ Send failed: ${err.message}`)
      throw err
    }
  }

  /**
   * Send a message with attachment (image, video, etc.)
   */
  async sendAttachment(chatGuid, attachmentPath, text = '', options = {}) {
    try {
      const FormData = require('form-data')
      const fs = require('fs')
      const path = require('path')

      const form = new FormData()
      form.append('chatGuid', chatGuid)
      form.append('method', options.method || 'apple-script')
      form.append('tempGuid', `temp-${Date.now()}`)

      if (text) {
        form.append('message', text)
      }

      // Read file and append
      const fileName = path.basename(attachmentPath)
      const fileStream = fs.createReadStream(attachmentPath)
      form.append('attachment', fileStream, fileName)

      console.log(`[bluebubbles] Sending attachment: ${fileName}`)

      const response = await fetch(`${this.baseUrl}/api/v1/message/attachment`, {
        method: 'POST',
        headers: {
          'Authorization': this.password,
          ...form.getHeaders()
        },
        body: form
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
      }

      const result = await response.json()

      console.log(`[bluebubbles] ✓ Sent attachment: ${fileName}`)

      return result
    } catch (err) {
      console.error(`[bluebubbles] ✗ Attachment send failed: ${err.message}`)
      throw err
    }
  }

  /**
   * Download an attachment from BlueBubbles
   */
  async downloadAttachment(attachmentGuid, outputPath) {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/attachment/${attachmentGuid}/download`, {
        headers: {
          'Authorization': this.password
        }
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const fs = require('fs')
      const fileStream = fs.createWriteStream(outputPath)

      await new Promise((resolve, reject) => {
        response.body.pipe(fileStream)
        response.body.on('error', reject)
        fileStream.on('finish', resolve)
      })

      console.log(`[bluebubbles] ✓ Downloaded attachment to ${outputPath}`)

      return outputPath
    } catch (err) {
      console.error(`[bluebubbles] ✗ Download failed: ${err.message}`)
      throw err
    }
  }

  /**
   * Get chat details by GUID
   */
  async getChatDetails(chatGuid) {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/chat/${encodeURIComponent(chatGuid)}`, {
        headers: {
          'Authorization': this.password
        }
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()
      return data.data
    } catch (err) {
      console.error(`[bluebubbles] Failed to get chat details: ${err.message}`)
      return null
    }
  }

  /**
   * Get recent messages from a chat
   */
  async getChatMessages(chatGuid, limit = 25) {
    try {
      const response = await fetch(
        `${this.baseUrl}/api/v1/chat/${encodeURIComponent(chatGuid)}/message?limit=${limit}&offset=0`,
        {
          headers: {
            'Authorization': this.password
          }
        }
      )

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()
      return data.data || []
    } catch (err) {
      console.error(`[bluebubbles] Failed to get messages: ${err.message}`)
      return []
    }
  }

  /**
   * Mark message as read
   */
  async markAsRead(chatGuid) {
    try {
      await fetch(`${this.baseUrl}/api/v1/chat/${encodeURIComponent(chatGuid)}/read`, {
        method: 'POST',
        headers: {
          'Authorization': this.password
        }
      })

      console.log(`[bluebubbles] ✓ Marked chat as read`)
    } catch (err) {
      console.error(`[bluebubbles] Failed to mark as read: ${err.message}`)
    }
  }

  /**
   * Get conversation count
   */
  getConversationCount() {
    return this.conversations.size
  }

  /**
   * Get server info
   */
  getServerInfo() {
    return this.serverInfo
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/server/ping`, {
        headers: {
          'Authorization': this.password
        },
        signal: AbortSignal.timeout(5000)
      })

      return response.ok
    } catch (err) {
      return false
    }
  }
}

module.exports = BlueBubblesDriver
