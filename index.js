'use strict'

// Tropy.md — v1.0.0
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

function parseFieldRename(s) {
  // Parses the fieldRename config into a Map<from, to>.
  //
  // Format: comma-separated `from=to` pairs. The keys are the YAML field
  // names the plugin would have written by default; the values are the
  // names to use instead. Example:
  //
  //   creator=author, audience=recipient, publication=published-in
  //
  // Useful for matching downstream conventions (e.g. Tropy stores
  // correspondence "recipient" as dc:audience, which the plugin emits
  // through its passthrough as `audience:` — users who want `recipient:`
  // map it explicitly here).
  const map = new Map()
  for (const entry of String(s || '').split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const from = trimmed.slice(0, eq).trim()
    const to = trimmed.slice(eq + 1).trim()
    if (from && to) map.set(from, to)
  }
  return map
}

function renameYamlKey(opts, key) {
  if (!opts.fieldRename) return key
  return opts.fieldRename.get(key) || key
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

function applyFilenamePattern(pattern, vars) {
  // Substitutes {key} placeholders. Missing/empty values render as empty,
  // and the result is then cleaned of double-hyphens / leading-trailing
  // hyphens so a missing piece doesn't leave a stray separator.
  let out = String(pattern || '').replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k]
    return v == null ? '' : slugify(v, 1000)
  })
  out = out
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim()
  return out
}

function filenameFor(item, hash, opts) {
  const vars = {
    hash,
    slug: slugify(item.title),
    title: slugify(item.title, 1000),
    date: item.date || '',
    type: item.type || '',
    creator: item.creator || ''
  }
  const stem = applyFilenamePattern(opts.filenamePattern, vars)
    || `tropy-${hash}`  // fallback if pattern collapses to empty
  return `${stem}.md`
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
  for (const page of extractPages(item)) {
    out.push(...page.notes)
  }
  return out
}

function extractPages(item) {
  // Returns an array of { pageNum, notes } for each photo that has at least
  // one non-empty note. Page numbers are 1-indexed by photo array position
  // (which matches Tropy's "position" — the photo's order within the item).
  //
  // Notes attached to selections (rectangular regions on the photo) are
  // aggregated under their parent photo's page. The plugin doesn't preserve
  // the visual region — selection notes appear alongside whole-photo notes,
  // because at the item-level frontmatter layer page-specific entity
  // tracking isn't useful and the analytical layer downstream is where
  // finer-grained context goes.
  const photos = Array.isArray(item.photo) ? item.photo : []
  const pages = []
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i]
    const photoNotes = Array.isArray(photo.note) ? photo.note : []
    const selections = Array.isArray(photo.selection) ? photo.selection : []
    const selectionNotes = []
    for (const sel of selections) {
      if (Array.isArray(sel.note)) selectionNotes.push(...sel.note)
    }
    const rendered = []
    for (const note of [...photoNotes, ...selectionNotes]) {
      const md = noteToMarkdown(note)
      if (md) rendered.push(md)
    }
    if (rendered.length > 0) {
      pages.push({ pageNum: i + 1, notes: rendered })
    }
  }
  return pages
}

function extractPhotoPaths(item) {
  const photos = Array.isArray(item.photo) ? item.photo : []
  return photos.map(p => (p && p.path) || '').filter(Boolean)
}


// ----- assembly -------------------------------------------------------------

// Top-level keys in the JSON-LD item that are structural — not user data and
// never emitted as YAML fields.
const STRUCTURAL_KEYS = new Set([
  '@type', '@context', '@id',
  'template', 'photo', 'note', 'selection', 'tag'
])

// Top-level keys this plugin renders explicitly into named YAML fields.
const RENDERED_EXPLICITLY = new Set([
  'title', 'creator', 'publisher', 'date', 'type'
])

// Keys that participate in source composition. When composeSource is true,
// these are merged into the single `source:` field. When false, each is
// emitted as its own YAML field.
const SOURCE_PARTS = ['source', 'archive', 'collection', 'box', 'folder']

