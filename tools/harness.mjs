/**
 * Dev harness: mount the host plugin against a stub DSH context and serve it
 * over plain HTTP, so the routes, the model registry and the browser widget can
 * be exercised without booting the full harness (and without its auth layer).
 *
 *   node tools/harness.mjs [port]
 *
 * Not shipped (excluded from package.json `files`).
 *
 * Isolation: the plugin keeps its model registry and preferences under
 * $DSH_HOME. The harness points that at its own scratch directory, because a
 * shared home lets a dev run read and overwrite the settings of a live DSH on
 * the same machine (learned the hard way). Override with DSH_HARNESS_HOME.
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DSH_HOME = process.env.DSH_HARNESS_HOME || path.join(os.tmpdir(), 'dsh-live2d-harness-home')

// Imported only after DSH_HOME is set: the plugin resolves it at module scope.
const plugin = (await import('../lib/index.js')).default

const PORT = Number(process.argv[2] || 8899)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOOLS = path.join(ROOT, 'tools')

console.log('[harness] DSH_HOME =', process.env.DSH_HOME)

// ---- stub ctx --------------------------------------------------------------
const exact = new Map()
const prefixes = []
const taps = []

const ctx = {
  webServer: {
    register(route) {
      if (route.kind === 'exact') {
        if (exact.has(route.path)) throw new Error('duplicate route ' + route.path)
        exact.set(route.path, route.handler)
        return () => exact.delete(route.path)
      }
      prefixes.push(route)
      prefixes.sort((a, b) => b.path.length - a.path.length)
      return () => {
        const i = prefixes.indexOf(route)
        if (i >= 0) prefixes.splice(i, 1)
      }
    },
    tapIndex(fn) {
      taps.push(fn)
      return () => {
        const i = taps.indexOf(fn)
        if (i >= 0) taps.splice(i, 1)
      }
    },
  },
  // The real plugin calls this to reject forged Host/Origin requests. Allow all
  // here: the harness is loopback-only dev tooling.
  get(name) {
    if (name === 'connection') return { requestRejection: () => false }
    return undefined
  },
  on() {},
  effect(fn) {
    fn(() => {})
  },
  credentials: { async resolve() { return null } },
}

plugin.apply(ctx)
console.log('[harness] plugin mounted:', plugin.name)

// ---- test index page (mimics the DSH chat shell the widget expects) ---------
// `?boot=1` reproduces DSH's real startup shape: a "Loading plugins…" overlay is
// painted into #root first and the chat composer only appears seconds later.
// That is the sequence the widget's mount gate has to survive.
const INDEX_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>dsh-live2d harness</title>
<style>
  body{margin:0;background:#f4f7fb;font:14px system-ui}
  #root{padding:24px}
  .boot{display:flex;align-items:center;justify-content:center;height:70vh;color:#5a6b82;font:600 15px system-ui}
  h3{font:600 15px system-ui;color:#334}
  .fake-composer{display:block;width:min(760px,90%);min-height:64px;margin-top:20px;padding:12px;
    border:1px solid #cdd8e6;border-radius:10px;background:#fff;font:14px system-ui;resize:none}
</style></head>
<body><div id="root"></div><pre id="diag"></pre>
<script>
// ?diag=1 instrumentation. The widget draws into its own canvas without
// preserveDrawingBuffer, so the attribute is forced here — the FIRST
// getContext call fixes the context attributes — letting the harness read the
// drawn pixels back and measure the model's real on-screen size.
if (location.search.indexOf('diag=1') !== -1) {
  var origGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl2' || type === 'webgl') {
      attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true })
    }
    return origGetContext.call(this, type, attrs)
  }
}

function mountChat() {
  // DSH's real composer is a contenteditable element, not a textarea (the
  // shipping frontend bundle contains contentEditable and no <textarea>).
  // ?ce=1 reproduces that shape so the widget's mount gate is exercised against
  // the real element type rather than only the textarea fallback.
  var composer = location.search.indexOf('ce=1') !== -1
    ? '<div class="fake-composer" contenteditable="true" role="textbox" data-placeholder="composer"></div>'
    : '<textarea class="fake-composer" placeholder="composer"></textarea>'
  document.getElementById('root').innerHTML =
    '<h3>dsh-live2d-widget harness</h3>' +
    '<p>This page mimics the DSH chat shell so the widget mounts.</p>' + composer
  // Dev-only: ?panel=1 opens the control panel so a headless screenshot can show it.
  if (location.search.indexOf('panel=1') !== -1) {
    setTimeout(function () { try { window.__dshLive2dApi.open() } catch (e) {} }, 5000)
  }
  // ?speak=1 keeps a speech bubble up so a screenshot taken at the end of the
  // virtual-time budget is guaranteed to catch one. It goes through the real
  // "say a line" path, so the text is the model's own and not test filler.
  if (location.search.indexOf('speak=1') !== -1) {
    setInterval(function () {
      try { window.__dshLive2dApi.speakRandom() } catch (e) {}
    }, 1800)
  }
  if (location.search.indexOf('diag=1') !== -1) setTimeout(function () { runDiag() }, 4000)
}
if (location.search.indexOf('boot=1') !== -1) {
  document.getElementById('root').innerHTML = '<div class="boot">Loading plugins…</div>'
  // 9s is longer than the widget's old 6s deadline, so this fails if the mount
  // gate ever goes back to a short fixed timeout.
  setTimeout(mountChat, 9000)
} else {
  mountChat()
}

function dlog(s) { document.getElementById('diag').textContent += s + '\\n' }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

// Collect page errors so the dump can show why the model failed to appear.
window.__diagErrors = []
window.addEventListener('error', function (e) { window.__diagErrors.push(String(e.message)) })
window.addEventListener('unhandledrejection', function (e) {
  window.__diagErrors.push('rejection: ' + String((e.reason && e.reason.message) || e.reason))
})
;(function () {
  var origErr = console.error, origWarn = console.warn
  console.error = function () { window.__diagErrors.push('console.error: ' + Array.prototype.join.call(arguments, ' ')); origErr.apply(console, arguments) }
  console.warn = function () { window.__diagErrors.push('console.warn: ' + Array.prototype.join.call(arguments, ' ')); origWarn.apply(console, arguments) }
})()

function inkBox(gl, w, h) {
  if (!gl) return null
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  var buf = new Uint8Array(w * h * 4)
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  var x0 = 1e9, x1 = -1, t = 1e9, b = -1
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    if (buf[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < t) t = y; if (y > b) b = y }
  }
  if (x1 < 0) return null
  return { w: x1 - x0 + 1, h: b - t + 1, left: x0, top: h - 1 - b }
}

function fire(el, type, x, y, buttons) {
  el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse',
    button: 0, buttons: buttons === undefined ? 1 : buttons, isPrimary: true,
  }))
}

async function runDiag() {
  try {
    var host = document.getElementById('dsh-live2d-host')
    if (!host || !host.shadowRoot) { dlog('NO WIDGET HOST'); return }
    var sr = host.shadowRoot
    var canvas = sr.querySelector('canvas')
    var adaptEl = sr.querySelector('[data-k=adapt]')
    var sizeEl = sr.querySelector('[data-k=size]')
    var api = window.__dshLive2dApi

    // Boot report: must come before anything is touched.
    var msgEl = sr.querySelector('[data-msg]')
    var inst0 = api.instance()
    var info = {
      msg: msgEl ? msgEl.textContent : '(no msg el)',
      hasInst: !!inst0,
      params: inst0 && inst0.getParams ? inst0.getParams().length : null,
      motions: inst0 && inst0.getMotions ? Object.keys(inst0.getMotions() || {}).length : null,
      cvCss: [canvas.clientWidth, canvas.clientHeight],
      cvAttr: [canvas.width, canvas.height],
      display: getComputedStyle(canvas).display,
      opacity: getComputedStyle(canvas).opacity,
      stageBox: (function () { var b = sr.querySelector('.stage').getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)] })(),
      errors: window.__diagErrors || [],
    }
    dlog('BOOT               | ' + JSON.stringify(info))

    // Panel sizing: the panel is a shrinking flex item, so measure what is
    // actually constraining it rather than guessing.
    try { api.open() } catch (e) {}
    await sleep(400)
    var pEl = sr.querySelector('.panel')
    var dEl = sr.querySelector('.dock')
    var pc = getComputedStyle(pEl)
    var db = dEl.getBoundingClientRect()
    dlog('PANEL              | ' + JSON.stringify({
      open: pEl.classList.contains('open'),
      clientH: pEl.clientHeight,
      scrollH: pEl.scrollHeight,
      inlineMaxH: pEl.style.maxHeight,
      usedMaxH: pc.maxHeight,
      flex: pc.flex,
      minHeight: pc.minHeight,
      dockBox: [Math.round(db.width), Math.round(db.height)],
      dockMaxH: getComputedStyle(dEl).maxHeight,
      innerH: window.innerHeight,
    }))

    function snap(label) {
      var gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
      var st = api.state()
      var id = st.settings.activeId
      var pm = st.settings.perModel[id] || {}
      var stageEl = sr.querySelector('.stage')
      var sb = stageEl.getBoundingClientRect()
      var cs = getComputedStyle(canvas)
      dlog(label + ' | ' + JSON.stringify({
        ink: inkBox(gl, canvas.width, canvas.height),
        cvCss: [canvas.clientWidth, canvas.clientHeight],
        cvAttr: [canvas.width, canvas.height],
        cvComputed: [cs.width, cs.height],
        cvInline: canvas.getAttribute('style'),
        cvParent: canvas.parentElement ? canvas.parentElement.className : null,
        stageStyleW: stageEl.style.width,
        stageBox: [Math.round(sb.width), Math.round(sb.height)],
        canvasCount: sr.querySelectorAll('canvas').length,
        hostCount: document.querySelectorAll('#dsh-live2d-host').length,
        size: st.settings.size,
        adapt: pm.adapt, pos: pm.position,
        offset: st.settings.offset,
        sizeSlider: sizeEl.value, adaptSlider: adaptEl.value,
      }))
    }
    function setSlider(el, v) {
      el.value = String(v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    function hideBubble() {
      // Reach the widget's own bubble through the shadow root and force it off.
      var b = sr.querySelector('.bubble')
      if (b) {
        b.classList.remove('on')
        // Also clear the widget's pending auto-hide so it cannot re-show.
        try { api.state().settings.bubble = true } catch (e) {}
      }
    }

    await sleep(700)
    // Normalise through the real controls first: the harness home persists
    // between runs, and a leftover adapt=3 would make every size measurement
    // read as a fully clipped box.
    setSlider(sizeEl, 1)
    setSlider(adaptEl, 1)
    ;(function () {
      var op = sr.querySelector('[data-k=opacity]')
      if (op) setSlider(op, 1)
    })()
    await sleep(800)
    snap('baseline           ')
    setSlider(sizeEl, 0.6); await sleep(1500); snap('size->0.6          ')
    setSlider(sizeEl, 1.6); await sleep(1500); snap('size->1.6          ')
    setSlider(sizeEl, 1); await sleep(1500); snap('size->1.0          ')
    setSlider(adaptEl, 0.6); await sleep(1300); snap('adapt->0.6         ')
    setSlider(adaptEl, 1); await sleep(1300); snap('adapt->1.0         ')

    // Click (no movement) must pop the speech bubble.
    var r0 = canvas.getBoundingClientRect()
    fire(canvas, 'pointerdown', r0.left + r0.width / 2, r0.top + r0.height / 2, 1)
    fire(canvas, 'pointerup', r0.left + r0.width / 2, r0.top + r0.height / 2, 0)
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(400)
    var bub = sr.querySelector('.bubble')
    dlog('after click        | bubble=' + JSON.stringify({
      on: !!(bub && bub.classList.contains('on')),
      who: bub ? bub.querySelector('.who').textContent : null,
      say: bub ? bub.querySelector('.say').textContent : null,
    }))

    // Drag: press and move well past the threshold. Hide the bubble first so
    // the follow-up assertion is conclusive.
    hideBubble()
    await sleep(150)
    var r = canvas.getBoundingClientRect()
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2
    fire(canvas, 'pointerdown', cx, cy, 1)
    for (var i = 1; i <= 6; i++) fire(canvas, 'pointermove', cx + i * 26, cy - i * 20, 1)
    fire(canvas, 'pointerup', cx + 156, cy - 120, 0)
    // The click a real browser fires right after pointerup must NOT pop a
    // bubble; dispatch it immediately so it lands inside the suppression window.
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    dlog('post-drag click    | bubbleOn=' + (bub && bub.classList.contains('on')) + '  (expect false)')
    await sleep(700); snap('after drag(+156,-120)')

    // Past the window, a genuine click must pop one again.
    await sleep(500)
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(300)
    dlog('later click        | bubbleOn=' + (bub && bub.classList.contains('on')) + '  (expect true)')

    // ---- numeric controls -------------------------------------------------
    function num(key) { return sr.querySelector('[data-num=' + key + ']') }
    function rng(key) { return sr.querySelector('[data-k=' + key + ']') }
    function setText(el, v) {
      el.focus()
      el.value = String(v)
      el.dispatchEvent(new Event('change', { bubbles: true }))
      el.blur()
    }
    function ctrlReport(label) {
      var st = api.state()
      var pm = st.settings.perModel[st.settings.activeId] || {}
      dlog('ctrl ' + label + ' | ' + JSON.stringify({
        adapt: pm.adapt, adaptRange: [rng('adapt').min, rng('adapt').max],
        adaptNum: num('adapt').value, adaptSlider: rng('adapt').value,
        size: st.settings.size, sizeNum: num('size').value, sizeSlider: rng('size').value,
        opacity: st.settings.opacity, opacityNum: num('opacity').value,
      }))
    }

    ctrlReport('initial')
    // 1) the widened adapt range must reach beyond the old 1.2 ceiling
    rng('adapt').value = '2.5'
    rng('adapt').dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(250)
    ctrlReport('slider adapt=2.5')
    // 2) typing an exact value into the number field
    setText(num('adapt'), '0.33')
    await sleep(250)
    ctrlReport('typed adapt=0.33')
    // 3) opacity is shown as a percentage but stored as a fraction
    setText(num('opacity'), '40')
    await sleep(250)
    ctrlReport('typed opacity=40pct')
    // 4) clamping: an absurd typed value must snap to the range end
    setText(num('adapt'), '99')
    await sleep(250)
    ctrlReport('typed adapt=99(clamp)')
    // 5) garbage must revert instead of corrupting state
    setText(num('adapt'), 'abc')
    await sleep(250)
    ctrlReport('typed adapt=abc(revert)')
    // 6) sideways drag on a number field scrubs it
    var before = parseFloat(num('size').value)
    var nr = num('size').getBoundingClientRect()
    fire(num('size'), 'pointerdown', nr.left + 20, nr.top + 8, 1)
    for (var s2 = 1; s2 <= 5; s2++) fire(num('size'), 'pointermove', nr.left + 20 + s2 * 20, nr.top + 8, 1)
    fire(num('size'), 'pointerup', nr.left + 120, nr.top + 8, 0)
    await sleep(300)
    ctrlReport('scrubbed size from ' + before)
    dlog('DONE')
  } catch (e) {
    dlog('DIAG ERROR ' + (e && e.message))
  }
}
</script>
</body></html>`

function applyTaps(html) {
  let out = html
  for (const fn of taps) out = fn(out)
  return out
}

// ---- server ----------------------------------------------------------------
http
  .createServer(async (req, res) => {
    let pathname = '/'
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    } catch (err) {
      res.writeHead(400).end('bad path')
      return
    }
    if (pathname === '/' || pathname === '/index.html') {
      const body = Buffer.from(applyTaps(INDEX_HTML), 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length })
      res.end(body)
      return
    }
    // Dev tooling (calibration page) is served straight from tools/.
    if (pathname.startsWith('/tools/')) {
      const file = path.join(TOOLS, pathname.slice('/tools/'.length))
      if (!path.resolve(file).startsWith(TOOLS)) {
        res.writeHead(403).end('no')
        return
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404).end('404')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': data.length })
        res.end(data)
      })
      return
    }
    const hit = exact.get(pathname)
    if (hit) return hit(req, res)
    for (const p of prefixes) {
      if (pathname === p.path || pathname.startsWith(p.path + '/')) return p.handler(req, res)
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + pathname)
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log('[harness] http://127.0.0.1:' + PORT + '/')
    console.log('[harness] plugin root:', ROOT)
  })
