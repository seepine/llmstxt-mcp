import { posix } from 'node:path'
import { uniqBy } from 'es-toolkit/array'
import type { LlmsItem } from '../types/index.js'

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
