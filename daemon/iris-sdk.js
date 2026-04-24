/**
 * @iris/sdk — Node.js SDK for the IRIS Platform
 *
 * Thin wrapper around the IRIS REST API. Designed to run on Hive nodes
 * where only Node.js is available (no PHP, no Docker, no iris-api).
 *
 * Auth: Reads from ~/.iris/sdk/.env (written by `iris-login` installer)
 * or accepts explicit { apiKey, apiUrl } in constructor.
 *
 * Usage:
 *   const IRIS = require('./iris-sdk')
 *   const iris = new IRIS()  // auto-reads ~/.iris/sdk/.env
 *
 *   const leads = await iris.leads.list({ type: 'competitor' })
 *   const brand = await iris.tools.invoke('websiteBrandExtractor', { url: 'https://stripe.com' })
 *   await iris.leads.update(123, { contact_info: { brand_theme: brand } })
 *
 * Every method returns parsed JSON. Errors throw with status code + message.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

// ============================================================================
// SDK Client
// ============================================================================

class IRIS {
  /**
   * @param {Object} opts
   * @param {string} [opts.apiKey] - API key (defaults to ~/.iris/sdk/.env IRIS_API_KEY)
   * @param {string} [opts.apiUrl] - fl-api base URL (defaults to https://raichu.heyiris.io)
   * @param {string} [opts.irisApiUrl] - iris-api base URL (defaults to https://heyiris.io)
   * @param {number} [opts.userId] - User ID (defaults to ~/.iris/sdk/.env IRIS_USER_ID)
   * @param {number} [opts.timeout] - Request timeout in ms (default: 30000)
   */
  constructor (opts = {}) {
    const env = this._readEnv()

    this.apiKey = opts.apiKey || env.IRIS_API_KEY || process.env.IRIS_API_KEY || ''
    this.apiUrl = (opts.apiUrl || env.IRIS_FL_API_URL || process.env.IRIS_FL_API_URL || 'https://raichu.heyiris.io').replace(/\/$/, '')
    this.irisApiUrl = (opts.irisApiUrl || env.IRIS_API_URL || process.env.IRIS_API_URL || 'https://heyiris.io').replace(/\/$/, '')
    this.userId = opts.userId || parseInt(env.IRIS_USER_ID || process.env.IRIS_USER_ID || '0', 10)
    this.timeout = opts.timeout || 30000

    // Bind resource namespaces
    this.leads = new LeadsResource(this)
    this.tools = new ToolsResource(this)
    this.bloqs = new BloqsResource(this)
    this.pages = new PagesResource(this)
    this.schedule = new ScheduleResource(this)
    this.agents = new AgentsResource(this)
  }

  /** Read ~/.iris/sdk/.env */
  _readEnv () {
    const envPath = path.join(os.homedir(), '.iris', 'sdk', '.env')
    const env = {}
    try {
      const text = fs.readFileSync(envPath, 'utf-8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq > 0) {
          env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
        }
      }
    } catch {}
    return env
  }

  /**
   * Core fetch wrapper — handles auth, JSON parsing, errors.
   * @param {string} urlPath - API path (e.g., /api/v1/leads)
   * @param {Object} [options] - fetch options
   * @param {string} [base] - base URL override (defaults to this.apiUrl)
   * @returns {Promise<any>} parsed JSON response
   */
  async fetch (urlPath, options = {}, base) {
    const url = `${base || this.apiUrl}${urlPath}`
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {})
    }
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const res = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal
      })

      clearTimeout(timer)

      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          const body = await res.json()
          msg = body.error || body.message || msg
          if (body.errors) {
            msg += ': ' + Object.entries(body.errors)
              .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
              .join('; ')
          }
        } catch {}
        const err = new Error(msg)
        err.status = res.status
        throw err
      }

      const text = await res.text()
      if (!text) return {}
      return JSON.parse(text)
    } catch (err) {
      clearTimeout(timer)
      if (err.name === 'AbortError') {
        const timeout = new Error(`Request timed out after ${this.timeout}ms: ${urlPath}`)
        timeout.status = 408
        throw timeout
      }
      throw err
    }
  }

  /** Shorthand: GET */
  async get (path, params, base) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return this.fetch(`${path}${qs}`, {}, base)
  }

  /** Shorthand: POST */
  async post (path, body, base) {
    return this.fetch(path, { method: 'POST', body: JSON.stringify(body) }, base)
  }

  /** Shorthand: PUT */
  async put (path, body, base) {
    return this.fetch(path, { method: 'PUT', body: JSON.stringify(body) }, base)
  }

  /** Shorthand: DELETE */
  async del (path, base) {
    return this.fetch(path, { method: 'DELETE' }, base)
  }

  /** User-scoped fl-api path */
  _userPath (resource) {
    return `/api/v1/users/${this.userId}/${resource}`
  }
}

// ============================================================================
// Resource: Leads
// ============================================================================

class LeadsResource {
  constructor (client) { this.c = client }

  /** List leads. Options: { status, type, source, company, limit } */
  async list (opts = {}) {
    const params = {}
    if (opts.status) params.status = opts.status
    if (opts.type) params.lead_type = opts.type
    if (opts.source) params.source = opts.source
    if (opts.company) params.company = opts.company
    if (opts.limit) params.per_page = String(opts.limit)
    const res = await this.c.get(this.c._userPath('leads'), params)
    return res.data || res
  }

  /** Get lead by ID */
  async get (id) {
    const res = await this.c.get(this.c._userPath(`leads/${id}`))
    return res.data || res
  }

  /** Search leads by query string */
  async search (query, opts = {}) {
    return this.list({ ...opts, q: query })
  }

