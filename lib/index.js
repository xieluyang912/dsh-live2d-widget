/**
 * dsh-live2d-widget — host half.
 *
 * Serves the Live2D runtime, the browser widget, the bundled/imported model
 * files, and a small JSON API that lets the widget list, switch, tune and
 * import models. The model registry and the user's preferences live in
 * $DSH_HOME so they survive plugin reinstalls (node_modules is disposable).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readZip } from './zip.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const ASSET_DIR = path.join(PACKAGE_ROOT, 'assets')
const BUILTIN_DIR = path.join(ASSET_DIR, 'models')
const RUNTIME_FILE = path.join(ASSET_DIR, 'vendor', 'l2d.min.js')
const WIDGET_FILE = path.join(ASSET_DIR, 'live2d-widget.js')

/** Imported models land here; the settings file records their metadata. */
const USER_MODEL_DIR = path.join(DSH_HOME, 'live2d-models')
const SETTINGS_FILE = path.join(DSH_HOME, '.dsh-live2d.json')

const ROUTE_BASE = '/dsh-live2d'
const MAX_ZIP_BYTES = 256 * 1024 * 1024
const MAX_FILES_BYTES = 256 * 1024 * 1024
const MAX_JSON_BYTES = 4 * 1024 * 1024
const MAX_MODEL_FILES = 4000
/** Bounds for content-sniffing model entry files: size per file and files read. */
const MAX_ENTRY_JSON_BYTES = 8 * 1024 * 1024
const MAX_ENTRY_SCAN = 400
const MAX_MODEL_BYTES = 512 * 1024 * 1024

/**
 * The shipped models: cute Japanese anime characters, plus their presentation
 * defaults and the lines they say when you click them.
 *
 * Live2D models carry no canonical size: each author draws the character at an
 * arbitrary scale inside its own canvas, so a single global default cannot make
 * a freshly picked model look right. `scale` / `position` were measured against
 * the widget's real canvas by `tools/calibrate.html`, which loads each model,
 * reads back the drawn pixels and iterates until the silhouette is centred and
 * fills the reference height.
 *
 * `entry` is explicit rather than detected because the entry file's name is not
 * standardised: Histoire and Tia both ship a bare `model.json`, and Rem ships
 * `rem.json`, so detection is only a fallback for imported models.
 */
const BUILTIN_META = {
  sagiri: {
    name: '纱雾 · 埃罗芒阿老师',
    entry: 'sagiri.model.json',
    scale: 0.874,
    position: [0.045, 0.001],
    lines: [
      '哥哥，你回来啦……',
      '不要突然开门啦，会吓到我的！',
      '今天……也要画画呢。',
      '陪、陪我说说话好不好？',
      '我才不是家里蹲呢，只是……不想出去而已。',
    ],
  },
  rem: {
    name: '雷姆 · Re:从零开始',
    entry: 'rem.json',
    scale: 0.929,
    position: [-0.01, 0.052],
    lines: [
      '雷姆，会一直相信你的。',
      '要喝杯茶吗？雷姆泡的哦。',
      '累了的话，就交给雷姆吧。',
      '姐姐大人……啊，没什么。',
      '你回来啦，欢迎回家。',
    ],
  },
  histoire: {
    name: '伊斯特 · 海王星',
    entry: 'model.json',
    scale: 1.037,
    position: [0.003, 0.028],
    lines: [
      '需要我教你什么吗？',
      '知识，就是力量哦。',
      '书本里藏着整个世界呢。',
      '请好好休息，身体最重要。',
      '今天的功课，做完了吗？',
    ],
  },
  tia: {
    name: '缇娅 · Live2D 官方示例',
    entry: 'model.json',
    scale: 0.829,
    position: [0.002, 0.127],
    lines: [
      '你好呀～今天过得怎么样？',
      '一直陪着我，谢谢你。',
      '要不要休息一下，喝口水？',
      '嘿嘿，被你看得有点害羞呢。',
      '一起加油吧！',
    ],
  },
}

/** Lines an imported model says until its owner writes their own. */
const GENERIC_LINES = [
  '你好呀～我是{n}。',
  '今天也要一起加油哦！',
  '点我一下，我就会说话啦。',
  '有什么想聊的吗？',
  '累了就休息一下吧～',
]

