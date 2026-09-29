/**
 * Pre-publish smoke test.
 *
 * Mounts the plugin on a stub DSH context, serves it on an ephemeral port, and
 * asserts everything a fresh install needs is present and working. Wired to
 * `prepublishOnly`, so a broken tarball cannot be published.
 *
 *   node tools/verify.mjs
 *
 * Uses its own DSH_HOME so it never reads or writes a live DSH's settings.
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DSH_HOME = path.join(os.tmpdir(), 'dsh-live2d-verify-home')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const plugin = (await import('../lib/index.js')).default
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

let failures = 0
function check(label, ok, detail) {
  const line = '  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label + (detail ? '   ' + detail : '')
  console.log(line)
  if (!ok) failures++
}

// ---- 1. the files an install must carry -----------------------------------
console.log('packaged files')
const mustExist = [
  'lib/index.js',
  'lib/zip.mjs',
  'assets/live2d-widget.js',
  'assets/vendor/l2d.min.js',
  'cordis.patch.yml',
  'package.json',
  'README.md',
  'README_ZH.md',
  'LICENSE',
]
for (const rel of mustExist) check(rel, fs.existsSync(path.join(ROOT, rel)))

// Every model directory listed by BUILTIN_META must ship with a non-empty entry.
const modelDirs = fs
  .readdirSync(path.join(ROOT, 'assets', 'models'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
check('assets/models has bundled characters', modelDirs.length > 0, modelDirs.join(', '))
let zeroByte = 0
for (const dir of modelDirs) {
  const base = path.join(ROOT, 'assets', 'models', dir)
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (fs.statSync(p).size === 0) zeroByte++
    }
  }
  walk(base)
}
check('no zero-byte model file', zeroByte === 0, zeroByte ? zeroByte + ' found' : '')

// ---- 2. serve it ----------------------------------------------------------
const exact = new Map()
const prefixes = []
const taps = []
plugin.apply({
  webServer: {
    register(route) {
      if (route.kind === 'exact') {
        exact.set(route.path, route.handler)
        return () => exact.delete(route.path)
      }
      prefixes.push(route)
      prefixes.sort((a, b) => b.path.length - a.path.length)
      return () => {}
    },
    tapIndex(fn) {
      taps.push(fn)
      return () => {}
    },
  },
  get: (n) => (n === 'connection' ? { requestRejection: () => false } : undefined),
  on() {},
  effect(fn) {
    fn(() => {})
  },
})

const INDEX = '<!doctype html><html><body><div id="root"><textarea></textarea></div></body></html>'
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (p === '/') {
    let html = INDEX
    for (const t of taps) html = t(html)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html)
    return
  }
  const hit = exact.get(p)
  if (hit) return hit(req, res)
  for (const r of prefixes) if (p === r.path || p.startsWith(r.path + '/')) return r.handler(req, res)
  res.writeHead(404).end('404')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + server.address().port

async function get(p) {
  const res = await fetch(base + p)
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), res }
}
const head = async (p, headers) => {
  const res = await fetch(base + p, { headers })
  return res.status
}

try {
  console.log('\nroutes')
  const idx = await get('/')
  check('tapIndex injects the widget script', idx.buf.toString().includes('/dsh-live2d/widget.js'))

  const widget = await get('/dsh-live2d/widget.js')
  check('widget.js serves', widget.status === 200 && widget.buf.length > 1000, widget.buf.length + ' B')

  const runtime = await get('/dsh-live2d/runtime.js')
  check('runtime.js serves', runtime.status === 200 && runtime.buf.length > 100000, runtime.buf.length + ' B')

  console.log('\nstate and models')
  const state = JSON.parse((await get('/dsh-live2d/api/state')).buf.toString())
  check('api/state ok', state.ok === true)
  check('version matches package.json', state.version === pkg.version, state.version + ' vs ' + pkg.version)
  check('at least one model is usable', state.models.length > 0, state.models.length + ' models')
  check('no model was skipped', state.skipped.length === 0, JSON.stringify(state.skipped))
  check(
    'every model has lines',
    state.models.every((m) => Array.isArray(m.lines) && m.lines.length > 0),
  )
  check(
    'every model is fitted (fitScale != 1 placeholder)',
    state.models.every((m) => typeof m.fitScale === 'number' && m.fitScale !== 1),
  )

  for (const m of state.models) {
    const r = await get(m.url)
    check('serves ' + m.id + ' entry', r.status === 200 && r.buf.length > 0, r.buf.length + ' B')
  }

  console.log('\nsecurity and caching')
  for (const bad of ['/dsh-live2d/model/' + state.models[0].id + '/..%2f..%2fpackage.json']) {
    const s = await head(bad)
    check('blocks traversal', s === 400 || s === 403, 'HTTP ' + s)
  }
  const first = state.models[0]
  const etagRes = await fetch(base + first.url)
  const etag = etagRes.headers.get('etag')
  check('sends an ETag for model files', !!etag)
  if (etag) {
    const notModified = await head(first.url, { 'If-None-Match': etag })
    check('revalidates with 304', notModified === 304, 'HTTP ' + notModified)
  }
  check('rejects unknown model id', (await head('/dsh-live2d/model/no-such-model/x.json')) === 404)
} catch (err) {
  check('smoke run completed', false, String((err && err.message) || err))
} finally {
  // Close cleanly and let the loop drain: calling process.exit() here trips a
  // libuv assertion on Windows because handles are still closing, which would
  // fail the publish for no reason. Setting exitCode keeps npm's result honest.
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

console.log('')
if (failures === 0) {
  console.log('verify: all checks passed — safe to publish')
} else {
  console.log('verify: ' + failures + ' check(s) failed — do NOT publish')
  process.exitCode = 1
}