  /** Create a new lead */
  async create (data) {
    const res = await this.c.post(this.c._userPath('leads'), data)
    return res.data || res
  }

  /** Update a lead */
  async update (id, data) {
    const res = await this.c.put(this.c._userPath(`leads/${id}`), data)
    return res.data || res
  }

  /** Delete a lead */
  async delete (id) {
    return this.c.del(this.c._userPath(`leads/${id}`))
  }

  /** Add a note to a lead */
  async addNote (id, data) {
    const payload = typeof data === 'string' ? { content: data, type: 'general' } : data
    const res = await this.c.post(this.c._userPath(`leads/${id}/notes`), payload)
    return res.data || res
  }

  /** List competitors (leads with type=competitor) */
  async competitors (opts = {}) {
    return this.list({ ...opts, type: 'competitor' })
  }

  /** Add a competitor */
  async addCompetitor (data) {
    return this.create({ ...data, lead_type: 'competitor', source: 'competitor_intelligence' })
  }
}

// ============================================================================
// Resource: Tools
// ============================================================================

class ToolsResource {
  constructor (client) { this.c = client }

  /** List available tools */
  async list () {
    const res = await this.c.get('/api/v1/tools/list')
    return res.data || res
  }

  /**
   * Invoke a tool by name with params.
   * @param {string} name - Tool name (e.g., 'seoRankTracker')
   * @param {Object} params - Tool parameters
   * @returns {Promise<any>} Tool result (parsed JSON)
   */
  async invoke (name, params = {}) {
    const res = await this.c.post('/api/v1/tools/invoke', { tool: name, params })
    // Tool results are often JSON strings inside the response
    const result = res.result || res.data || res
    if (typeof result === 'string') {
      try { return JSON.parse(result) } catch {}
    }
    return result
  }
}

// ============================================================================
// Resource: Bloqs (Knowledge Bases)
// ============================================================================

class BloqsResource {
  constructor (client) { this.c = client }

  /** List bloqs */
  async list (opts = {}) {
    const params = {}
    if (opts.limit) params.per_page = String(opts.limit)
    const res = await this.c.get(this.c._userPath('bloqs'), params)
    return res.data || res
  }

  /** Get a bloq by ID */
  async get (id) {
    const res = await this.c.get(this.c._userPath(`bloqs/${id}`))
    return res.data || res
  }

  /** Add an item to a bloq list */
  async addItem (bloqId, listId, data) {
    const payload = typeof data === 'string' ? { content: data } : data
    const res = await this.c.post(this.c._userPath(`bloqs/${bloqId}/lists/${listId}/items`), payload)
    return res.data || res
  }

  /** Search bloq items */
  async search (bloqId, query) {
    const res = await this.c.get(this.c._userPath(`bloqs/${bloqId}/items`), { q: query })
    return res.data || res
  }
}

// ============================================================================
// Resource: Pages (Genesis Page Builder)
// ============================================================================

class PagesResource {
  constructor (client) { this.c = client }

  /** List pages */
  async list (opts = {}) {
    const params = {}
    if (opts.status) params.status = opts.status
    if (opts.limit) params.per_page = String(opts.limit)
    const res = await this.c.get('/api/v1/pages', params)
    return res.data || res
  }

  /** Get page by slug */
  async getBySlug (slug) {
    const res = await this.c.get(`/api/v1/pages/by-slug/${slug}`, { include_json: 'true' })
    return res.data || res
  }

  /** Create a page */
  async create (data) {
    const res = await this.c.post('/api/v1/pages', data)
    return res.data || res
  }

  /** Update a page */
  async update (id, data) {
    const res = await this.c.put(`/api/v1/pages/${id}`, data)
    return res.data || res
  }

  /** Publish a page */
  async publish (id) {
    const res = await this.c.post(`/api/v1/pages/${id}/publish`)
    return res.data || res
  }
}

// ============================================================================
// Resource: Schedule
// ============================================================================

class ScheduleResource {
  constructor (client) { this.c = client }

  /** List scheduled jobs */
  async list (opts = {}) {
    const params = {}
    if (opts.limit) params.per_page = String(opts.limit)
    if (opts.agentId) params.agent_id = String(opts.agentId)
    const res = await this.c.get(this.c._userPath('bloqs/scheduled-jobs'), params)
    return res.data || res
  }

  /** Create a scheduled job */
  async create (data) {
    const res = await this.c.post(this.c._userPath('bloqs/scheduled-jobs'), data)
    return res.data || res
  }

  /** Trigger a job to run now */
  async run (id) {
    const res = await this.c.post(this.c._userPath(`bloqs/scheduled-jobs/${id}/run`), {})
    return res.data || res
  }

  /** Delete a scheduled job */
  async delete (id) {
    return this.c.del(this.c._userPath(`bloqs/scheduled-jobs/${id}`))
  }
}

// ============================================================================
// Resource: Agents
// ============================================================================

class AgentsResource {
  constructor (client) { this.c = client }

  /** List agents */
  async list (opts = {}) {
    const params = {}
    if (opts.limit) params.per_page = String(opts.limit)
    const res = await this.c.get(this.c._userPath('bloqs/agents'), params)
    return res.data || res
  }

  /** Get agent by ID */
  async get (id) {
    const res = await this.c.get(this.c._userPath(`bloqs/agents/${id}`))
    return res.data || res
  }

  /** Chat with an agent */
  async chat (agentId, message, opts = {}) {
    const res = await this.c.post('/api/v6/chat/execute', {
      query: message,
      agent_id: agentId,
      user_id: this.c.userId,
      ...opts
    }, this.c.irisApiUrl)
    return res
  }
}

// ============================================================================
// Export
// ============================================================================

module.exports = IRIS
