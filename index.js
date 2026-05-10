'use strict'

// Tropy.md — v0.2.0
//
// Exports each selected Tropy item to its own Markdown file in a chosen
// directory. Markdown-editor neutral by default — no wiki-links, no opinionated
// tag dispatch unless the user opts in via the Settings panel.
//
// Idempotency: each output filename embeds an 8-char content hash derived
// from a fingerprint of the item's stable fields (title, template, source,
// box/folder, photo paths, tags, etc.). Re-running the export skips any item
// whose hash already appears in a `tropy-<hash>-*.md` file in the output
// directory.

const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { homedir } = require('os')


// ----- helpers --------------------------------------------------------------

function parseCsvSet(s) {
  return new Set(
    String(s || '').split(',').map(t => t.trim()).filter(Boolean)
  )
}

function parseDispatch(s) {
  // Parses the tagPrefixDispatch config into an ordered list of
  //   { prefix, field }
  // entries. Format is comma-separated, each entry being either:
  //   prefix/             (field name = prefix without trailing slash)
  //   prefix/=field       (explicit field name)
  // Trailing slashes on the prefix are normalized in (so `person` and
  // `person/` are equivalent) — this prevents `person` from matching a
  // hypothetical `personal/foo` tag.
  const out = []
  for (const entry of String(s || '').split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    let prefix, field
    if (eq < 0) {
      prefix = trimmed
      field = prefix.replace(/\/+$/, '')
    } else {
      prefix = trimmed.slice(0, eq).trim()
      field = trimmed.slice(eq + 1).trim()
    }
    if (prefix && !prefix.endsWith('/')) prefix += '/'
    if (prefix && field) out.push({ prefix, field })
  }
  return out
}

function dispatchTags(tags, dispatch) {
  // Returns { fields: Map<fieldName, string[]>, fieldOrder: string[],
  //           leftover: string[] }
  // Field order matches first-appearance in the dispatch declaration so
  // YAML output is predictable. Values are deduped case-insensitively per
  // field (case preserved from first occurrence) and sorted alphabetically.
  const fields = new Map()
  const fieldOrder = []
  const leftover = []

  for (const { field } of dispatch) {
    if (!fields.has(field)) {
      fields.set(field, [])
      fieldOrder.push(field)
    }
  }

  outer: for (const tag of tags) {
    for (const { prefix, field } of dispatch) {
      if (tag.startsWith(prefix)) {
        const entity = tag.slice(prefix.length).trim()
        if (entity) {
          const arr = fields.get(field)
          if (!arr.some(e => e.toLowerCase() === entity.toLowerCase())) {
            arr.push(entity)
          }
        }
        continue outer
      }
    }
    leftover.push(tag)
  }

  for (const arr of fields.values()) {
    arr.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  }

  return { fields, fieldOrder, leftover }
}

function slugify(s, maxLen = 60) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, maxLen)
    .replace(/^-+|-+$/g, '')
}

function shortHash(item) {
  // Hash a content fingerprint built from the whole item, not just the first
  // photo's checksum. Tropy can ship `checksum: "d41d8cd9..."` (md5 of empty
  // string) for photos it hasn't processed yet — multiple items would then
  // collide and only the first would survive idempotency. Photo `path` is
  // unique per item and stable across re-exports, so we lean on it instead.
  const photos = Array.isArray(item.photo) ? item.photo : []
  const fingerprint = JSON.stringify({
    title:       item.title       || '',
    template:    item.template    || '',
    creator:     item.creator     || '',
    publisher:   item.publisher   || '',
    date:        item.date        || '',
    type:        item.type        || '',
    source:      item.source      || '',
    archive:     item.archive     || '',
    collection:  item.collection  || '',
    box:         item.box         || '',
    folder:      item.folder      || '',
    photo_paths: photos.map(p => (p && p.path) || ''),
    tags:        (Array.isArray(item.tag) ? item.tag : []).slice().sort()
  })
  return crypto.createHash('md5').update(fingerprint).digest('hex').slice(0, 8)
}