function localName(uri) {
  // For URI-shaped keys like http://example.org/grant#number, return `number`.
  // For non-URI keys, return as-is.
  const m = String(uri).match(/[#/]([^#/]+)\/?$/)
  return m ? m[1] : String(uri)
}

function looksLikeUri(s) {
  return /^https?:\/\//.test(String(s))
}

function ontologyLabel(ontology, uri) {
  // Returns a human-readable label from Tropy's ontology, or null if no
  // entry exists. The shape of `state.ontology.props` isn't formally
  // documented; we look at the most likely keys and gracefully give up
  // when none are present.
  const props = ontology && ontology.props
  if (!props) return null
  const meta = props[uri]
  if (!meta) return null
  return meta.label || meta.title || meta.name || null
}

function emitYamlValue(lines, key, value) {
  // Emits one YAML key with either a scalar or a list value. Skips empties.
  if (value == null || value === '') return
  if (Array.isArray(value)) {
    if (value.length === 0) return
    lines.push(`${key}:`)
    for (const v of value) lines.push(`  - ${yamlScalar(v)}`)
  } else {
    lines.push(`${key}: ${yamlScalar(value)}`)
  }
}

function buildFrontmatter(item, hash, opts) {
  const allTags = (Array.isArray(item.tag) ? item.tag : [])
    .filter(t => t && !opts.workflowTags.has(t))

  const { fields, fieldOrder, leftover } = dispatchTags(allTags, opts.dispatch)

  // Helper to keep emit sites readable. fieldRename is consulted at every
  // YAML-key emission so users can match any downstream convention. The
  // internal `tropy_hash:` and dispatched entity fields are intentionally
  // not renamable — the former because idempotency depends on it, the
  // latter because tagPrefixDispatch already names those fields directly.
  const k = name => renameYamlKey(opts, name)

  const lines = ['---']
  lines.push(`${k('title')}: ${yamlScalar(item.title)}`)
  if (item.creator) lines.push(`${k('creator')}: ${yamlScalar(item.creator)}`)
  if (item.publisher) lines.push(`${k('publication')}: ${yamlScalar(item.publisher)}`)
  if (item.date) lines.push(`${k('date')}: ${yamlScalar(item.date)}`)
  if (item.type) lines.push(`${k('doc_type')}: ${yamlScalar(item.type)}`)

  // Source: either composed into one string, or emitted as separate fields.
  if (opts.composeSource) {
    const source = composeSource(item)
    if (source) lines.push(`${k('source')}: ${yamlScalar(source)}`)
  } else {
    for (const part of SOURCE_PARTS) {
      if (item[part]) lines.push(`${k(part)}: ${yamlScalar(item[part])}`)
    }
  }

  // Custom template properties — anything else on the item that isn't
  // structural or already rendered. Lets users with custom Tropy templates
  // see their data without us needing to know each field in advance.
  // URI-shaped keys are preferentially resolved through Tropy's ontology
  // for human-readable labels; falls back to the URI's local name. The
  // fieldRename map applies on top so users can rename whatever they like.
  const handled = new Set([
    ...STRUCTURAL_KEYS,
    ...RENDERED_EXPLICITLY,
    ...SOURCE_PARTS
  ])
  for (const key of Object.keys(item)) {
    if (handled.has(key)) continue
    let yamlKey = key
    if (looksLikeUri(key)) {
      yamlKey = ontologyLabel(opts.ontology, key) || localName(key)
    }
    emitYamlValue(lines, k(yamlKey), item[key])
  }

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
    lines.push(`${k('tags')}: []`)
  } else {
    lines.push(`${k('tags')}:`)
    for (const tag of leftover) lines.push(`  - ${yamlScalar(tag)}`)
  }

  if (opts.includePhotoPaths) {
    const paths = extractPhotoPaths(item)
    if (paths.length === 0) {
      lines.push(`${k('photos')}: []`)
    } else {
      lines.push(`${k('photos')}:`)
      for (const p of paths) lines.push(`  - ${yamlScalar(p)}`)
    }
  }

  lines.push(`tropy_hash: ${hash}`)
  lines.push('---')
  return lines.join('\n')
}

function buildBody(item, opts) {
  // The body is a single `## Notes` section. With multi-page items each
  // page is preceded by `<!-- page N -->`. With photo embedding enabled,
  // each page also gets an `![](path)` line for its photo.
  //
  // Behavior matrix:
  //   embedPhotos=false, no notes              -> empty body
  //   embedPhotos=false, single-page notes     -> ## Notes + content
  //   embedPhotos=false, multi-page notes      -> ## Notes + page markers
  //   embedPhotos=true,  any photos            -> ## Notes + per-page
  //                                                blocks (embed + notes)
  // Page numbers are 1-indexed by photo array position. Pages with neither
  // a photo path nor any notes are skipped entirely.
  const photos = Array.isArray(item.photo) ? item.photo : []
  const pages = extractPages(item)
  const pagesByNum = new Map(pages.map(p => [p.pageNum, p]))

  if (!opts.embedPhotos) {
    if (pages.length === 0) return '\n'
    const parts = ['', '## Notes', '']
    if (pages.length === 1) {
      parts.push(pages[0].notes.join('\n\n'))
    } else {
      const blocks = pages.map(p =>
        `<!-- page ${p.pageNum} -->\n\n${p.notes.join('\n\n')}`
      )
      parts.push(blocks.join('\n\n'))
    }
    parts.push('')
    return parts.join('\n')
  }

  // embedPhotos: per-page rendering (photo + that photo's notes if any).
  if (photos.length === 0 && pages.length === 0) return '\n'
  const showMarkers = photos.length > 1
  const blocks = []
  for (let i = 0; i < photos.length; i++) {
    const pageNum = i + 1
    const photo = photos[i]
    const page = pagesByNum.get(pageNum)
    const inner = []
    if (showMarkers) inner.push(`<!-- page ${pageNum} -->`)
    if (photo && photo.path) inner.push(`![](${photo.path})`)
    if (page) inner.push(page.notes.join('\n\n'))
    if (inner.length > 0) blocks.push(inner.join('\n\n'))
  }
  if (blocks.length === 0) return '\n'

  const parts = ['', '## Notes', '']
  parts.push(blocks.join('\n\n'))
  parts.push('')
  return parts.join('\n')
}

function assembleMarkdown(item, hash, opts) {
  return buildFrontmatter(item, hash, opts) + '\n' + buildBody(item, opts)
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
    // Reads the `tropy_hash:` value out of each existing .md file's
    // frontmatter. This is robust to any filename pattern the user has
    // configured — older versions only checked the filename, which would
    // miss matches when patterns are customized.
    let files = []
    try {
      files = await fs.readdir(outDir)
    } catch {
      return new Set()
    }
    const set = new Set()
    const HEAD_BYTES = 4096
    const fmRe = /^---\r?\n([\s\S]*?)\r?\n---/m
    const hashRe = /^tropy_hash:\s*([0-9a-f]+)/m
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      let fh
      try {
        fh = await fs.open(path.join(outDir, f), 'r')
        const buf = Buffer.alloc(HEAD_BYTES)
        await fh.read(buf, 0, HEAD_BYTES, 0)
        const head = buf.toString('utf8')
        const fm = head.match(fmRe)
        if (fm) {
          const hm = fm[1].match(hashRe)
          if (hm) set.add(hm[1])
        }
      } catch {
        // ignore unreadable files
      } finally {
        if (fh) await fh.close().catch(() => {})
      }
    }
    return set
  }

  buildOpts() {
    // Pull Tropy's ontology if available so we can resolve custom-property
    // URIs to human-readable labels. Older Tropy versions or different
    // store shapes degrade gracefully — `ontologyLabel` returns null when
    // a lookup fails.
    let ontology = null
    try {
      const state = this.context.window && this.context.window.store
        ? this.context.window.store.getState()
        : null
      ontology = (state && state.ontology) || null
    } catch {
      ontology = null
    }

    return {
      workflowTags: parseCsvSet(this.options.workflowTags),
      includePhotoPaths: this.options.includePhotoPaths !== false,
      skipEmptyNotes: this.options.skipEmptyNotes === true,
      dispatch: parseDispatch(this.options.tagPrefixDispatch),
      wikiLinkEntities: this.options.wikiLinkEntities === true,
      composeSource: this.options.composeSource !== false,
      filenamePattern: this.options.filenamePattern || 'tropy-{hash}-{slug}',
      embedPhotos: this.options.embedPhotos === true,
      fieldRename: parseFieldRename(this.options.fieldRename),
      ontology
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
        const target = path.join(outDir, filenameFor(item, hash, opts))
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
  wikiLinkEntities: false,
  composeSource: true,
  filenamePattern: 'tropy-{hash}-{slug}',
  embedPhotos: false,
  fieldRename: ''
}

module.exports = MarkdownPlugin

// Exposed for the test harness; no effect on Tropy's plugin loader.
module.exports._internals = {
  parseCsvSet,
  parseDispatch,
  parseFieldRename,
  renameYamlKey,
  dispatchTags,
  slugify,
  shortHash,
  filenameFor,
  applyFilenamePattern,
  yamlScalar,
  composeSource,
  htmlToMarkdown,
  noteToMarkdown,
  extractNotes,
  extractPages,
  extractPhotoPaths,
  localName,
  looksLikeUri,
  ontologyLabel,
  buildFrontmatter,
  buildBody,
  assembleMarkdown
}
