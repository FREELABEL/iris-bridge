/**
 * PusherClient — Subscribes to a private Pusher channel
 * to receive real-time task dispatch events from the cloud.
 */

class PusherClient {
  constructor (pusherKey, cluster, channel, cloudClient) {
    this.pusherKey = pusherKey
    this.cluster = cluster
    this.channelName = channel
    this.cloudClient = cloudClient
    this.pusher = null
    this.channel = null
    this.onTaskCallback = null
  }

  async connect () {
    // Dynamic import — pusher-js is a dependency
    const Pusher = require('pusher-js')

    this.pusher = new Pusher(this.pusherKey, {
      cluster: this.cluster,
      // Custom authorizer that uses our node API key
      authorizer: (channel) => ({
        authorize: async (socketId, callback) => {
          try {
            const result = await this.cloudClient.post('/api/v6/nodes/broadcasting/auth', {
              socket_id: socketId,
              channel_name: channel.name
            })
            callback(null, result)
          } catch (err) {
            callback(err, null)
          }
        }
      })
    })

    this.channel = this.pusher.subscribe(this.channelName)

    return new Promise((resolve, reject) => {
      this.channel.bind('pusher:subscription_succeeded', () => {
        console.log(`[pusher] Subscribed to ${this.channelName}`)
        resolve()
      })

      this.channel.bind('pusher:subscription_error', (err) => {
        console.error(`[pusher] Subscription FAILED for ${this.channelName}:`, err?.status || err)
        // Don't reject — fall back to polling
        resolve()
      })

      // Listen for task dispatch events
      this.channel.bind('task.dispatched', (data) => {
        if (this.onTaskCallback) {
          this.onTaskCallback(data)
        }
      })

      // Connection state logging
      this.pusher.connection.bind('state_change', (states) => {
        if (states.current === 'disconnected') {
          console.log('[pusher] Disconnected — will reconnect automatically')
        } else if (states.current === 'connected') {
          console.log('[pusher] Connected')
        }
      })

      // Timeout after 10s
      setTimeout(() => resolve(), 10000)
    })
  }

  onTaskDispatched (callback) {
    this.onTaskCallback = callback
  }

  disconnect () {
    if (this.pusher) {
      this.pusher.disconnect()
      this.pusher = null
    }
  }
}

module.exports = { PusherClient }
