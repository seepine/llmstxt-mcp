import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildProxyAgent } from './index.js'

const DEFAULT_TTL_MS = 3 * 24 * 60 * 60 * 1000 // 3 days
const cacheDir = join(homedir(), '.llmstxt-mcp', 'cache')

const resolveDefaultTtlMs = (): number => {
  const raw = process.env.LLMSTXT_HTTP_CACHE_TTL_MS
  if (raw === undefined || raw === '') return DEFAULT_TTL_MS
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `llmstxt-mcp: LLMSTXT_HTTP_CACHE_TTL_MS=${raw} is not a positive integer; falling back to 3 days`,
    )
    return DEFAULT_TTL_MS
  }
  return parsed
}

const defaultTtlMs = resolveDefaultTtlMs()

const cachePath = (url: string, ext: 'md' | 'json') =>
  join(cacheDir, `${encodeURIComponent(url.replace(/[^a-zA-Z0-9._-]+/g, '_'))}.${ext}`)

const ensureCacheDir = async () => {
  await mkdir(cacheDir, { recursive: true })
}

type CacheMeta = { updateTime: string }

const readMeta = async (url: string): Promise<CacheMeta | null> => {
  try {
    const parsed = JSON.parse(await readFile(cachePath(url, 'json'), 'utf8')) as Partial<CacheMeta>
    if (typeof parsed.updateTime !== 'string' || !parsed.updateTime) return null
    return { updateTime: parsed.updateTime }
  } catch {
    return null
  }
}

const writeMeta = async (url: string, meta: CacheMeta) =>
  writeFile(cachePath(url, 'json'), JSON.stringify(meta), 'utf8')

const readCachedText = async (url: string): Promise<string | null> => {
  try {
    const text = await readFile(cachePath(url, 'md'), 'utf8')
    return text.trim() ? text : null
  } catch {
    return null
  }
}

const fetchFromNetwork = async (url: string): Promise<string> => {
  const dispatcher = buildProxyAgent()
  // `dispatcher` is an undici extension to RequestInit, not part of the
  // standard DOM fetch type — cast around it so callers stay typed.
  const init = dispatcher ? ({ dispatcher } as RequestInit) : undefined
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(`failed to fetch document: ${response.status} ${response.statusText}`)
  }
  const text = await response.text()
  if (!text.trim()) {
    throw new Error('fetched document is empty')
  }
  return text
}

export const fetchTextCached = async (url: string): Promise<string> => {
  await ensureCacheDir()

  const meta = await readMeta(url)
  if (meta && Date.now() - Date.parse(meta.updateTime) < defaultTtlMs) {
    const cached = await readCachedText(url)
    if (cached !== null) return cached
  }

  const text = await fetchFromNetwork(url)
  await writeFile(cachePath(url, 'md'), text, 'utf8')
  await writeMeta(url, { updateTime: new Date().toISOString() })
  return text
}
