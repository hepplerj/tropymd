'use strict'

// Local test harness — runs the plugin's export() against a JSON-LD fixture
// without needing Tropy. Mocks `context` with stub dialog + logger.
//
// Usage:
//   node test/run.js [fixture-path] [output-dir]
//   node test/run.js                                     # default fixture
//   node test/run.js export_test.json /tmp/md-out

const path = require('path')
const fs = require('fs/promises')

const Plugin = require('..')

async function main() {
  const fixture = process.argv[2] || path.join(
    __dirname, 'fixtures', 'single-item.json'
  )
  const outDir = process.argv[3] || path.join(__dirname, 'out')

  await fs.rm(outDir, { recursive: true, force: true })

  const data = JSON.parse(await fs.readFile(fixture, 'utf8'))

  const logger = {
    trace: (...a) => console.log('[trace]', ...a),
    info:  (...a) => console.log('[info ]', ...a),
    warn:  (...a) => console.warn('[warn ]', ...a),
    error: (meta, msg) => console.error('[error]', msg, meta)
  }
  const dialog = {
    open: async () => outDir,
    save: async () => null,
    fail: (err) => { throw err }
  }

  const plugin = new Plugin({ outputDir: outDir }, { dialog, logger })
  await plugin.export(data)

  const files = await fs.readdir(outDir)
  console.log(`\n=== ${files.length} file(s) in ${outDir} ===`)
  for (const f of files) {
    const full = path.join(outDir, f)
    const stat = await fs.stat(full)
    console.log(`\n--- ${f} (${stat.size} bytes) ---`)
    const content = await fs.readFile(full, 'utf8')
    console.log(content)
  }

  // Idempotency check: re-run, should skip everything.
  console.log('\n=== second run (idempotency check) ===')
  const plugin2 = new Plugin({ outputDir: outDir }, { dialog, logger })
  await plugin2.export(data)
  const filesAfter = await fs.readdir(outDir)
  if (filesAfter.length !== files.length) {
    console.error(`FAIL: file count changed (${files.length} -> ${filesAfter.length})`)
    process.exit(1)
  } else {
    console.log(`OK: file count stable at ${filesAfter.length}`)
  }
}

main().catch(err => {
  console.error('TEST FAILED:', err)
  process.exit(1)
})
