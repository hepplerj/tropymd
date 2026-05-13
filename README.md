# Tropy.md

A [Tropy](https://tropy.org) plugin that exports the items in your current
selection to Markdown files with YAML frontmatter — one file per item — for
use in Obsidian, Logseq, Foam, iA Writer, or any other Markdown-aware tool.

The export is one-way only: Tropy stays the source of record for archival
metadata, and your Markdown notes are the analytical layer on top. The
plugin is designed to be re-run safely; items already on disk (matched by
content hash) are skipped on subsequent runs.

## Installation

1. Download the `tropymd-v*.zip` from the [latest release](https://github.com/hepplerj/tropymd/releases/latest).
2. In Tropy, *Preferences → Plugins → Install Plugin*, select the zip.
3. Click *Settings* on the new "Tropy.md" row to configure (optional).

## Usage

1. Select one or more items in Tropy's project view.
2. *File → Export → tropymd*.
3. If you didn't pre-configure an output directory, you'll be prompted.
4. The plugin writes one `tropy-<hash>-<slug>.md` file per item.

## Configuration

All settings are optional. Out of the box, the plugin works without any
configuration.

### Output directory

Absolute path where Markdown files are created. Leave blank to be prompted at
export time.

### Workflow tags to drop

Comma-separated list of Tropy tag names that should be filtered out of the
export entirely. Default: `to-obsidian,to-process,to-transcribe,in-obsidian`.
Anything you use as a workflow marker (and don't want appearing in your
notes) goes here.

### Include photo paths in frontmatter

When enabled (default), each item's exported file gets a `photos:` YAML
field listing the absolute path of every photo on the item.

### Skip items with no notes

Off by default. When enabled, items that have no note content are not
exported (so you don't get frontmatter-only stub files for items you
haven't analyzed yet).

### Tag prefix dispatch

Routes prefixed Tropy tags into named YAML frontmatter fields instead of dumping 
everything into a flat `tags:` list. Format is comma-separated, each entry being one of:

- `prefix/=field` — explicit field name
- `prefix/` — uses the prefix (without trailing slash) as the field name

Two prefixes can route to the same field. Tags whose prefix isn't listed
remain in the flat `tags:` list.

**Example config:**

```
person/=people, place/=locations, org/=organization, gov/=organization, theme/=themes, legislation/=legislation, event/=events
```

**Result:** a Tropy tag like `person/Theodore Roosevelt` lands in
`people: ["Theodore Roosevelt"]` instead of
`tags: ["person/Theodore Roosevelt"]`. Both `org/Sierra Club` and
`gov/U.S. Forest Service` route into the shared `organization:` field.

Default: empty (no dispatch — all tags stay in `tags:`).

### Wrap dispatched values as `[[wiki-links]]`

Off by default. When enabled, dispatched entity values are wrapped as
`[[name]]` (Obsidian/Roam/Logseq style):

```yaml
people:
  - "[[Theodore Roosevelt]]"
```

When off, it returns plain strings:

```yaml
people:
  - "Theodore Roosevelt"
```

This has no effect unless tag prefix dispatch is configured.

### Filename pattern

Template for the output filenames (`.md` is appended automatically).
Default: `tropy-{hash}-{slug}`. Available placeholders:

- `{hash}` — 8-character content hash (drives idempotency)
- `{slug}` — short slugified title, lowercase + hyphens (≤60 chars)
- `{title}` — full slugified title (no length cap)
- `{name}` — human-readable title: case and spaces preserved, only
  filesystem-illegal characters (`< > : " / \ | ? *`) stripped
- `{date}` — the item's date as it appears in Tropy
- `{type}` — the doc type (e.g. `letter`, `newspaper`)
- `{creator}` — slugified creator name

Missing values collapse cleanly so a missing `{date}` doesn't leave a stray
hyphen. Idempotency reads the `tropy_hash:` value from existing files'
frontmatter, so any pattern works without breaking new exports.

When two items would produce the same filename — for example two
articles titled "The Sagebrush Rebellion" from different newspapers,
both rendered with `{name}` — the second and later get an OS-style
suffix: `The Sagebrush Rebellion (2).md`, `The Sagebrush Rebellion (3).md`,
and so on.

Examples:

| Pattern | Result |
|---|---|
| `tropy-{hash}-{slug}` (default) | `tropy-a1b2c3d4-letter-from-pinchot.md` |
| `{name}` | `Letter from Pinchot to Roosevelt.md` |
| `{date} {name}` | `1907-10-15 Letter from Pinchot to Roosevelt.md` |
| `{date}-{slug}` | `1907-10-15-letter-from-pinchot.md` |
| `{type}/{slug}` | `letter/letter-from-pinchot.md` |

### Embed photos in the body

Off by default. When enabled, each page's notes get a Markdown embed
line above them so editors that render image links inline (Obsidian,
Logseq, iA Writer) show the scan next to the analysis. The embed uses
the `file:///` URI scheme and angle-bracket form so absolute paths with
spaces render correctly in Obsidian:

```markdown
## Notes

<!-- page 1 -->

![IMG_8646](<file:////path/to/scan-001.jpeg>)

[notes for page 1]

<!-- page 2 -->

![IMG_8647](<file:////path/to/scan-002.jpeg>)

[notes for page 2]
```

The alt text is the photo's filename without its extension. The plugin
emits absolute filesystem paths; some editors (like Obsidian) require
vault-relative paths or a specific image-loading config.

### Field rename

Comma-separated `from=to` rules that rename top-level YAML field names.
Default: empty (no renames). Each rule can optionally be scoped to
specific doc types with an `@type|type|...` suffix; rules without a
scope apply to every exported item.

**An example: correspondence.** Tropy's correspondence
template stores the recipient as `dc:audience` (which the plugin emits
as `audience:`) and the author as `dc:creator` (emitted as `creator:`).
Your Obsidian convention, however, might be `author:` and `recipient:` but only
*for letters and similar correspondence*. On a newspaper article,
`creator:` should stay as `creator:`. Scoping handles this:

```
creator=author@letter|memorandum|telegram,
audience=recipient@letter|memorandum|telegram
```

Now `creator → author` only applies when `doc_type` is `letter`,
`memorandum`, or `telegram`; on newspaper or generic-document items,
`creator:` stays as `creator:`.

**Unscoped rules apply everywhere.** If you want `publication:` renamed
to `published-in:` regardless of doc type, drop the scope:

```
publication=published-in
```

**Combining the two.** A single config line can mix scoped and unscoped
rules:

```
creator=author@letter|memorandum|telegram, audience=recipient@letter|memorandum|telegram, publication=published-in
```

**What the rule applies to:** standard frontmatter fields (`title`,
`creator`, `publication`, `date`, `doc_type`, `source`, `archive`,
`collection`, `box`, `folder`, `tags`, `photos`) and any custom
template properties that flow through the passthrough. It does **not**
apply to tag-dispatched entity fields. Use the Tag prefix dispatch
setting to name those. The internal `tropy_hash:` field is also
non-renamable since idempotency depends on it.

### Compose source fields

On by default. When enabled, the standard archival fields (`source`,
`archive`, `collection`, `box`, `folder`) are joined into a single
`source:` string in the order *Repository, Archive, Collection, Box,
Folder*, skipping empty parts. When disabled, each field is emitted as
its own YAML key similar to how Tropy templates structure them, and
useful if your downstream tooling (e.g. Obsidian Dataview) prefers
querying individual archival fields.

Composed (default):

```yaml
source: "Library of Congress, Gifford Pinchot Papers, Box 12, Folder 3"
```

Separate:

```yaml
source: "Library of Congress"
collection: "Gifford Pinchot Papers"
box: "Box 12"
folder: "Folder 3"
```

## Output shape

A typical exported file looks like this (with dispatch + wiki-links
configured):

```markdown
---
title: "Letter from Pinchot to Roosevelt"
creator: "Gifford Pinchot"
publication: ""
date: "1907-10-15"
doc_type: "letter"
source: "Library of Congress, Gifford Pinchot Papers, Box 12, Folder 3"
people:
  - "[[Gifford Pinchot]]"
  - "[[Theodore Roosevelt]]"
locations: []
organization:
  - "[[U.S. Forest Service]]"
themes:
  - "[[conservation]]"
tags: []
photos:
  - "/path/to/scan-001.jpeg"
  - "/path/to/scan-002.jpeg"
tropy_hash: a1b2c3d4
---

## Notes

<!-- page 1 -->

[notes attached to the first photo]

<!-- page 2 -->

[notes attached to the second photo]
```

Items with notes on a single photo (or no photo at all) skip the
`<!-- page N -->` markers. Those only appear when an item has notes
spanning multiple photos. Items with no notes get the same frontmatter
and an empty body, unless *Skip items with no notes* is enabled in the settings.

### Custom template fields

Top-level item properties that aren't recognized as standard archival
metadata are passed through as YAML fields. If you have a custom Tropy
template with a `grant-num` field, it'll appear in the frontmatter as
`grant-num: "..."` rather than getting silently dropped. URI-shaped keys
are first looked up in Tropy's ontology: if the property has a label
defined, the YAML key uses the label (e.g. "Grant Number"). If no label
is found, the key falls back to the URI's local name. **Collisions across
namespaces are still possible** when two distinct URIs share the same
local name and neither has an ontology label.

## Idempotency

Each output filename embeds an 8-character `tropy_hash` derived from a
fingerprint of stable item fields (title, template, source, archive
hierarchy, photo paths, tags). Re-running the export against the same
output directory skips items whose hash already appears on disk. To force
a re-export of an item, delete its file from the output directory.

## Development

The plugin has no external dependencies and no build step — it's a single
hand-written `index.js`. A `Makefile` wraps the common operations:

```sh
make help        # show all targets
make zip         # build build/tropymd-vX.Y.Z.zip (release)
make dev-zip     # build build/tropymd-dev.zip (installs as 'Tropy.md (dev)')
make clean       # remove build/
```

### Debugging

Enable *Preferences → Advanced → Developer mode*, then *Developer →
Toggle Developer Tools*. The plugin's `console.log()` output appears in
the DevTools console; `this.context.logger.info(...)` lines also land in
Tropy's `tropy.log` (Help → Show Logs Folder).

You can also evaluate `tropy.state()` in the DevTools console to inspect
the live ontology, templates, and plugin options.

## License

[MIT LICENSE](LICENSE).
