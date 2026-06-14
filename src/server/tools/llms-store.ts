import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  globalSettingsSchema,
  llmsConfigSchema,
  llmsItemSchema,
  type LlmsConfig,
  type LlmsItem,
} from '../types/index.js'
import { assertUnique, buildProxyAgent, resolveDocLinks } from '../utils/index.js'

const baseDir = join(homedir(), '.llmstxt-mcp')
const configPath = join(baseDir, 'config.json')
const defaultRefreshTtlMs = 7 * 24 * 60 * 60 * 1000 // 7 days

const emptyConfig: LlmsConfig = llmsConfigSchema.parse({})

const now = () => new Date().toISOString()

/**
 * Atomic write: write to a sibling temp file then rename over the target.
 * Prevents partially-written config.json from corrupting subsequent reads.
 * Assumes the parent directory already exists — ensureConfig creates it.
 */
const writeJson = async (filePath: string, data: unknown) => {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8')
  await rename(tempPath, filePath)
}

/**
 * Ensure config.json exists and is parseable. If the file is missing, empty,
 * or contains invalid JSON, back it up and write a fresh empty config so
 * subsequent reads always succeed.
 */
const ensureConfig = async () => {
  await mkdir(baseDir, { recursive: true })

  let raw = ''
  try {
    raw = await readFile(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  if (!raw.trim()) {
    await backupAndReset(raw, 'empty or missing file')
    return
  }

  try {
    JSON.parse(raw)
  } catch (error) {
    await backupAndReset(raw, `invalid JSON: ${(error as Error).message}`)
  }
}

const backupAndReset = async (raw: string, reason: string) => {
  const backupPath = `${configPath}.corrupt.${Date.now()}.bak`
  await writeFile(backupPath, raw, 'utf8')
  console.warn(
    `llmstxt-mcp: config.json unreadable (${reason}); backed up to ${backupPath} and resetting to empty config`,
  )
  await writeJson(configPath, emptyConfig)
}

const readConfig = async (): Promise<LlmsConfig> => {
  await ensureConfig()
  const raw = await readFile(configPath, 'utf8')
  return llmsConfigSchema.parse(JSON.parse(raw))
}

const writeConfig = async (config: LlmsConfig) => {
  await writeJson(configPath, config)
}

const getDocPath = (id: string) => join(baseDir, id, 'llms.txt')

const findItemIndex = (config: LlmsConfig, id: string) => {
  const index = config.llms.findIndex((entry) => entry.id === id)
  if (index === -1) {
    throw new Error(`llms not found: ${id}`)
  }
  return index
}

const fetchDocText = async (url: string) => {
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

/**
 * Serialize all public llmsStore operations through a single Promise chain.
 * Node's single-threaded event loop means a chained `.then` is sufficient
 * to make the critical section (read-modify-write of config.json) atomic
 * from the perspective of concurrent MCP tool invocations.
 */
let lockChain: Promise<unknown> = Promise.resolve()
const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = lockChain.then(fn, fn)
  lockChain = next.catch(() => {})
  return next
}

/**
 * Fetch the source document for `item.url` and persist it under
 * `~/.llmstxt-mcp/<id>/llms.txt`. Sets `item.updateTime` on success.
 *
 * Synchronous from the caller's perspective: throws on failure (after
 * best-effort cleanup of the doc dir); never leaves a half-written state
 * in config.json.
 */
const syncItemDocument = async (item: LlmsItem) => {
  const docPath = getDocPath(item.id)
  try {
    const text = await fetchDocText(item.url)
    await mkdir(dirname(docPath), { recursive: true })
    await writeFile(docPath, text, 'utf8')
    item.updateTime = now()
    return text
  } catch (error) {
    try {
      await rm(dirname(docPath), { recursive: true, force: true })
    } catch (cleanupError) {
      // Best-effort cleanup: never let a rm failure replace the original
      // fetch error. Log and continue so the caller still sees the real
      // root cause.
      console.warn(
        `llmstxt-mcp: failed to remove ${dirname(docPath)} after fetch error:`,
        cleanupError,
      )
    }

    throw error
  }
}

const getRefreshTtlMs = (config: LlmsConfig): number => {
  // readConfig() runs llmsConfigSchema.parse(...), so refreshTtlMs is already
  // guaranteed to be a positive integer if present.
  return config.globalSettings?.refreshTtlMs ?? defaultRefreshTtlMs
}

/**
 * An item is stale when its updateTime is empty (never fetched) or older
 * than ttlMs. The caller is responsible for serializing refresh.
 */
const isStale = (item: LlmsItem, ttlMs: number, nowMs: number) => {
  if (!item.updateTime) return true
  return nowMs - Date.parse(item.updateTime) >= ttlMs
}

const refreshItemById = async (config: LlmsConfig, id: string) => {
  const item = config.llms[findItemIndex(config, id)]
  await syncItemDocument(item)
  await writeConfig(config)
  return item
}

const refreshItem = async (config: LlmsConfig, item: LlmsItem) => {
  await syncItemDocument(item)
  await writeConfig(config)
  return item
}

// Re-export schemas for callers that need to validate inputs.
export { llmsItemSchema, globalSettingsSchema, llmsConfigSchema }

export const llmsStore = {
  configPath,
  baseDir,
  add(input: { name: string; url: string; description: string }) {
    return withLock(async () => {
      const config = await readConfig()
      assertUnique(config.llms, { name: input.name, url: input.url })

      const item: LlmsItem = {
        id: randomUUID(),
        name: input.name,
        url: input.url,
        description: input.description,
        updateTime: '',
      }

      // 同步 fetch:成功才落盘。失败直接抛错,不写 config。
      await syncItemDocument(item)
      config.llms.push(item)
      await writeConfig(config)
      return item
    })
  },
  edit(input: { id: string; name?: string; url?: string; description?: string }) {
    return withLock(async () => {
      const config = await readConfig()
      const index = findItemIndex(config, input.id)
      const item = config.llms[index]

      assertUnique(config.llms, {
        name: input.name,
        url: input.url,
        excludeId: input.id,
      })

      // Validate the new URL by fetching first; only commit on success so a
      // bad URL never gets persisted. Other fields are applied only after
      // the fetch resolves so the metadata edit is one atomic change.
      if (input.url !== undefined && input.url !== item.url) {
        const previousUrl = item.url
        item.url = input.url
        try {
          await syncItemDocument(item)
        } catch (error) {
          item.url = previousUrl
          throw error
        }
      }

      if (input.name !== undefined) item.name = input.name
      if (input.description !== undefined) item.description = input.description
      await writeConfig(config)
      return item
    })
  },
  refreshOne(id: string) {
    return withLock(async () => {
      const config = await readConfig()
      return refreshItemById(config, id)
    })
  },
  remove(id: string) {
    return withLock(async () => {
      const config = await readConfig()
      const index = findItemIndex(config, id)
      const [removed] = config.llms.splice(index, 1)

      // Persist config first; if the write fails the doc dir stays around
      // (cheap orphan) but config never references a missing file. If the
      // rm fails after the write, the next refresh will rewrite the doc.
      await writeConfig(config)
      await rm(dirname(getDocPath(id)), { recursive: true, force: true })
      return removed
    })
  },
  list() {
    return withLock(async () => {
      const config = await readConfig()
      return config.llms.map((item) => ({
        id: item.id,
        name: item.name,
        url: item.url,
        description: item.description,
      }))
    })
  },
  get(id: string) {
    return withLock(async () => {
      const config = await readConfig()
      const index = findItemIndex(config, id)
      return config.llms[index]
    })
  },
  getDoc(id: string) {
    return withLock(async () => {
      const config = await readConfig()
      const item = config.llms[findItemIndex(config, id)]

      // view 层做过期判断:过期则刷新 url 数据,失败抛错(不返回旧内容)
      if (isStale(item, getRefreshTtlMs(config), Date.now())) {
        await refreshItem(config, item)
      }

      const raw = await readFile(getDocPath(id), 'utf8')
      return {
        item,
        content: resolveDocLinks(raw, item.url),
      }
    })
  },
}
