/**
 * Local embedding module — talks to Ollama's /api/embed endpoint.
 * Ports chunking logic from fl-api EmbeddingService.php.
 */

const DEFAULT_MODEL = 'nomic-embed-text'
const DEFAULT_MAX_TOKENS = 2000
const MAX_CHARS_PER_TOKEN = 4
const MIN_CHUNK_LENGTH = 50

let ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434'

function setOllamaHost (host) {
  ollamaHost = host
}

/**
 * Ensure the embedding model is available, pulling it if needed.
 * Returns true if model is ready, throws on failure.
 */
async function ensureModel (model = DEFAULT_MODEL) {
  // Check if model exists
  try {
    const resp = await fetch(`${ollamaHost}/api/tags`, { signal: AbortSignal.timeout(5000) })
    if (resp.ok) {
      const data = await resp.json()
      const names = (data.models || []).map(m => m.name)
      if (names.some(n => n === model || n.startsWith(model + ':'))) {
        return true
      }
    }
  } catch { /* fall through to pull */ }

  // Pull the model
  console.log(`[embeddings] Pulling model ${model}...`)
  const pullResp = await fetch(`${ollamaHost}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model }),
    signal: AbortSignal.timeout(600000) // 10 min for large models
  })

  if (!pullResp.ok) {
    const errText = await pullResp.text()
    throw new Error(`Failed to pull ${model}: ${errText.slice(0, 200)}`)
  }

  // Consume the streaming response (Ollama streams pull progress as NDJSON)
  const reader = pullResp.body.getReader()
  const decoder = new TextDecoder()
  let lastStatus = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const text = decoder.decode(value, { stream: true })
    for (const line of text.split('\n').filter(Boolean)) {
      try {
        const obj = JSON.parse(line)
        if (obj.status && obj.status !== lastStatus) {
          console.log(`[embeddings] Pull ${model}: ${obj.status}`)
          lastStatus = obj.status
        }
      } catch { /* ignore parse errors in stream */ }
    }
  }

  console.log(`[embeddings] Model ${model} ready`)
  return true
}

/**
 * Generate an embedding vector for a single text string.
 * Returns a Float64Array of the embedding dimensions.
 */
async function embed (text, model = DEFAULT_MODEL) {
  const resp = await fetch(`${ollamaHost}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
    signal: AbortSignal.timeout(30000)
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Ollama embed failed (${resp.status}): ${errText.slice(0, 200)}`)
  }

  const data = await resp.json()
  const vec = data.embeddings?.[0]
  if (!vec || !Array.isArray(vec)) {
    throw new Error('Ollama returned no embedding vector')
  }
  return new Float64Array(vec)
}

/**
 * Split text into chunks using paragraph → sentence → character hierarchy.
 * Ported from EmbeddingService.php chunkText().
 */
function chunkText (text, maxTokens = DEFAULT_MAX_TOKENS) {
  const maxChars = maxTokens * MAX_CHARS_PER_TOKEN

  // Split on paragraph boundaries (double newline)
  const paragraphs = text.split(/\n\s*\n/)
  const chunks = []
  let current = ''

  for (const raw of paragraphs) {
    const para = raw.trim()
    if (!para) continue

    if ((current + para).length > maxChars) {
      if (current) {
        chunks.push(current.trim())
        current = ''
      }

      // Paragraph itself too long — split by sentences then chars
      if (para.length > maxChars) {
        chunks.push(...chunkLongParagraph(para, maxChars))
      } else {
        current = para
      }
    } else {
      current += (current ? '\n\n' : '') + para
    }
  }

  if (current) chunks.push(current.trim())

  return chunks.filter(c => c.length >= MIN_CHUNK_LENGTH)
}

/**
 * Split a long paragraph by sentence boundaries, then by char limit.
 */
function chunkLongParagraph (paragraph, maxChars) {
  const sentences = paragraph.split(/(?<=[.!?])\s+/)
  const chunks = []
  let current = ''

  for (const sentence of sentences) {
    if ((current + sentence).length > maxChars) {
      if (current) {
        chunks.push(current.trim())
        current = sentence
      } else {
        // Single sentence too long — hard split
        chunks.push(sentence.slice(0, maxChars))
        current = sentence.slice(maxChars)
      }
    } else {
      current += (current ? ' ' : '') + sentence
    }
  }

  if (current) chunks.push(current.trim())
  return chunks
}

/**
 * Chunk a document and embed each chunk.
 * Returns [{ text, embedding }]
 */
async function chunkAndEmbed (text, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS) {
  const chunks = chunkText(text, maxTokens)
  const results = []

  for (const chunk of chunks) {
    const embedding = await embed(chunk, model)
    results.push({ text: chunk, embedding })
  }

  return results
}

module.exports = {
  embed,
  chunkText,
  chunkAndEmbed,
  ensureModel,
  setOllamaHost,
  DEFAULT_MODEL
}
