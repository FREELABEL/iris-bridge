/**
 * Reference Manager — manages the lifecycle of git repo references.
 * Clones repos, indexes files into a local vector store, supports semantic search.
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { embed, chunkAndEmbed, ensureModel, DEFAULT_MODEL } = require('./embeddings')
const VectorStore = require('./vector-store')

// File extensions to index
const INDEXABLE_EXTENSIONS = new Set([
  '.js', '.ts', '.py', '.php', '.md', '.go', '.rs', '.java',
  '.vue', '.jsx', '.tsx', '.css', '.html', '.yaml', '.yml',
  '.json', '.sh', '.sql', '.rb', '.swift', '.kt', '.c', '.cpp',
  '.h', '.hpp', '.cs', '.ex', '.exs', '.zig', '.lua', '.toml'
])

// Directories to skip
const SKIP_DIRS = new Set([
  'node_modules', 'vendor', '.git', 'dist', 'build', '__pycache__',
  '.next', '.nuxt', 'coverage', '.cache', '.turbo', 'target',
  'bower_components', '.venv', 'venv', 'env'
])

const MAX_FILE_SIZE = 500 * 1024 // 500KB
const MAX_REFERENCES = 10
const CONFIG_FILE = 'references.json'

class ReferenceManager {
  /**
   * @param {string} basePath - Directory for all reference data (e.g. /data/references/ or ~/.iris/bridge/references/)
   */
  constructor (basePath) {
    this.basePath = basePath
    this._config = null
    this._stores = new Map() // name → VectorStore
    this._indexingStatus = new Map() // name → { status, progress, error }
  }

  /** Ensure base directory exists and load config */
  _ensureDir () {
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true })
    }
  }

  /** Load config from disk */
  _loadConfig () {
    if (this._config) return this._config
    const configPath = path.join(this.basePath, CONFIG_FILE)
    try {
      if (fs.existsSync(configPath)) {
        this._config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      }
    } catch { /* ignore corrupt config */ }
    if (!this._config) this._config = { repos: {} }
    return this._config
  }

  /** Save config to disk */
  _saveConfig () {
    this._ensureDir()
    const configPath = path.join(this.basePath, CONFIG_FILE)
    fs.writeFileSync(configPath, JSON.stringify(this._config, null, 2), 'utf8')
  }

  /** Get or create a VectorStore for a reference */
  _getStore (name) {
    if (!this._stores.has(name)) {
      const storePath = path.join(this.basePath, name, 'vectors.json')
      this._stores.set(name, new VectorStore(storePath))
    }
    return this._stores.get(name)
  }

  /**
   * Validate a git URL — only public HTTPS allowed.
   */
  _validateUrl (url) {
    if (!url || typeof url !== 'string') throw new Error('URL is required')
    if (!url.startsWith('https://')) throw new Error('Only HTTPS URLs are allowed')
    if (url.includes('file://') || url.includes('ssh://')) throw new Error('Only HTTPS URLs are allowed')
    // Basic sanitization — prevent shell injection
    if (/[;&|`$(){}]/.test(url)) throw new Error('URL contains invalid characters')
    return url.trim()
  }

  /**
   * Derive a name from a URL if not provided.
   */
  _nameFromUrl (url) {
    const parts = url.replace(/\.git$/, '').split('/')
    return parts[parts.length - 1] || 'repo'
  }

  /**
   * Walk a directory and yield indexable files.
   */
  _walkFiles (dir, relativeTo) {
    const files = []

    function walk (currentDir, depth) {
      if (depth > 10) return
      let entries
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true })
      } catch { return }

      for (const entry of entries) {
        if (files.length >= 20000) return // safety cap

        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue
          walk(path.join(currentDir, entry.name), depth + 1)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase()
          if (!INDEXABLE_EXTENSIONS.has(ext)) continue

          const fullPath = path.join(currentDir, entry.name)
          try {
            const stat = fs.statSync(fullPath)
            if (stat.size > MAX_FILE_SIZE) continue
            if (stat.size === 0) continue
          } catch { continue }

          files.push({
            fullPath,
            relativePath: path.relative(relativeTo, fullPath)
          })
        }
      }
    }

    walk(dir, 0)
    return files
  }

  /**
   * Add a new repo reference. Clones and indexes.
   * Indexing runs async — returns immediately with status "indexing".
   *
   * @param {string} url - Git HTTPS URL
   * @param {object} options - { name, branch, model }
   * @returns {{ name, status }}
   */
  async add (url, options = {}) {
    const validUrl = this._validateUrl(url)
    const name = (options.name || this._nameFromUrl(validUrl)).toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    const branch = options.branch || 'main'
    const model = options.model || DEFAULT_MODEL

    const config = this._loadConfig()

    // Check limits
    if (Object.keys(config.repos).length >= MAX_REFERENCES && !config.repos[name]) {
      throw new Error(`Maximum ${MAX_REFERENCES} references allowed. Remove one first.`)
    }

    // Set up status tracking
    this._indexingStatus.set(name, { status: 'cloning', progress: 'Starting git clone...', error: null })

    // Store initial config
    config.repos[name] = {
      url: validUrl,
      branch,
      model,
      status: 'indexing',
      indexed_at: null,
      file_count: 0,
      chunk_count: 0
    }
    this._saveConfig()

    // Run indexing in background
    this._indexRepo(name, validUrl, branch, model).catch(err => {
      console.error(`[references] Indexing failed for ${name}: ${err.message}`)
      this._indexingStatus.set(name, { status: 'error', progress: null, error: err.message })
      config.repos[name].status = 'error'
      config.repos[name].error = err.message
      this._saveConfig()
    })

    return { name, status: 'indexing' }
  }

  /**
   * Internal: clone + index a repo.
   */
  async _indexRepo (name, url, branch, model) {
    const repoDir = path.join(this.basePath, name, 'repo')

    // Step 1: Clone or pull
    this._indexingStatus.set(name, { status: 'cloning', progress: `Cloning ${url}...`, error: null })

    if (fs.existsSync(repoDir)) {
      // Pull latest
      try {
        execSync(`git -C "${repoDir}" pull --ff-only`, { timeout: 120000, stdio: 'pipe' })
      } catch {
        // If pull fails, remove and re-clone
        fs.rmSync(repoDir, { recursive: true, force: true })
        execSync(`git clone --depth 1 --branch "${branch}" "${url}" "${repoDir}"`, { timeout: 300000, stdio: 'pipe' })
      }
    } else {
      fs.mkdirSync(path.dirname(repoDir), { recursive: true })
      try {
        execSync(`git clone --depth 1 --branch "${branch}" "${url}" "${repoDir}"`, { timeout: 300000, stdio: 'pipe' })
      } catch {
        // Branch might not exist, try without --branch
        execSync(`git clone --depth 1 "${url}" "${repoDir}"`, { timeout: 300000, stdio: 'pipe' })
      }
    }

    // Step 2: Ensure embedding model
    this._indexingStatus.set(name, { status: 'preparing', progress: 'Ensuring embedding model is available...', error: null })
    await ensureModel(model)

    // Step 3: Walk files
    this._indexingStatus.set(name, { status: 'scanning', progress: 'Scanning files...', error: null })
    const files = this._walkFiles(repoDir, repoDir)
    console.log(`[references] ${name}: Found ${files.length} indexable files`)

    // Step 4: Chunk + embed each file
    const store = this._getStore(name)
    store.clear()

    let totalChunks = 0
    let filesProcessed = 0

    for (const file of files) {
      filesProcessed++
      this._indexingStatus.set(name, {
        status: 'indexing',
        progress: `Indexing file ${filesProcessed}/${files.length}: ${file.relativePath}`,
        error: null
      })

      try {
        let content = fs.readFileSync(file.fullPath, 'utf8')
        // Prepend file path as context
        content = `// File: ${file.relativePath}\n${content}`

        const chunks = await chunkAndEmbed(content, model)
        const batch = []

        for (let i = 0; i < chunks.length; i++) {
          const chunkId = `${file.relativePath}:${i}`
          batch.push({
            id: chunkId,
            embedding: chunks[i].embedding,
            metadata: {
              file: file.relativePath,
              chunk_index: i,
              chunk_text: chunks[i].text.slice(0, 500), // Store first 500 chars for preview
              full_text: chunks[i].text
            }
          })
          totalChunks++
        }

        if (batch.length > 0) {
          store.addBatch(batch)
        }
      } catch (err) {
        console.warn(`[references] Failed to index ${file.relativePath}: ${err.message}`)
      }
    }

    // Step 5: Finalize
    store.flush()

    const config = this._loadConfig()
    config.repos[name].status = 'ready'
    config.repos[name].indexed_at = new Date().toISOString()
    config.repos[name].file_count = files.length
    config.repos[name].chunk_count = totalChunks
    delete config.repos[name].error
    this._saveConfig()

    this._indexingStatus.set(name, { status: 'ready', progress: null, error: null })
    console.log(`[references] ${name}: Indexed ${files.length} files, ${totalChunks} chunks`)
  }

  /**
   * Remove a reference and all its data.
   */
  remove (name) {
    const config = this._loadConfig()
    if (!config.repos[name]) {
      throw new Error(`Reference "${name}" not found`)
    }

    // Remove vector store from memory
    if (this._stores.has(name)) {
      this._stores.delete(name)
    }

    // Delete the reference directory
    const refDir = path.join(this.basePath, name)
    if (fs.existsSync(refDir)) {
      fs.rmSync(refDir, { recursive: true, force: true })
    }

    delete config.repos[name]
    this._indexingStatus.delete(name)
    this._saveConfig()
  }

  /**
   * Pull latest and re-index a reference.
   */
  async reindex (name) {
    const config = this._loadConfig()
    const repo = config.repos[name]
    if (!repo) throw new Error(`Reference "${name}" not found`)

    repo.status = 'indexing'
    this._saveConfig()

    await this._indexRepo(name, repo.url, repo.branch, repo.model || DEFAULT_MODEL)
    return { name, status: 'ready' }
  }

  /**
   * Semantic search across a reference's indexed content.
   *
   * @param {string} name - Reference name
   * @param {string} queryText - Natural language query
   * @param {number} topK - Number of results
   * @returns {Array<{file, chunk_index, score, chunk}>}
   */
  async query (name, queryText, topK = 10) {
    const config = this._loadConfig()
    const repo = config.repos[name]
    if (!repo) throw new Error(`Reference "${name}" not found`)
    if (repo.status !== 'ready') throw new Error(`Reference "${name}" is not ready (status: ${repo.status})`)

    const model = repo.model || DEFAULT_MODEL
    const queryEmbedding = await embed(queryText, model)
    const store = this._getStore(name)
    const results = store.search(queryEmbedding, topK)

    return results.map(r => ({
      file: r.metadata.file,
      chunk_index: r.metadata.chunk_index,
      score: Math.round(r.score * 1000) / 1000,
      chunk: r.metadata.full_text || r.metadata.chunk_text
    }))
  }

  /**
   * List all references with stats.
   */
  list () {
    const config = this._loadConfig()
    const refs = []

    for (const [name, repo] of Object.entries(config.repos)) {
      const status = this._indexingStatus.get(name)
      refs.push({
        name,
        url: repo.url,
        branch: repo.branch,
        status: status?.status || repo.status,
        progress: status?.progress || null,
        error: status?.error || repo.error || null,
        indexed_at: repo.indexed_at,
        file_count: repo.file_count,
        chunk_count: repo.chunk_count
      })
    }

    return refs
  }

  /**
   * Get detailed status for a reference.
   */
  getStatus (name) {
    const config = this._loadConfig()
    const repo = config.repos[name]
    if (!repo) return null

    const status = this._indexingStatus.get(name)
    const store = this._getStore(name)
    const storeStats = store.stats

    return {
      name,
      url: repo.url,
      branch: repo.branch,
      model: repo.model || DEFAULT_MODEL,
      status: status?.status || repo.status,
      progress: status?.progress || null,
      error: status?.error || repo.error || null,
      indexed_at: repo.indexed_at,
      file_count: repo.file_count,
      chunk_count: repo.chunk_count,
      vector_count: storeStats.count,
      dimensions: storeStats.dimensions,
      store_size_bytes: storeStats.sizeBytes
    }
  }

  /**
   * List indexed files for a reference.
   */
  getFiles (name) {
    const config = this._loadConfig()
    const repo = config.repos[name]
    if (!repo) throw new Error(`Reference "${name}" not found`)

    const repoDir = path.join(this.basePath, name, 'repo')
    if (!fs.existsSync(repoDir)) return []

    return this._walkFiles(repoDir, repoDir).map(f => f.relativePath)
  }
}

module.exports = ReferenceManager