// Imported models are assumed to be authored at a sane size already.
const FALLBACK_SCALE = 1
const FALLBACK_POSITION = [0, 0]
/** Shown when a model has no lines at all (user cleared the box). */
const EMPTY_LINES = ['……']

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.moc': 'application/octet-stream',
  '.moc3': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** An error caused by the caller's input — reported as HTTP 400, not 500. */
function inputError(message) {
  return Object.assign(new Error(message), { code: 'BAD_INPUT' })
}

function slugify(input, fallback = 'model') {
  const base = String(input || '')
    .normalize('NFKD')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return base || fallback
}

/** Normalize an archive member path; returns null when it must be rejected. */
function safeRelPath(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned) return null
  if (/^[A-Za-z]:/.test(cleaned)) return null
  const parts = []
  for (const seg of cleaned.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') return null
    parts.push(seg)
  }
  if (!parts.length) return null
  return parts.join('/')
}

function segmentEncode(rel) {
  return rel.split('/').map(encodeURIComponent).join('/')
}

function isJunkPath(name) {
  return (
    name.startsWith('__MACOSX/') ||
    name.endsWith('.DS_Store') ||
    name.startsWith('._') ||
    /(^|\/)Thumbs\.db$/i.test(name)
  )
}

/**
 * JSON files that live beside a model but are never its entry point.
 * Deliberately does NOT exclude `*.model.json` / `*.model3.json` — those ARE
 * entries — nor bare `model.json`, which several published packs use.
 */
const COMPANION_JSON = /\.(motion3|physics3|cdi3|exp3|pose3|userdata3|exp|physics|pose|settings)\.json$/i

/** Entry names that are conventionally trustworthy without reading the file. */
function hasEntryName(name) {
  return /\.model3?\.json$/i.test(name) || /(^|\/)model\.json$/i.test(name)
}

/**
 * Whether a parsed JSON document really is a Live2D model definition.
 *
 * Packs in the wild name the entry `model.json`, `<character>.json` or anything
 * else, so the name alone cannot decide: the shape does. Cubism 3+ declares
 * `FileReferences.Moc`; Cubism 2 declares `model` plus a `textures` array.
 */
function looksLikeModelEntry(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const fr = parsed.FileReferences
  if (fr && typeof fr === 'object' && typeof fr.Moc === 'string' && fr.Moc.trim()) return true
  if (typeof parsed.model === 'string' && parsed.model.trim() && Array.isArray(parsed.textures)) return true
  return false
}

/** Lower is better; mirrors the naming conventions packs actually use. */
function entryRank(name) {
  if (/\.model3\.json$/i.test(name)) return 0
  if (/\.model\.json$/i.test(name)) return 1
  if (/(^|\/)model\.json$/i.test(name)) return 2
  return 3
}

/** Pick the entry: shallowest wins, then best-known naming, then alphabetical. */
function pickEntry(candidates) {
  let best = null
  for (const cand of candidates) {
    const depth = cand.name.split('/').length
    const rank = entryRank(cand.name)
    if (
      !best ||
      depth < best.depth ||
      (depth === best.depth && rank < best.rank) ||
      (depth === best.depth && rank === best.rank && cand.name < best.name)
    ) {
      best = { name: cand.name, depth, rank }
    }
  }
  return best ? best.name : null
}

function parseJsonBuffer(buf) {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch (err) {
    return null
  }
}

/** Find the model entry among in-memory files (zip or folder upload). */
function detectEntryFromFiles(files) {
  const candidates = []
  let scanned = 0
  for (const f of files) {
    if (!/\.json$/i.test(f.name) || COMPANION_JSON.test(f.name)) continue
    if (hasEntryName(f.name)) {
      candidates.push({ name: f.name })
      continue
    }
    if (f.data.length > MAX_ENTRY_JSON_BYTES) continue
    if (++scanned > MAX_ENTRY_SCAN) break
    if (looksLikeModelEntry(parseJsonBuffer(f.data))) candidates.push({ name: f.name })
  }
  return pickEntry(candidates)
}

