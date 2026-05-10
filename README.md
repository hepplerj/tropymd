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

**Result:** a Tropy tag like `person/Charlie Callison` lands in
`people: ["Charlie Callison"]` instead of `tags: ["person/Charlie Callison"]`.
Both `org/Sierra Club` and `gov/Bureau of Land Management` route into the
shared `organization:` field.

Default: empty (no dispatch — all tags stay in `tags:`).

### Wrap dispatched values as `[[wiki-links]]`

Off by default. When enabled, dispatched entity values are wrapped as
`[[name]]` (Obsidian/Roam/Logseq style):

```yaml
people:
  - "[[Charlie Callison]]"
```

When off, plain strings:

```yaml
people:
  - "Charlie Callison"
```

Has no effect unless tag prefix dispatch is configured.

## Output shape

A typical exported file looks like this (with dispatch + wiki-links
configured):

```markdown
---
title: "Letter from Brandborg to Smith"
creator: "Stewart M. Brandborg"
publication: ""
date: "1973-10-31"
doc_type: "letter"
source: "Denver Public Library, Wilderness Society Records, Box 44, Folder 3"
people:
  - "[[Stewart M. Brandborg]]"
locations: []
organization:
  - "[[Wilderness Society]]"
themes:
  - "[[federal land management]]"
tags: []
photos:
  - "/path/to/scan-001.jpeg"
tropy_hash: a1b2c3d4
---

## Notes

[note content here, joined with blank lines if multiple notes]
```

Items with no notes get the same frontmatter and an empty body (unless
*Skip items with no notes* is enabled).

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
- [ ] **v0.3.0** — page markers from photo positions; `## Notes` /
  `## Transcription` body sections detected via leading bold headers.
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
`index.js` and reload. To run the test harness against fixtures without
Tropy:

```sh
node test/run.js                                   # default fixture
node test/run.js test/fixtures/multi-note-item.json /tmp/out
```

## License

MIT — see [LICENSE](LICENSE).
