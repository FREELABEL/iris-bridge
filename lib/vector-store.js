/**
 * JSON-file-backed vector store with cosine similarity search.
 * No external dependencies — pure JS.
 *
 * Stores vectors as base64-encoded Float64Arrays in a single JSON file.
 * Lazy-loads into memory on first query, stays resident.
 */

const fs = require('fs')
const path = require('path')

class VectorStore {
  /**
   * @param {string} storePath - Full path to the vectors.json file
   */
  constructor (storePath) {
    this.storePath = storePath
    this._entries = null // lazy-loaded
    this._dirty = false
    this._lastAccess = Date.now()
  }

  /** Lazy-load entries from disk */
  _load () {
    if (this._entries !== null) {
      this._lastAccess = Date.now()
      return
    }

    this._entries = new Map()

    try {
      if (fs.existsSync(this.storePath)) {
        const raw = JSON.parse(fs.readFileSync(this.storePath, 'utf8'))
        for (const entry of (raw.entries || [])) {
          // Decode base64 → Float64Array
          const buf = Buffer.from(entry.vector, 'base64')
          const embedding = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8)
          this._entries.set(entry.id, { embedding, metadata: entry.metadata })
        }
      }
    } catch (err) {
      console.error(`[vector-store] Failed to load ${this.storePath}: ${err.message}`)
      this._entries = new Map()
    }

    this._lastAccess = Date.now()
  }

  /** Persist entries to disk */
  _save () {
    if (!this._dirty || !this._entries) return

    const dir = path.dirname(this.storePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const entries = []
    for (const [id, { embedding, metadata }] of this._entries) {
      // Encode Float64Array → base64
      const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
      entries.push({ id, vector: buf.toString('base64'), metadata })
    }

    fs.writeFileSync(this.storePath, JSON.stringify({ entries }, null, 0), 'utf8')
    this._dirty = false
  }

  /**
   * Add a vector with metadata.
   * @param {string} id
   * @param {Float64Array} embedding
   * @param {object} metadata - e.g. { file, line, chunk }
   */
  add (id, embedding, metadata = {}) {
    this._load()
    this._entries.set(id, { embedding, metadata })
    this._dirty = true
  }

  /**
   * Add multiple vectors in a batch, then save once.
   * @param {Array<{id: string, embedding: Float64Array, metadata: object}>} items
   */
  addBatch (items) {
    this._load()
    for (const { id, embedding, metadata } of items) {
      this._entries.set(id, { embedding, metadata: metadata || {} })
    }
    this._dirty = true
    this._save()
  }

  /**
   * Cosine similarity between two vectors.
   */
  static cosine (a, b) {
    let dot = 0
    let normA = 0
    let normB = 0
    const len = Math.min(a.length, b.length)
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB)
    return denom === 0 ? 0 : dot / denom
  }

  /**
   * Search for the top-K most similar vectors.
   * @param {Float64Array} queryEmbedding
   * @param {number} topK
   * @returns {Array<{id: string, score: number, metadata: object}>}
   */
  search (queryEmbedding, topK = 5) {
    this._load()

    const scored = []
    for (const [id, { embedding, metadata }] of this._entries) {
      const score = VectorStore.cosine(queryEmbedding, embedding)
      scored.push({ id, score, metadata })
    }

    // Sort descending by score, take top K
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }

  /** Delete a vector by id */
  delete (id) {
    this._load()
    const deleted = this._entries.delete(id)
    if (deleted) this._dirty = true
    return deleted
  }

  /** Clear all vectors */
  clear () {
    this._entries = new Map()
    this._dirty = true
    this._save()
  }

  /** Flush pending writes to disk */
  flush () {
    this._save()
  }

  /** Evict from memory (will re-load from disk on next access) */
  evict () {
    this._save()
    this._entries = null
  }

  /** Stats about this store */
  get stats () {
    this._load()
    const count = this._entries.size
    let dimensions = 0
    if (count > 0) {
      const first = this._entries.values().next().value
      dimensions = first.embedding.length
    }

    let sizeBytes = 0
    try {
      if (fs.existsSync(this.storePath)) {
        sizeBytes = fs.statSync(this.storePath).size
      }
    } catch { /* ignore */ }

    return { count, dimensions, sizeBytes, lastAccess: this._lastAccess }
  }
}

module.exports = VectorStore