/** Find the model entry inside an on-disk model directory. */
function detectEntryInDir(dir) {
  const candidates = []
  let scanned = 0
  const walk = (cur, rel, depth) => {
    if (depth > 4 || scanned > MAX_ENTRY_SCAN) return
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch (err) {
      return
    }
    for (const e of entries) {
      const next = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) {
        walk(path.join(cur, e.name), next, depth + 1)
        continue
      }
      if (!/\.json$/i.test(e.name) || COMPANION_JSON.test(e.name) || isJunkPath(next)) continue
      if (hasEntryName(e.name)) {
        candidates.push({ name: next })
        continue
      }
      const full = path.join(cur, e.name)
      try {
        if (fs.statSync(full).size > MAX_ENTRY_JSON_BYTES) continue
        if (++scanned > MAX_ENTRY_SCAN) return
        if (looksLikeModelEntry(parseJsonBuffer(fs.readFileSync(full)))) candidates.push({ name: next })
      } catch (err) {}
    }
  }
  walk(dir, '', 0)
  return pickEntry(candidates)
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch (err) {
    return fallback
  }
}

/** Write via a temp file + rename so a crash cannot leave a truncated config. */
function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp-' + process.pid
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch (cleanupErr) {}
    return false
  }
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const fail = (err) => {
      if (done) return
      done = true
      reject(err)
    }
    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        fail(Object.assign(new Error('请求体过大'), { code: 'TOO_LARGE' }))
        try {
          req.destroy()
        } catch (err) {}
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', fail)
    req.on('aborted', () => fail(new Error('请求被中断')))
  })
}