function filenameFor(item, hash) {
  const slug = slugify(item.title)
  return slug ? `tropy-${hash}-${slug}.md` : `tropy-${hash}.md`
}

function yamlScalar(s) {
  if (s === null || s === undefined || s === '') return '""'
  const escaped = String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}"`
}

function composeSource(item) {
  // Same order the Python export uses: source, archive, collection, box, folder.
  // Skip empties so a missing piece doesn't leave a stray comma.
  const parts = [item.source, item.archive, item.collection, item.box, item.folder]
    .map(p => (p == null ? '' : String(p).trim()))
    .filter(Boolean)
  return parts.join(', ')
}

function htmlToMarkdown(html) {
  if (!html) return ''
  return html
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<\/?p[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(strong|b)>([^]*?)<\/(strong|b)>/gi, '**$2**')
    .replace(/<(em|i)>([^]*?)<\/(em|i)>/gi, '*$2*')
    .replace(/<u>([^]*?)<\/u>/gi, '__$1__')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function noteToMarkdown(note) {
  // Prefer Tropy's native markdown export when present. Fall back through
  // html (naive convert) and finally plain text.
  const md = note && note.markdown && note.markdown['@value']
  if (md) return md.trim()
  const html = note && note.html && note.html['@value']
  if (html) return htmlToMarkdown(html)
  const text = note && note.text && note.text['@value']
  return text ? text.trim() : ''
}

function extractNotes(item) {
  const out = []
  const photos = Array.isArray(item.photo) ? item.photo : []
  for (const photo of photos) {
    const notes = Array.isArray(photo.note) ? photo.note : []
    for (const note of notes) {
      const md = noteToMarkdown(note)
      if (md) out.push(md)
    }
  }
  return out
}

function extractPhotoPaths(item) {
  const photos = Array.isArray(item.photo) ? item.photo : []
  return photos.map(p => (p && p.path) || '').filter(Boolean)
}


// ----- assembly -------------------------------------------------------------

function buildFrontmatter(item, hash, opts) {
  const allTags = (Array.isArray(item.tag) ? item.tag : [])
    .filter(t => t && !opts.workflowTags.has(t))

  const { fields, fieldOrder, leftover } = dispatchTags(allTags, opts.dispatch)

  const lines = ['---']
  lines.push(`title: ${yamlScalar(item.title)}`)
  if (item.creator) lines.push(`creator: ${yamlScalar(item.creator)}`)
  if (item.publisher) lines.push(`publication: ${yamlScalar(item.publisher)}`)
  if (item.date) lines.push(`date: ${yamlScalar(item.date)}`)
  if (item.type) lines.push(`doc_type: ${yamlScalar(item.type)}`)
  const source = composeSource(item)
  if (source) lines.push(`source: ${yamlScalar(source)}`)

  // Dispatched entity fields, in declaration order.
  for (const field of fieldOrder) {
    const values = fields.get(field)
    if (values.length === 0) {
      lines.push(`${field}: []`)
    } else {
      lines.push(`${field}:`)
      for (const v of values) {
        const display = opts.wikiLinkEntities ? `[[${v}]]` : v
        lines.push(`  - ${yamlScalar(display)}`)
      }
    }
  }

  // Leftover (unmatched) tags as a flat list.
  if (leftover.length === 0) {
    lines.push('tags: []')
  } else {
    lines.push('tags:')
    for (const tag of leftover) lines.push(`  - ${yamlScalar(tag)}`)
  }

  if (opts.includePhotoPaths) {
    const paths = extractPhotoPaths(item)
    if (paths.length === 0) {
      lines.push('photos: []')
    } else {
      lines.push('photos:')
      for (const p of paths) lines.push(`  - ${yamlScalar(p)}`)
    }
  }

  lines.push(`tropy_hash: ${hash}`)
  lines.push('---')
  return lines.join('\n')
}

function buildBody(notes) {
  if (notes.length === 0) return '\n'
  return '\n## Notes\n\n' + notes.join('\n\n') + '\n'
}

function assembleMarkdown(item, hash, opts) {
  const notes = extractNotes(item)
  return buildFrontmatter(item, hash, opts) + '\n' + buildBody(notes)
}


// ----- plugin class ---------------------------------------------------------

class MarkdownPlugin {
  constructor(options, context) {
    this.options = Object.assign({}, MarkdownPlugin.defaults, options)
    this.context = context
  }

  get dialog() { return this.context.dialog }
  get logger() { return this.context.logger }

  async resolveOutDir() {
    let dir = (this.options.outputDir || '').trim()
    if (!dir) {
      const choice = await this.dialog.open({
        defaultPath: homedir(),
        properties: ['openDirectory', 'createDirectory']
      })
      dir = Array.isArray(choice) ? choice[0] : choice
    }
    return dir || null
  }

  async existingHashes(outDir) {
    let files = []
    try {
      files = await fs.readdir(outDir)
    } catch {
      return new Set()
    }
    const set = new Set()
    const re = /^tropy-([0-9a-f]{8})-/
    for (const f of files) {
      const m = f.match(re)
      if (m) set.add(m[1])
    }
    return set
  }

  buildOpts() {
    return {
      workflowTags: parseCsvSet(this.options.workflowTags),
      includePhotoPaths: this.options.includePhotoPaths !== false,
      skipEmptyNotes: this.options.skipEmptyNotes === true,
      dispatch: parseDispatch(this.options.tagPrefixDispatch),
      wikiLinkEntities: this.options.wikiLinkEntities === true
    }
  }

  async export(data) {
    this.logger.trace('Tropy.md: export hook invoked')

    const items = (data && Array.isArray(data['@graph'])) ? data['@graph'] : []
    if (items.length === 0) {
      this.logger.warn('Tropy.md: no items in export data')
      return
    }

    const outDir = await this.resolveOutDir()
    if (!outDir) {
      this.logger.trace('Tropy.md: cancelled by user')
      return
    }

    try {
      await fs.mkdir(outDir, { recursive: true })
    } catch (err) {
      this.logger.error({ stack: err.stack }, err.message)
      this.dialog.fail(err)
      return
    }

    const opts = this.buildOpts()
    const seen = await this.existingHashes(outDir)
    let wrote = 0
    let skipped = 0
    let failed = 0

    for (const item of items) {
      try {
        const hash = shortHash(item)
        if (seen.has(hash)) {
          this.logger.trace(
            `Tropy.md: skip ${hash} (already exported)`
          )
          skipped++
          continue
        }
        if (opts.skipEmptyNotes && extractNotes(item).length === 0) {
          this.logger.trace(
            `Tropy.md: skip ${hash} (no notes; skipEmptyNotes on)`
          )
          skipped++
          continue
        }
        const md = assembleMarkdown(item, hash, opts)
        const target = path.join(outDir, filenameFor(item, hash))
        await fs.writeFile(target, md, 'utf8')
        seen.add(hash)
        wrote++
      } catch (err) {
        failed++
        this.logger.error({ stack: err.stack }, err.message)
      }
    }

    this.logger.info(
      `Tropy.md: ${wrote} written, ${skipped} skipped, ` +
      `${failed} failed -> ${outDir}`
    )
  }
}

MarkdownPlugin.defaults = {
  outputDir: '',
  workflowTags: 'to-obsidian,to-process,to-transcribe,in-obsidian',
  includePhotoPaths: true,
  skipEmptyNotes: false,
  tagPrefixDispatch: '',
  wikiLinkEntities: false
}

module.exports = MarkdownPlugin

// Exposed for the test harness; no effect on Tropy's plugin loader.
module.exports._internals = {
  parseCsvSet,
  parseDispatch,
  dispatchTags,
  slugify,
  shortHash,
  filenameFor,
  yamlScalar,
  composeSource,
  htmlToMarkdown,
  noteToMarkdown,
  extractNotes,
  extractPhotoPaths,
  buildFrontmatter,
  buildBody,
  assembleMarkdown
}
