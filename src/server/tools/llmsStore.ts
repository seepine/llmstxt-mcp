import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, posix, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const llmsStatusSchema = z.enum(['init', 'ing', 'done', 'fail'])

const llmsItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.url(),
  description: z.string(),
  updateTime: z.string(),
  status: llmsStatusSchema,
  statusTime: z.string(),
  statusMsg: z.string(),
})

const llmsConfigSchema = z.object({
  llms: z.array(llmsItemSchema),
})

export type LlmsItem = z.infer<typeof llmsItemSchema>
export type LlmsConfig = z.infer<typeof llmsConfigSchema>

const baseDir = join(homedir(), '.llmstxt-mcp')
const configPath = join(baseDir, 'config.json')
const heartbeatIntervalMs = 5000

const emptyConfig: LlmsConfig = {
  llms: [],
}

const now = () => new Date().toISOString()

/**
 * Atomic write: write to a sibling temp file then rename over the target.
 * Prevents partially-written config.json from corrupting subsequent reads.
 */
const writeJson = async (filePath: string, data: unknown) => {
  await mkdir(dirname(filePath), { recursive: true })
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

  let raw: string
  try {
    raw = await readFile(configPath, 'utf8')
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('ENOENT'))) {
      throw error
    }
    await writeJson(configPath, emptyConfig)
    return
  }

  if (!raw.trim()) {
    await backupAndReset(raw, 'empty file')
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

const buildLinkBase = (sourceUrl: string) => {
  const url = new URL(sourceUrl)
  const dir = posix.dirname(url.pathname)
  const dirWithSlash = dir.endsWith('/') ? dir : `${dir}/`
  return `${url.origin}${dirWithSlash}`
}

const splitMarkdownLinkTarget = (rawTarget: string) => {
  const trimmed = rawTarget.trim()
  const spaceIndex = trimmed.search(/\s/)
  if (spaceIndex === -1) {
    return { url: trimmed, title: '' }
  }
  return {
    url: trimmed.slice(0, spaceIndex),
    title: trimmed.slice(spaceIndex + 1).trim(),
  }
}

const isAbsoluteUrl = (target: string) => /^[a-z][a-z0-9+.-]*:/i.test(target)

const resolveMarkdownLink = (rawTarget: string, base: string) => {
  const { url, title } = splitMarkdownLinkTarget(rawTarget)
  if (!url.endsWith('.md')) return null
  if (isAbsoluteUrl(url)) return null

  try {
    const resolved = url.startsWith('/')
      ? new URL(url, base.startsWith('http') ? new URL(base).origin : base)
      : new URL(url, base)
    return title ? `${resolved.href} ${title}` : resolved.href
  } catch {
    return null
  }
}

const resolveDocLinks = (text: string, sourceUrl: string) => {
  const base = buildLinkBase(sourceUrl)
  return text.replace(/\[([^\]]*)\]\(([^)]+?)\)/g, (match, _label, target) => {
    const replaced = resolveMarkdownLink(target, base)
    return replaced === null ? match : `[${_label}](${replaced})`
  })
}

const assertUnique = (
  items: LlmsItem[],
  payload: { name?: string; url?: string; excludeId?: string },
) => {
  if (payload.name) {
    const duplicatedName = items.find(
      (item) => item.name === payload.name && item.id !== payload.excludeId,
    )

    if (duplicatedName) {
      throw new Error(`name already exists: ${payload.name}`)
    }
  }

  if (payload.url) {
    const duplicatedUrl = items.find(
      (item) => item.url === payload.url && item.id !== payload.excludeId,
    )

    if (duplicatedUrl) {
      throw new Error(`url already exists: ${payload.url}`)
    }
  }
}

const findItem = (config: LlmsConfig, id: string) => {
  const item = config.llms.find((entry) => entry.id === id)
  if (!item) {
    throw new Error(`llms not found: ${id}`)
  }
  return item
}

