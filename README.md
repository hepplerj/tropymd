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
2. *File → Export → Tropy.md*.
3. If you didn't pre-configure an output directory, you'll be prompted.
4. The plugin writes one `tropy-<hash>-<slug>.md` file per item.

## Configuration

All settings are optional — out of the box, the plugin works without any
configuration. Click *Settings* on the plugin's row in *Preferences →
Plugins* to adjust:

### Output directory

Absolute path where Markdown files land. Leave blank to be prompted at
export time.

### Workflow tags to drop

Comma-separated list of Tropy tag names that should be filtered out of the
export entirely. Default: `to-obsidian,to-process,to-transcribe,in-obsidian`.
Anything you use as a workflow marker (and don't want appearing in your
notes) goes here.

### Include photo paths in frontmatter

When enabled (default), each item's exported file gets a `photos:` YAML
field listing the absolute path of every photo on the item. Useful for
embedding images in your Markdown notes (`![](path/to/photo.jpg)`) or
linking back from your vault to the original scans.

### Skip items with no notes

Off by default. When enabled, items that have no note content are not
exported (so you don't get frontmatter-only stub files for items you
haven't analyzed yet).

### Tag prefix dispatch

The headline opt-in feature. Routes prefixed Tropy tags into named YAML
frontmatter fields instead of dumping everything into a flat `tags:` list.
Format is comma-separated, each entry being one of:

- `prefix/=field` — explicit field name
- `prefix/` — uses the prefix (without trailing slash) as the field name

Two prefixes can route to the same field. Tags whose prefix isn't listed
remain in the flat `tags:` list — there's no surprise dispatch.

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

When off, plain strings:

```yaml
people:
  - "Theodore Roosevelt"
```

Has no effect unless tag prefix dispatch is configured.

### Compose source fields

On by default. When enabled, the standard archival fields (`source`,
`archive`, `collection`, `box`, `folder`) are joined into a single
`source:` string in the order *Repository, Archive, Collection, Box,
Folder*, skipping empty parts. When disabled, each field is emitted as
its own YAML key — closer to how Tropy templates structure them, and
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
`<!-- page N -->` markers — those only appear when an item has notes
spanning multiple photos. Items with no notes get the same frontmatter
and an empty body, unless *Skip items with no notes* is enabled.

### Custom template fields

Top-level item properties that aren't recognized as standard archival
metadata are passed through as YAML fields. If you have a custom Tropy
template with a `grant-num` field, it'll appear in the frontmatter as
`grant-num: "..."` rather than getting silently dropped. URI-shaped keys
(e.g. `http://example.org/grant#num`) get cleaned to their local name
(`num`) — be aware that this is a local-name heuristic; collisions across
namespaces are possible. A more rigorous version that reads Tropy's
ontology is on the roadmap.

## Idempotency

Each output filename embeds an 8-character `tropy_hash` derived from a
fingerprint of stable item fields (title, template, source, archive
hierarchy, photo paths, tags). Re-running the export against the same
output directory skips items whose hash already appears on disk. To force
a re-export of an item, delete its file from the output directory.

## Roadmap

- [x] **v0.1.x** — per-item Markdown, content-hash idempotency, configurable
  workflow tags, photo paths, skip-empty toggle.
- [x] **v0.2.0** — tag prefix dispatch + wiki-link mode.
- [x] **v0.3.0** — page markers from photo positions; composable vs separate
  source fields; pass-through of custom template properties.
- [ ] **v0.4.0** — Tropy ontology integration for fully-labeled custom
  template fields; selection-attached notes (notes on cropped regions).
- [ ] **v1.0.0** — feature-complete, polished docs, stable API.

## Development

Clone the repo, then symlink the plugin into Tropy's plugin directory for
live editing:

```sh
ln -s "$(pwd)" "$HOME/Library/Application Support/Tropy/plugins/tropymd"
```

(Linux: `~/.config/Tropy/plugins/`. Windows: `%APPDATA%\Tropy\plugins\`.)

In Tropy, enable *Preferences → Advanced → Developer mode*, reload the
project window, and *Developer → Toggle Developer Tools* to see logs and
inspect state.

The plugin has no external dependencies and no build step. Just edit
`index.js` and reload.

## License

MIT — see [LICENSE](LICENSE).
