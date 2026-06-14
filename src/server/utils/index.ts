import { posix } from 'node:path'
import { uniqBy } from 'es-toolkit/array'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type { LlmsItem } from '../types/index.js'

/**
 * Captured snapshot of proxy-related environment variables at module load.
 * Filters out unset entries so callers can pass the result straight through
 * to a proxy agent without checking for empty strings.
 *
 * Keys are normalized to lowercase (`http_proxy`, `https_proxy`, `no_proxy`)
 * to match the conventions of `https-proxy-agent` and most CLI tooling.
 */
const { env } = process
export const httpProxyEnv = Object.fromEntries(
  Object.entries({
    http_proxy: env.HTTP_PROXY || env.http_proxy || '',
    https_proxy: env.HTTPS_PROXY || env.https_proxy || '',
    no_proxy: env.NO_PROXY || env.no_proxy || '',
  }).filter(([_k, v]) => !!v),
)

/**
 * Build an `https-proxy-agent` dispatcher configured from the current
 * proxy environment, or return `undefined` when no proxy is set so the
 * caller can fall through to the platform default `fetch`.
 *
 * Only the proxy URL is needed — `https-proxy-agent` reads `NO_PROXY`
 * from `process.env` on its own, so passing the full env map isn't
 * required.
 */
export const buildProxyAgent = () => {
  const proxyUrl = httpProxyEnv.https_proxy || httpProxyEnv.http_proxy
  if (!proxyUrl) return undefined
  return new HttpsProxyAgent(proxyUrl)
}

/**
 * Build the URL prefix used to resolve relative `.md` links found inside an
 * llms.txt document. Mirrors GitHub-style README link resolution: take the
 * directory of the source URL and append `/` so `new URL('./foo.md', base)`
 * resolves correctly.
 */
export const buildLinkBase = (sourceUrl: string) => {
  const url = new URL(sourceUrl)
  const dir = posix.dirname(url.pathname)
  const dirWithSlash = dir.endsWith('/') ? dir : `${dir}/`
  return `${url.origin}${dirWithSlash}`
}

/**
 * Split a raw Markdown link target like `"docs/api.md \"API docs\""` into
 * its URL and optional title. Returns `{ url, title }` where `title` is
 * empty when the target has no title portion.
 */
export const splitMarkdownLinkTarget = (rawTarget: string) => {
  const match = rawTarget.match(/^(\S+)(?:\s+(.*))?$/)
  if (!match) return { url: rawTarget.trim(), title: '' }
  return { url: match[1], title: (match[2] ?? '').trim() }
}

/**
 * Detect absolute URLs (those with an explicit scheme like `https:`,
 * `mailto:`, etc.) so we can skip resolving them against the doc base.
 */
const isAbsoluteUrl = (target: string) => /^[a-z][a-z0-9+.-]*:/i.test(target)

/**
 * Resolve a single raw Markdown link target against `base`. Returns the
 * rewritten target string, or `null` when the link is not a `.md` link,
 * already absolute, or fails URL parsing (in which case the caller should
 * leave the original target untouched).
 *
 * Absolute-path targets (`/foo/bar.md`) are resolved against the origin of
 * `base` so site-rooted links stay site-rooted regardless of the source
 * document's directory depth.
 */
export const resolveMarkdownLink = (rawTarget: string, base: string) => {
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

/**
 * Walk a Markdown document and rewrite every `[label](target)` link whose
 * target is a relative `.md` reference into an absolute URL. Non-`.md`
 * links and links that can't be resolved are left unchanged.
 */
export const resolveDocLinks = (text: string, sourceUrl: string) => {
  const base = buildLinkBase(sourceUrl)
  return text.replace(/\[([^\]]*)\]\(([^)]+?)\)/g, (match, label, target) => {
    const replaced = resolveMarkdownLink(target, base)
    return replaced === null ? match : `[${label}](${replaced})`
  })
}

/**
 * Throw if any item in `items` already uses the same `name` or `url` as
 * `payload`, ignoring the entry whose id matches `payload.excludeId`
 * (used by `edit` so the entry being edited isn't counted against itself).
 */
export const assertUnique = (
  items: LlmsItem[],
  payload: { name?: string; url?: string; excludeId?: string },
) => {
  for (const key of ['name', 'url'] as const) {
    const value = payload[key]
    if (!value) continue
    const filtered = items.filter((item) => item[key] === value)
    if (uniqBy(filtered, (item) => item.id).length !== filtered.length) {
      // Duplicate with the same id is the same item (the one being edited).
      // Any other duplicate id is a real conflict.
      const conflict = filtered.find((item) => item.id !== payload.excludeId)
      if (conflict) throw new Error(`${key} already exists: ${value}`)
    }
  }
}
