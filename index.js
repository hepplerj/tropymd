'use strict'

// Tropy.md — v1.3.0
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
  // Parses the fieldRename config into a Map<from, { to, types }>.
  //
  // Format: comma-separated `from=to` pairs, with an optional doc-type
  // scope per rule introduced by `@`. Multiple types in the scope are
  // separated by `|` (since comma is the rule separator). Example:
  //
  //   creator=author@letter|memorandum|telegram,
  //   audience=recipient@letter|memorandum|telegram,
  //   publication=published-in
  //
  // A rule with no `@` applies to every item; a rule with `@` applies
  // only when the item's `doc_type` matches one of the listed types.
  // The motivating case is correspondence: dc:creator semantically means
  // "author" only on letters/memos/telegrams, not on newspaper articles
  // — the scope keeps a rename from leaking across doc types.
  const map = new Map()
  for (const entry of String(s || '').split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const from = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    let types = null
    const at = value.lastIndexOf('@')
    if (at >= 0) {
      const list = value.slice(at + 1)
      value = value.slice(0, at).trim()
      const parts = list.split('|')
        .map(t => t.trim().toLowerCase())
        .filter(Boolean)
      if (parts.length > 0) types = new Set(parts)
    }
    if (from && value) map.set(from, { to: value, types })
  }
  return map
}

function renameYamlKey(opts, key, item) {
  // Returns the renamed YAML key, or the original key if no rule applies.
  // `item` is consulted to satisfy any doc-type scope on the matching rule.
  if (!opts.fieldRename) return key
  const rule = opts.fieldRename.get(key)
  if (!rule) return key
  if (rule.types) {
    const docType = String((item && item.type) || '').toLowerCase()
    if (!rule.types.has(docType)) return key
  }
  return rule.to
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

function sanitizeFilename(s, maxLen = 150) {
  // Produces a filesystem-safe but human-readable filename component:
  // case and spaces preserved, only the characters that confuse Windows,
  // macOS, or Obsidian's wiki-link parser are stripped. Suitable for
  // titles like "The Sagebrush Rebellion" — the result reads naturally
  // in a vault while still being a valid filename on every common OS.
  return String(s || '')
    // Filesystem-illegal everywhere: < > : " / \ | ? * and control chars.
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    // Stripped to keep Obsidian's wiki-link parser happy: # ^ [ ].
    .replace(/[#^[\]]/g, '')
    // Collapse runs of whitespace.
    .replace(/\s+/g, ' ')
    .trim()
    // Trim trailing dots — Windows treats "name." and "name" as the same.
    .replace(/\.+$/, '')
    .trim()
    .slice(0, maxLen)
    .trim()
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
  // Substitutes {key} placeholders with values from `vars`. Values are
  // expected to be pre-formatted (slugified or sanitized as appropriate
  // for that variable). Missing/empty values render as empty; the result
  // is then cleaned of double-hyphens and leading/trailing hyphens or
  // whitespace so a missing piece doesn't leave a stray separator.
  let out = String(pattern || '').replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k]
    return v == null ? '' : String(v)
  })
  out = out
    .replace(/-{2,}/g, '-')
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .trim()
  return out
}