async function readJsonBody(req, limit = MAX_JSON_BYTES) {
  const buf = await readRawBody(req, limit)
  if (!buf.length) return {}
  try {
    const parsed = JSON.parse(buf.toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_JSON' })
  }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

export default {
  name: 'live2d-widget',
  inject: ['webServer', 'connection'],
  apply(ctx) {
    const disposers = []

    // ---- settings ---------------------------------------------------------
    function defaultSettings() {
      return {
        version: 1,
        activeId: null,
        visible: true,
        side: 'left',
        offset: { x: 18, y: 6 },
        opacity: 1,
        mirror: false,
        panelOpen: false,
        /**
         * Overall widget size as a multiple of the reference canvas. The model
         * is fitted to the canvas, so growing the canvas grows the character
         * without ever clipping it — this is the one true size control.
         */
        size: 1,
        /** Whether clicking the model pops a speech bubble. */
        bubble: true,
        /** How long a bubble stays up, in seconds. */
        bubbleSec: 6,
        perModel: {},
        userModels: {},
        /** Per-model line overrides: { [modelId]: string[] }. */
        lines: {},
      }
    }

    function loadSettings() {
      const d = defaultSettings()
      const s = readJson(SETTINGS_FILE, {})
      const merged = Object.assign(d, s)
      if (!merged.offset || typeof merged.offset !== 'object') merged.offset = d.offset
      if (!merged.perModel || typeof merged.perModel !== 'object') merged.perModel = {}
      if (!merged.userModels || typeof merged.userModels !== 'object') merged.userModels = {}
      if (!merged.lines || typeof merged.lines !== 'object' || Array.isArray(merged.lines)) merged.lines = {}
      // `stage` (a pixel canvas width) predates `size` (a multiplier); drop it
      // so an upgraded install does not carry a value nothing reads.
      delete merged.stage
      return merged
    }

    let settings = loadSettings()

    function saveSettings() {
      return writeJsonAtomic(SETTINGS_FILE, settings)
    }

    // ---- registry ---------------------------------------------------------
    /**
     * Whether a model's entry file is actually usable.
     *
     * A zero-byte entry makes the runtime fail deep inside its loader with an
     * opaque `Unexpected end of JSON input`, so the file is checked here where
     * the real reason can be reported. (Files really do arrive truncated: a
     * copy interrupted mid-write leaves the right name with no bytes.)
     */
    function entryIsUsable(dir, entry) {
      if (!entry) return false
      try {
        const st = fs.statSync(path.join(dir, entry))
        return st.isFile() && st.size > 0
      } catch (err) {
        return false
      }
    }

    function note(notes, id, name, reason) {
      if (Array.isArray(notes)) notes.push({ id, name, reason })
    }

    /** Resolve one model id to its on-disk directory plus metadata. */
    function resolveModel(id, notes) {
      const key = String(id || '')
      if (!key || key === '.' || key.includes('/') || key.includes('\\') || key.includes('..')) return null

      const builtinDir = path.join(BUILTIN_DIR, key)
      if (fs.existsSync(builtinDir)) {
        const meta = BUILTIN_META[key]
        // An explicit entry wins; otherwise sniff the directory contents.
        const declared = meta && meta.entry ? safeRelPath(meta.entry) : null
        const candidate =
          declared && fs.existsSync(path.join(builtinDir, declared)) ? declared : detectEntryInDir(builtinDir)
        if (!candidate) {
          note(notes, key, (meta && meta.name) || key, '找不到模型入口文件')
          return null
        }
        if (!entryIsUsable(builtinDir, candidate)) {
          note(notes, key, (meta && meta.name) || key, '模型入口文件为空，文件可能已损坏')
          return null
        }
        return {
          id: key,
          name: (meta && meta.name) || key,
          source: 'builtin',
          dir: builtinDir,
          entry: candidate,
          scale: (meta && meta.scale) || FALLBACK_SCALE,
          position: (meta && meta.position) || FALLBACK_POSITION,
          lines: (meta && meta.lines) || null,
        }
      }

      const user = settings.userModels[key]
      if (user && typeof user === 'object') {
        const dir = path.join(USER_MODEL_DIR, key)
        if (fs.existsSync(dir)) {
          const entry = user.entry && fs.existsSync(path.join(dir, user.entry)) ? user.entry : detectEntryInDir(dir)
          if (!entry) {
            note(notes, key, user.name || key, '找不到模型入口文件')
            return null
          }
          if (!entryIsUsable(dir, entry)) {
            note(notes, key, user.name || key, '模型入口文件为空，文件可能已损坏')
            return null
          }
          return {
            id: key,
            name: user.name || key,
            source: 'user',
            dir,
            entry,
            scale: Number(user.scale) || FALLBACK_SCALE,
            position: Array.isArray(user.position) ? user.position : FALLBACK_POSITION,
            lines: null,
          }
        }
        note(notes, key, user.name || key, '模型目录不存在')
      }
      return null
    }

    /** The lines a model says when clicked: user text, else its own persona. */
    function linesFor(m) {
      const override = settings.lines[m.id]
      if (Array.isArray(override)) {
        const cleaned = override.map((s) => String(s == null ? '' : s).trim()).filter(Boolean)
        // An empty override is a deliberate "say nothing": keep one placeholder
        // so a click still visibly does something.
        return cleaned.length ? cleaned : EMPTY_LINES.slice()
      }
      if (Array.isArray(m.lines) && m.lines.length) return m.lines.slice()
      return GENERIC_LINES.map((s) => s.replace('{n}', m.name))
    }

    /** Flatten a resolved model into the record the browser consumes. */
    function toRecord(m) {
      const override = settings.perModel[m.id] || {}
      return {
        id: m.id,
        name: m.name,
        source: m.source,
        entry: m.entry,
        url: ROUTE_BASE + '/model/' + encodeURIComponent(m.id) + '/' + segmentEncode(m.entry),
        // `scale` is the live fill value (1 = the model's own calibrated fit);
        // `defaultScale` is that fit, which the browser multiplies back in.
        adapt: typeof override.adapt === 'number' ? override.adapt : 1,
        position: Array.isArray(override.position) ? override.position : m.position,
        defaultPosition: m.position,
        fitScale: m.scale,
        lines: linesFor(m),
        defaultLines: Array.isArray(m.lines) && m.lines.length
          ? m.lines.slice()
          : GENERIC_LINES.map((s) => s.replace('{n}', m.name)),
        hasCustomLines: Array.isArray(settings.lines[m.id]),
      }
    }

    function listModels(notes) {
      const out = []
      const seen = new Set()

      let builtinIds = []
      try {
        builtinIds = fs
          .readdirSync(BUILTIN_DIR, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch (err) {}
      // Keep the shipped order stable and meaningful rather than alphabetical.
      const order = Object.keys(BUILTIN_META)
      builtinIds.sort((a, b) => {
        const ia = order.indexOf(a)
        const ib = order.indexOf(b)
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b)
      })

      for (const id of builtinIds.concat(Object.keys(settings.userModels))) {
        if (seen.has(id)) continue
        const m = resolveModel(id, notes)
        if (!m) continue
        seen.add(id)
        out.push(toRecord(m))
      }
      return out
    }

    // ---- trust fence ------------------------------------------------------
    // Every custom route must reject forged Host/Origin (DNS-rebinding) and
    // unauthenticated callers, exactly like the shipped plugins do.
    let fenceWarned = false
    function rejected(req, res) {
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') {
          if (!fenceWarned) {
            fenceWarned = true
            try {
              console.warn('[live2d] 信任栅栏不可用：connection 服务缺失，自定义路由将放行处理')
            } catch (err) {}
          }
          return false
        }
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch (err) {
        return false
      }
    }

    function sendJson(res, status, value) {
      const body = Buffer.from(JSON.stringify(value), 'utf8')
      res.writeHead(status, Object.assign({ 'Content-Length': body.length }, JSON_HEADERS))
      res.end(body)
    }

    function sendError(res, status, message, code) {
      sendJson(res, status, { ok: false, error: String(message || 'error'), code: code || undefined })
    }

    /** Serve one on-disk file with an ETag so big textures revalidate cheaply. */
    function sendFile(req, res, file, { immutable = false } = {}) {
      let st
      try {
        st = fs.statSync(file)
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('404 not found')
        return
      }
      if (!st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('404 not found')
        return
      }
      const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"'
      const headers = {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        ETag: etag,
      }
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control'] })
        res.end()
        return
      }
      headers['Content-Length'] = st.size
      res.writeHead(200, headers)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      const stream = fs.createReadStream(file)
      stream.on('error', () => {
        try {
          res.destroy()
        } catch (err) {}
      })
      stream.pipe(res)
    }

    function registerRoute(route) {
      const inner = route.handler
      const wrapped = Object.assign({}, route, {
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try {
            await inner(req, res)
          } catch (err) {
            if (err && err.code === 'TOO_LARGE') return sendError(res, 413, '请求体过大', 'TOO_LARGE')
            if (err && err.code === 'BAD_JSON') return sendError(res, 400, err.message, 'BAD_JSON')
            if (err && err.code === 'BAD_INPUT') return sendError(res, 400, err.message, 'BAD_INPUT')
            try {
              console.error('[live2d] route error', route.path, err)
            } catch (logErr) {}
            try {
              if (!res.headersSent) sendError(res, 500, (err && err.message) || 'internal error')
              else res.end()
            } catch (endErr) {}
          }
        },
      })
      return ctx.webServer.register(wrapped)
    }

    // ---- import pipeline --------------------------------------------------
    /** Strip the archive's single top folder so the entry sits at the root. */
    function normalizeBundle(files) {
      const clean = []
      for (const f of files) {
        const rel = safeRelPath(f.name)
        if (!rel || isJunkPath(rel)) continue
        clean.push({ name: rel, data: f.data })
      }
      if (!clean.length) throw inputError('压缩包中没有可用文件')
      const entry = detectEntryFromFiles(clean)
      if (!entry) {
        throw inputError('没有找到 Live2D 模型文件（需要 *.model3.json、*.model.json，或含 model/textures 的 json）')
      }

      const root = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : ''
      const stripped = []
      let total = 0
      for (const f of clean) {
        let rel = f.name
        if (root) {
          if (!rel.startsWith(root + '/')) continue // sibling folder, e.g. docs/ or a second model
          rel = rel.slice(root.length + 1)
        }
        if (!rel) continue
        total += f.data.length
        if (stripped.length >= MAX_MODEL_FILES) throw inputError('模型文件数量过多（超过 ' + MAX_MODEL_FILES + '）')
        if (total > MAX_MODEL_BYTES) throw inputError('模型体积过大（超过 512 MB）')
        stripped.push({ name: rel, data: f.data })
      }
      if (!stripped.length) throw inputError('模型文件为空')
      if (!stripped.some((f) => f.name === entry.slice(root ? root.length + 1 : 0))) {
        throw inputError('模型入口文件缺失')
      }
      return { entry: entry.slice(root ? root.length + 1 : 0), files: stripped }
    }

    function uniqueId(base) {
      const taken = new Set(listModels().map((m) => m.id))
      let id = base
      let n = 2
      while (taken.has(id) || fs.existsSync(path.join(USER_MODEL_DIR, id))) {
        id = base + '-' + n
        n++
      }
      return id
    }

    /** Persist a normalized bundle as a new user model and return its record. */
    function installModel(rawName, bundle) {
      const name = String(rawName || '').trim().slice(0, 80) || '导入的模型'
      const id = uniqueId(slugify(name, 'model'))
      const dir = path.join(USER_MODEL_DIR, id)
      fs.mkdirSync(dir, { recursive: true })
      try {
        for (const f of bundle.files) {
          const target = path.join(dir, f.name)
          const rel = path.relative(dir, target)
          if (rel.startsWith('..') || path.isAbsolute(rel)) throw inputError('非法的模型路径：' + f.name)
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, f.data)
        }
      } catch (err) {
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch (cleanupErr) {}
        throw err
      }

      const entry = fs.existsSync(path.join(dir, bundle.entry)) ? bundle.entry : detectEntryInDir(dir)
      if (!entry) {
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch (cleanupErr) {}
        throw inputError('模型入口文件无效')
      }

      settings.userModels[id] = { name, entry, importedAt: new Date().toISOString() }
      // A freshly imported model becomes the active one so the user sees it.
      settings.activeId = id
      saveSettings()
      const resolved = resolveModel(id)
      if (!resolved) throw inputError('模型导入后无法解析，请检查模型文件是否完整')
      return toRecord(resolved)
    }

    function statePayload() {
      const skipped = []
      const models = listModels(skipped)
      for (const s of skipped) {
        try {
          console.warn('[live2d] 跳过模型 ' + s.id + '：' + s.reason)
        } catch (err) {}
      }
      return {
        ok: true,
        version: '1.2.0',
        models,
        skipped,
        settings,
        home: DSH_HOME,
      }
    }

    // ---- routes -----------------------------------------------------------
    disposers.push(
      registerRoute({
        kind: 'exact',
        path: ROUTE_BASE + '/runtime.js',
        handler: (req, res) => sendFile(req, res, RUNTIME_FILE, { immutable: true }),
      }),
    )

    disposers.push(
      registerRoute({
        kind: 'exact',
        path: ROUTE_BASE + '/widget.js',
        handler: (req, res) => {
          let js = ''
          try {
            js = fs.readFileSync(WIDGET_FILE, 'utf8')
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('widget asset missing')
            return
          }
          const body = Buffer.from(js, 'utf8')
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': body.length,
          })
          res.end(body)
        },
      }),
    )

    disposers.push(
      registerRoute({
        kind: 'exact',
        path: ROUTE_BASE + '/api/state',
        handler: (req, res) => sendJson(res, 200, statePayload()),
      }),
    )

    disposers.push(
      registerRoute({
        kind: 'exact',
        path: ROUTE_BASE + '/api/settings',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendError(res, 405, '只支持 POST')
          const body = await readJsonBody(req)
          const next = body.settings && typeof body.settings === 'object' ? body.settings : body
          const allowed = [
            'activeId', 'visible', 'side', 'offset', 'opacity', 'mirror', 'panelOpen',
            'size', 'bubble', 'bubbleSec', 'perModel', 'lines',
          ]
          for (const key of allowed) {
            if (next[key] !== undefined) settings[key] = next[key]
          }
          if (!saveSettings()) return sendError(res, 500, '设置保存失败')
          sendJson(res, 200, { ok: true, settings })
        },
      }),
    )

    disposers.push(
      registerRoute({
        kind: 'exact',
        path: ROUTE_BASE + '/api/import-zip',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendError(res, 405, '只支持 POST')
          const buf = await readRawBody(req, MAX_ZIP_BYTES)
          if (!buf.length) return sendError(res, 400, '没有收到压缩包数据')
          const rawName = req.headers['x-model-name']
          let name = ''
          try {
            name = rawName ? decodeURIComponent(String(rawName)) : ''
          } catch (err) {
            name = String(rawName || '')
          }
          let files
          try {
            files = readZip(buf)
          } catch (err) {
            // Malformed / encrypted / unsupported archives are caller errors.
            throw inputError('解压失败：' + ((err && err.message) || err))
          }
          const bundle = normalizeBundle(files)
          const model = installModel(name || bundle.entry.replace(/\.[^.]*\.json$/i, ''), bundle)
          sendJson(res, 200, { ok: true, model, state: statePayload() })
        },
      }),
    )
    disposers.push(
      registerRoute({
        kind: 'exact',
        path: ROUTE_BASE + '/api/import-files',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendError(res, 405, '只支持 POST')
          const body = await readJsonBody(req, MAX_FILES_BYTES)
          const list = Array.isArray(body.files) ? body.files : []
          if (!list.length) return sendError(res, 400, '没有收到文件')
          const files = []
          for (const f of list) {
            if (!f || typeof f.path !== 'string' || typeof f.b64 !== 'string') continue
            files.push({ name: f.path, data: Buffer.from(f.b64, 'base64') })
          }
          const bundle = normalizeBundle(files)
          const model = installModel(body.name || bundle.entry, bundle)
          sendJson(res, 200, { ok: true, model, state: statePayload() })
        },
      }),
    )

    disposers.push(
      registerRoute({
        kind: 'exact',
        path: ROUTE_BASE + '/api/import-path',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendError(res, 405, '只支持 POST')
          const body = await readJsonBody(req)
          const src = String(body.dir || '').trim()
          if (!src) return sendError(res, 400, '请填写模型目录路径')
          let st
          try {
            st = fs.statSync(src)
          } catch (err) {
            return sendError(res, 400, '目录不存在或无法访问：' + src)
          }
          if (!st.isDirectory()) return sendError(res, 400, '该路径不是文件夹：' + src)

          const files = []
          let total = 0
          const walk = (cur, rel, depth) => {
            if (depth > 8) return
            for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
              const next = rel ? rel + '/' + e.name : e.name
              if (isJunkPath(next)) continue
              const full = path.join(cur, e.name)
              if (e.isDirectory()) walk(full, next, depth + 1)
              else if (e.isFile()) {
                const data = fs.readFileSync(full)
                total += data.length
                if (files.length >= MAX_MODEL_FILES) throw inputError('模型文件数量过多')
                if (total > MAX_MODEL_BYTES) throw inputError('模型体积过大（超过 512 MB）')
                files.push({ name: next, data })
              }
            }
          }
          walk(src, '', 0)
          const bundle = normalizeBundle(files)
          const model = installModel(body.name || path.basename(src) || bundle.entry, bundle)
          sendJson(res, 200, { ok: true, model, state: statePayload() })
        },
      }),
    )

    disposers.push(
      registerRoute({
        kind: 'exact',
        path: ROUTE_BASE + '/api/delete',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendError(res, 405, '只支持 POST')
          const body = await readJsonBody(req)
          const id = String(body.id || '')
          if (!settings.userModels[id]) return sendError(res, 400, '只能删除自己导入的模型')
          delete settings.userModels[id]
          delete settings.perModel[id]
          if (settings.activeId === id) settings.activeId = null
          try {
            fs.rmSync(path.join(USER_MODEL_DIR, id), { recursive: true, force: true })
          } catch (err) {
            return sendError(res, 500, '删除模型文件失败：' + ((err && err.message) || err))
          }
          saveSettings()
          sendJson(res, 200, { ok: true, state: statePayload() })
        },
      }),
    )

    // One prefix route serves every model file for every model, bundled or imported.
    disposers.push(
      registerRoute({
        kind: 'prefix',
        path: ROUTE_BASE + '/model',
        handler: (req, res) => {
          let pathname = '/'
          try {
            pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
          } catch (err) {
            return sendError(res, 400, '非法路径')
          }
          const rest = pathname.slice((ROUTE_BASE + '/model/').length)
          const slash = rest.indexOf('/')
          if (slash <= 0) return sendError(res, 400, '缺少模型 id')
          const id = rest.slice(0, slash)
          const rel = safeRelPath(rest.slice(slash + 1))
          if (!rel) return sendError(res, 400, '非法资源路径')

          const model = resolveModel(id)
          if (!model) return sendError(res, 404, '模型不存在：' + id)

          const target = path.resolve(model.dir, rel)
          const base = path.resolve(model.dir)
          if (target !== base && !target.startsWith(base + path.sep)) {
            return sendError(res, 403, '越权访问')
          }
          // Resolve symlinks before serving so a link cannot escape the model dir.
          let real
          try {
            real = fs.realpathSync(target)
          } catch (err) {
            return sendError(res, 404, '资源不存在')
          }
          let realBase
          try {
            realBase = fs.realpathSync(base)
          } catch (err) {
            return sendError(res, 404, '模型目录不存在')
          }
          if (real !== realBase && !real.startsWith(realBase + path.sep)) {
            return sendError(res, 403, '越权访问')
          }
          sendFile(req, res, real, { immutable: true })
        },
      }),
    )

    // ---- browser bootstrap ------------------------------------------------
    disposers.push(
      ctx.webServer.tapIndex((html) => {
        if (html.indexOf(ROUTE_BASE + '/widget.js') !== -1) return html
        const tag = '<script defer src="' + ROUTE_BASE + '/widget.js"></script>'
        if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
        return html + tag
      }),
    )

    ctx.effect(() => () => {
      for (const d of disposers) {
        try {
          d()
        } catch (err) {}
      }
    })
  },
}