const fetchDocText = async (url: string) => {
  const response = await fetch(url)
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

const syncItemDocument = async (item: LlmsItem, persistConfig?: () => Promise<void>) => {
  const startedAt = now()
  item.status = 'ing'
  item.statusTime = startedAt
  item.statusMsg = ''

  if (persistConfig) {
    await persistConfig()
  }

  const docPath = getDocPath(item.id)
  let heartbeatChain = Promise.resolve()
  const heartbeatTimer =
    persistConfig === undefined
      ? undefined
      : setInterval(() => {
          heartbeatChain = heartbeatChain
            .then(async () => {
              if (item.status !== 'ing') {
                return
              }

              item.statusTime = now()
              await persistConfig()
            })
            .catch(() => {})
        }, heartbeatIntervalMs)

  const stopHeartbeat = async () => {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer)
      await heartbeatChain
    }
  }

  try {
    const text = await fetchDocText(item.url)
    await mkdir(dirname(docPath), { recursive: true })
    await writeFile(docPath, text, 'utf8')

    const finishedAt = now()
    item.status = 'done'
    item.statusTime = finishedAt
    item.updateTime = finishedAt
    item.statusMsg = ''

    await stopHeartbeat()

    if (persistConfig) {
      await persistConfig()
    }

    return text
  } catch (error) {
    item.status = 'fail'
    item.statusTime = now()
    item.statusMsg = error instanceof Error ? error.message : String(error)
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

    await stopHeartbeat()

    if (persistConfig) {
      await persistConfig()
    }

    throw error
  }
}

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
        status: 'init',
        statusTime: '',
        statusMsg: '',
      }

      config.llms.push(item)
      await writeConfig(config)

      try {
        await syncItemDocument(item, async () => writeConfig(config))
      } catch (error) {
        // syncItemDocument has already mutated item.status to 'fail' and
        // persisted via the heartbeat callback. Re-persist in case the
        // failure happened before the first heartbeat tick.
        await writeConfig(config)
        throw error
      }

      await writeConfig(config)
      return item
    })
  },
  edit(input: { id: string; name?: string; url?: string; description?: string }) {
    return withLock(async () => {
      const config = await readConfig()
      const item = findItem(config, input.id)

      assertUnique(config.llms, {
        name: input.name,
        url: input.url,
        excludeId: input.id,
      })

      const shouldRefetch = Boolean(input.url && input.url !== item.url)

      // Snapshot mutable fields so we can roll back if the refetch fails.
      const snapshot = shouldRefetch
        ? { name: item.name, url: item.url, description: item.description }
        : null

      if (input.name !== undefined) {
        item.name = input.name
      }
      if (input.url !== undefined) {
        item.url = input.url
      }
      if (input.description !== undefined) {
        item.description = input.description
      }

      if (!shouldRefetch) {
        // Non-refetch edit: bump updateTime so the field reflects this change.
        item.updateTime = now()
        await writeConfig(config)
        return item
      }

      try {
        await syncItemDocument(item, async () => writeConfig(config))
        return item
      } catch (error) {
        // Roll back the metadata mutation, then persist the rolled-back state
        // so the on-disk config matches the in-memory rollback. The previous
        // (now-deleted) doc dir is gone, but the user can re-edit with a
        // working URL without ending up with a half-applied rename.
        if (snapshot) {
          item.name = snapshot.name
          item.url = snapshot.url
          item.description = snapshot.description
        }
        await writeConfig(config)
        throw error
      }
    })
  },
  remove(id: string) {
    return withLock(async () => {
      const config = await readConfig()
      const index = config.llms.findIndex((item) => item.id === id)

      if (index === -1) {
        throw new Error(`llms not found: ${id}`)
      }

      const [removed] = config.llms.splice(index, 1)
      const docDir = dirname(getDocPath(id))

      // Remove the doc dir first; only update config after rm succeeds so a
      // failure leaves the record in place and the user can retry.
      await rm(docDir, { recursive: true, force: true })
      await writeConfig(config)
      return removed
    })
  },
  list() {
    return withLock(async () => {
      const config = await readConfig()
      return config.llms.map(({ id, name, url, description }) => ({
        id,
        name,
        url,
        description,
      }))
    })
  },
  get(id: string) {
    return withLock(async () => {
      const config = await readConfig()
      return findItem(config, id)
    })
  },
  getDoc(id: string) {
    return withLock(async () => {
      const config = await readConfig()
      const item = findItem(config, id)

      if (item.status === 'init') {
        throw new Error(`llms document not ready: status=init (id=${id})`)
      }
      if (item.status === 'ing') {
        throw new Error(`llms document not ready: status=ing (id=${id})`)
      }
      if (item.status === 'fail') {
        throw new Error(
          `llms document not available: status=fail (id=${id}, message=${item.statusMsg || 'unknown'})`,
        )
      }

      const raw = await readFile(getDocPath(id), 'utf8')
      const content = resolveDocLinks(raw, item.url)
      return {
        item,
        content,
      }
    })
  },
}