function filenameFor(item, hash, opts) {
  // Variables come in two flavors: slug-style (lowercase + hyphens, safe
  // for any filesystem and any URL) and human-readable (case + spaces
  // preserved via sanitizeFilename). Pattern authors choose between them
  // by picking the right placeholder name.
  const title = item.title || ''
  const vars = {
    hash,
    slug:    slugify(title),
    title:   slugify(title, 1000),
    name:    sanitizeFilename(title),
    date:    item.date || '',
    type:    item.type ? slugify(item.type, 1000) : '',
    creator: slugify(item.creator || '', 1000)
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

function buildItemIdIndex(state) {
  // Builds a Map<photoPath, itemId> from Tropy's Redux store so we can
  // recover the internal item ID for a JSON-LD item — the export hook
  // doesn't surface item IDs anywhere in its payload, but the store knows
  // them. Matching on first-photo path is reliable: paths are unique per
  // item and stable across exports (unlike checksums, which Tropy
  // sometimes ships as md5-of-empty-string when it hasn't fully processed
  // an import).
  const items = (state && state.items) || {}
  const photos = (state && state.photos) || {}
  const index = new Map()
  for (const item of Object.values(items)) {
    const photoIds = (item && item.photos) || []
    if (photoIds.length === 0) continue
    const firstPhoto = photos[photoIds[0]]
    if (firstPhoto && firstPhoto.path) {
      index.set(firstPhoto.path, item.id)
    }
  }
  return index
}

function tropyUrlFor(item, state, itemIndex) {
  // Returns a `tropy://project/current/items/<itemId>/<photoId>` URL when
  // we can recover the internal IDs from the store, or null otherwise.
  // The plugin emits the URL into the frontmatter as `tropy_url:` when
  // present so users can click back into Tropy from their Markdown editor.
  if (!itemIndex || !state) return null
  const photos = Array.isArray(item.photo) ? item.photo : []
  if (photos.length === 0 || !photos[0] || !photos[0].path) return null
  const itemId = itemIndex.get(photos[0].path)
  if (itemId == null) return null
  const storeItem = state.items && state.items[itemId]
  if (!storeItem) return `tropy://project/current/items/${itemId}`
  // Prefer cover_image_id when set (rare in practice); otherwise the
  // first photo in the item's photos array — matches the Python script.
  const coverId = storeItem.cover_image_id != null
    ? storeItem.cover_image_id
    : (Array.isArray(storeItem.photos) ? storeItem.photos[0] : null)
  if (coverId == null) return `tropy://project/current/items/${itemId}`
  return `tropy://project/current/items/${itemId}/${coverId}`
}

function photoEmbedMarkdown(photo) {
  // Returns a Markdown embed line for a photo, or null if the photo has
  // no path. Format:
  //
  //   ![<filename-stem>](<file:///<absolute path>>)
  //
  // The `file:///` URI scheme is what Obsidian (and most editors that
  // support absolute-path embedding) need to render the image. Angle
  // brackets around the URL are mandatory because Tropy paths frequently
  // contain spaces. The filename stem doubles as alt text for editors
  // that show captions.
  if (!photo || !photo.path) return null
  const filename = photo.filename || ''
  const stem = filename.replace(/\.[^.]+$/, '')
  return `![${stem}](<file:///${photo.path}>)`
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
  // helper closes over `item` so doc-type-scoped rules (e.g. only rename
  // `creator` for letters) can do the right thing. The internal
  // `tropy_hash:` and dispatched entity fields are intentionally not
  // renamable — the former because idempotency depends on it, the latter
  // because tagPrefixDispatch already names those fields directly.
  const k = name => renameYamlKey(opts, name, item)

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

  // Tropy deep-link back to the source item. Constructed from internal
  // IDs recovered via the Redux store; null when the lookup fails (e.g.
  // running against a Tropy version with a different store shape).
  const tropyUrl = tropyUrlFor(item, opts.state, opts.itemIndex)
  if (tropyUrl) lines.push(`${k('tropy_url')}: ${yamlScalar(tropyUrl)}`)

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
    const embed = photoEmbedMarkdown(photo)
    if (embed) inner.push(embed)
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

  async existingFilenames(outDir) {
    // Returns a case-insensitive Set of filenames already in the output
    // directory. Used to resolve filename collisions when two items would
    // otherwise want the same name (e.g. two articles titled "The
    // Sagebrush Rebellion" from different sources, both rendered with
    // the human-readable {name} placeholder).
    try {
      const files = await fs.readdir(outDir)
      return new Set(files.map(f => f.toLowerCase()))
    } catch {
      return new Set()
    }
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
    // Pull Tropy's ontology + items/photos index from the Redux store. The
    // ontology gives us human-readable labels for custom-property URIs;
    // the index lets us recover internal item IDs (not in the JSON-LD
    // payload) so we can build `tropy://` URLs back to each item. Older
    // Tropy versions or different store shapes degrade gracefully — both
    // lookups return null on any failure and the rest of the plugin
    // adjusts.
    let state = null
    try {
      state = this.context.window && this.context.window.store
        ? this.context.window.store.getState()
        : null
    } catch {
      state = null
    }
    const ontology = (state && state.ontology) || null
    const itemIndex = state ? buildItemIdIndex(state) : null

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
      ontology,
      state,
      itemIndex
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
    const usedNames = await this.existingFilenames(outDir)
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
        // Resolve filename collisions: if the computed filename already
        // exists in the output directory (or has been used earlier in
        // this batch), append `(2)`, `(3)`, etc. until unique. Matches
        // the OS-level rename behavior users already recognize.
        let candidate = filenameFor(item, hash, opts)
        if (usedNames.has(candidate.toLowerCase())) {
          const stem = candidate.replace(/\.md$/, '')
          let n = 2
          do {
            candidate = `${stem} (${n}).md`
            n++
          } while (usedNames.has(candidate.toLowerCase()))
        }
        usedNames.add(candidate.toLowerCase())

        const target = path.join(outDir, candidate)
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
  sanitizeFilename,
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
  photoEmbedMarkdown,
  buildItemIdIndex,
  tropyUrlFor,
  localName,
  looksLikeUri,
  ontologyLabel,
  buildFrontmatter,
  buildBody,
  assembleMarkdown
}
