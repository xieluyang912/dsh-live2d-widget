/**
 * dsh-live2d-widget — browser half.
 *
 * Injected into the DSH index page by the host plugin's `tapIndex` hook.
 * Renders a Live2D model in a corner of the chat view, with a control panel for
 * switching/tuning/importing models and a speech bubble the model talks in.
 *
 * Style isolation: every node lives inside a Shadow DOM, so DSH's own
 * stylesheet (and other plugins' selectors) cannot restyle the widget, and the
 * widget cannot restyle DSH.
 *
 * Runtime reuse: the `l2d` runtime keeps one WebGL context per canvas and its
 * `destroy()` does NOT release that context, so the widget calls `init()` once
 * and switches models with repeated `load()` calls. Re-initialising per switch
 * would leak a WebGL context each time until the browser drops the oldest one.
 *
 * Sizing model: the runtime fits a model to its canvas and `scale` multiplies
 * that fit about the canvas centre, so any `scale` above the calibrated fit
 * simply crops the character. Size is therefore expressed as a *canvas*
 * multiple — growing the canvas grows the character without ever clipping —
 * while the per-model `adapt` value only tunes how much of the canvas the model
 * fills.
 */
(function () {
  'use strict'
  if (window.__dshLive2dWidget) return
  window.__dshLive2dWidget = true

  var BASE = '/dsh-live2d'
  var RUNTIME_URL = BASE + '/runtime.js'
  var STATE_URL = BASE + '/api/state'
  var SETTINGS_URL = BASE + '/api/settings'
  var IMPORT_ZIP_URL = BASE + '/api/import-zip'
  var IMPORT_FILES_URL = BASE + '/api/import-files'
  var IMPORT_PATH_URL = BASE + '/api/import-path'
  var DELETE_URL = BASE + '/api/delete'

  /** Reference canvas: the size every shipped model was calibrated against. */
  var BASE_W = 340
  var STAGE_RATIO = 1.18
  var MIN_SIZE = 0.4
  var MAX_SIZE = 2.2
  // Wide enough to rescue a model authored for a huge canvas (small value) or
  // one drawn tiny inside its own canvas (large value). Above 1 the model
  // starts to overflow the canvas, which is exactly what a small imported model
  // needs in order to become visible at all.
  var MIN_ADAPT = 0.1
  var MAX_ADAPT = 3
  var SAVE_DEBOUNCE_MS = 400
  var DRAG_THRESHOLD = 5
  /** Horizontal travel, in px, that sweeps a scrubbed number field end to end. */
  var SCRUB_TRAVEL_PX = 320
  /**
   * Below this much room above the model, the panel stops sharing the dock's
   * flow and overlays the model instead — otherwise a large model leaves a
   * panel too short to use.
   */
  var MIN_PANEL_ROOM = 260

  /**
   * Every numeric control in one place, so its slider and its typeable field can
   * never disagree about range, step or display precision.
   *
   * `mul` scales the stored value for display and input: opacity is stored as a
   * 0.15..1 fraction but shown as 15..100 percent, which is how people say it.
   */
  var CONTROLS = {
    size: { min: MIN_SIZE, max: MAX_SIZE, step: 0.02, dp: 2 },
    adapt: { min: MIN_ADAPT, max: MAX_ADAPT, step: 0.01, dp: 2 },
    px: { min: -2, max: 2, step: 0.02, dp: 2 },
    py: { min: -2, max: 2, step: 0.02, dp: 2 },
    opacity: { min: 0.15, max: 1, step: 0.05, dp: 0, mul: 100 },
    bubbleSec: { min: 2, max: 20, step: 1, dp: 0 },
  }
  /**
   * How long to keep watching for the chat view before giving up.
   *
   * DSH paints a "Loading plugins…" overlay into #root and only mounts the chat
   * composer once every plugin is up. Cold starts with several plugins can take
   * a while, so a short timeout would silently leave the user with no model.
   */
  var MOUNT_WATCH_MS = 5 * 60 * 1000

  // -------------------------------------------------------------------------
  // Mount gate: only the main chat view gets a model.
  // The script tag is injected into every index render (the plugin market and
  // settings views are SPA routes of the same document). Mounting there would
  // append nodes behind React's back and break its tree, so wait for the
  // composer to appear and give up on views that never render one.
  //
  // Readiness is *observed*, never assumed: DSH mounts a boot overlay into
  // #root first, and the composer only exists once every plugin has loaded.
  // -------------------------------------------------------------------------
  var COMPOSER_SELECTOR = [
    'textarea',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[role="textbox"]',
  ].join(',')

  /** The chat composer, or null when this view is not the main chat view. */
  function findComposer() {
    var root = document.getElementById('root')
    if (!root) return null
    var list
    try {
      list = root.querySelectorAll(COMPOSER_SELECTOR)
    } catch (err) {
      return null
    }
    for (var i = 0; i < list.length; i++) {
      // Require a real input area. Other SPA views may render small inline
      // editors that match the selector but are not the chat composer, and
      // mounting there is exactly what this gate must avoid.
      var rect = list[i].getBoundingClientRect()
      if (rect.width >= 120 && rect.height >= 18) return list[i]
    }
    return null
  }

  function whenChatReady(cb) {
    if (findComposer()) {
      cb()
      return
    }

    var settled = false
    var observer = null
    var timer = null
    var scheduled = false
    var deadline = Date.now() + MOUNT_WATCH_MS

    function stop() {
      if (observer) {
        try {
          observer.disconnect()
        } catch (err) {}
      }
      clearInterval(timer)
      observer = null
      timer = null
    }

    function attempt() {
      if (settled) return
      if (findComposer()) {
        settled = true
        stop()
        cb()
        return
      }
      if (Date.now() > deadline) {
        settled = true
        stop()
      }
    }

    // Mutations arrive in bursts while React boots; coalesce them so the DOM
    // query and layout reads happen at most a few times a second.
    function schedule() {
      if (scheduled || settled) return
      scheduled = true
      setTimeout(function () {
        scheduled = false
        attempt()
      }, 200)
    }

    var target = document.getElementById('root') || document.documentElement
    if (typeof MutationObserver === 'function') {
      try {
        observer = new MutationObserver(schedule)
        observer.observe(target, { childList: true, subtree: true })
      } catch (err) {
        observer = null
      }
    }
    // A mutation may never come (the composer can appear purely from a layout
    // change), so a slow interval backs the observer up.
    timer = setInterval(attempt, 500)
    setTimeout(attempt, 1200)
    setTimeout(attempt, 3500)
  }

  whenChatReady(function () {
    try {
      start()
    } catch (err) {
      console.warn('[live2d] 初始化失败', err)
    }
  })

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------
  function loadRuntime() {
    return new Promise(function (resolve, reject) {
      if (window.L2D && typeof window.L2D.init === 'function') return resolve(window.L2D)
      var s = document.createElement('script')
      s.src = RUNTIME_URL
      s.async = true
      s.onload = function () {
        if (window.L2D && typeof window.L2D.init === 'function') resolve(window.L2D)
        else reject(new Error('Live2D 运行时加载后未暴露 L2D'))
      }
      s.onerror = function () {
        reject(new Error('Live2D 运行时脚本加载失败'))
      }
      document.head.appendChild(s)
    })
  }

  function api(url, options) {
    return fetch(url, options).then(function (res) {
      return res.text().then(function (text) {
        var data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch (err) {
          throw new Error('接口返回非 JSON（HTTP ' + res.status + '）')
        }
        if (!res.ok || (data && data.ok === false)) {
          throw new Error((data && data.error) || 'HTTP ' + res.status)
        }
        return data
      })
    })
  }

  function postJson(url, body) {
    return api(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function readAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader()
      fr.onload = function () {
        resolve(fr.result)
      }
      fr.onerror = function () {
        reject(fr.error || new Error('读取文件失败：' + file.name))
      }
      fr.readAsArrayBuffer(file)
    })
  }

  /** Base64 a large buffer without blowing the argument-count limit. */
  function toBase64(buf) {
    var bytes = new Uint8Array(buf)
    var chunk = 0x8000
    var out = ''
    for (var i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
    }
    return btoa(out)
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v
  }

  function baseName(file) {
    return String(file).replace(/^.*[\\/]/, '').replace(/\.zip$/i, '')
  }

  // -------------------------------------------------------------------------
  // widget
  // -------------------------------------------------------------------------
  function start() {
    var state = null // host state: { models, settings }
    var inst = null // L2D instance (one per page)
    var loadToken = 0
    var saveTimer = null
    // The runtime's Emitter only exposes `on`, so the `loaded` listener is
    // registered exactly once and settles whichever load is currently pending.
    var pendingLoad = null
    var suppressClickUntil = 0
    var drag = null
    var bubbleTimer = null
    var lastLine = -1
    /** True while a range thumb is held, so layout stops re-capping the panel. */
    var draggingRange = false
    var canvasBox = { w: BASE_W, h: Math.round(BASE_W * STAGE_RATIO) }

    var host = document.createElement('div')
    host.id = 'dsh-live2d-host'
    // DSH's own stylesheet only ever uses z-index in -1..1100 (content 0-10,
    // sticky chrome 70, popovers 100-101, modals/overlays 1000-1100). 90 keeps
    // the pet above the chat and its chrome while leaving DSH's popovers,
    // dialogs and toasts on top, where they belong.
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:90'
    var sh = host.attachShadow({ mode: 'open' })

    var css = document.createElement('style')
    css.textContent = [
      ':host{all:initial}',
      '*{box-sizing:border-box}',
      '.dock{position:fixed;bottom:0;left:0;display:flex;flex-direction:column;align-items:flex-start;gap:8px;pointer-events:none;font:13px/1.45 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#e8eef7;max-height:calc(100vh - 8px)}',
      '.stage{position:relative;flex:none;pointer-events:none;transition:opacity .25s ease}',
      // The canvas box is written as inline size by applyStyles(), not by CSS:
      // the runtime's own bootstrap helper freezes `style.width/height` onto the
      // canvas the first time its computed size equals its attribute size, which
      // would otherwise pin the canvas to whatever size it first laid out at.
      'canvas{display:block;pointer-events:auto;cursor:grab;transition:opacity .25s ease}',
      '.stage.dragging canvas{cursor:grabbing}',
      '.stage.mirror canvas{transform:scaleX(-1)}',
      // Speech bubble: a flex sibling between the panel and the stage, so it
      // stacks naturally instead of fighting the panel for the same space.
      '.bubble{position:relative;flex:none;max-width:100%;pointer-events:none;background:rgba(255,255,255,.97);color:#1d2733;border:1px solid rgba(20,30,45,.14);border-radius:13px;box-shadow:0 8px 22px rgba(15,25,40,.22);padding:8px 12px;font-size:13px;line-height:1.5;opacity:0;transform:translateY(6px);transition:opacity .18s ease,transform .18s ease}',
      '.bubble.on{opacity:1;transform:none}',
      '.bubble .who{display:block;font-size:10.5px;font-weight:700;letter-spacing:.3px;color:#6c7d93;margin-bottom:2px}',
      '.bubble .say{display:block;word-break:break-word}',
      '.bubble::after{content:"";position:absolute;left:26px;bottom:-7px;width:12px;height:12px;background:inherit;border-right:1px solid rgba(20,30,45,.14);border-bottom:1px solid rgba(20,30,45,.14);transform:rotate(45deg)}',
      '.dock.right .bubble::after{left:auto;right:26px}',
      '.dock.right .bubble{align-self:flex-end}',
      '.fab{position:absolute;top:-2px;right:-2px;width:30px;height:30px;border-radius:50%;border:1px solid rgba(255,255,255,.22);background:rgba(26,32,44,.86);color:#dbe7ff;font:600 11px/1 system-ui,sans-serif;cursor:pointer;pointer-events:auto;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);transition:background .15s,transform .15s}',
      '.fab:hover{background:rgba(46,58,80,.95);transform:scale(1.06)}',
      '.panel{pointer-events:auto;width:288px;flex:0 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;background:rgba(22,27,38,.94);border:1px solid rgba(255,255,255,.13);border-radius:14px;box-shadow:0 16px 44px rgba(0,0,0,.42);backdrop-filter:blur(14px);padding:11px;display:none}',
      '.panel.open{display:block}',
      // Tight-space fallback: when the model leaves too little room above it for
      // a usable panel, take the panel out of the dock's flow, anchor it to the
      // dock's bottom and let it grow up over the model. A panel overlapping the
      // model beats a 120px unusable strip.
      '.panel.overlay{position:absolute;left:0;bottom:0}',
      '.dock.right .panel.overlay{left:auto;right:0}',
      '.panel::-webkit-scrollbar{width:8px}',
      '.panel::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:4px}',
      '.hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}',
      '.hd b{font-size:13px;letter-spacing:.3px}',
      '.hd .x{cursor:pointer;border:0;background:transparent;color:#9fb0c8;font-size:16px;line-height:1;padding:2px 4px;border-radius:6px}',
      '.hd .x:hover{background:rgba(255,255,255,.1);color:#fff}',
      '.sec{margin-top:8px;border-top:1px solid rgba(255,255,255,.09);padding-top:7px}',
      '.sec:first-of-type{border-top:0;padding-top:0;margin-top:0}',
      // Collapsible secondary sections keep the default panel short enough to
      // fit above the model.
      '.fold>summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;margin:0}',
      '.fold>summary::-webkit-details-marker{display:none}',
      '.fold>summary::after{content:"\\25be";font-size:9px;color:#7f90a8;transition:transform .15s}',
      '.fold[open]>summary{margin-bottom:6px}',
      '.fold[open]>summary::after{transform:rotate(180deg)}',
      '.lb{font-size:11px;color:#93a4bd;letter-spacing:.4px;margin-bottom:5px;text-transform:uppercase}',
      '.list{display:flex;flex-direction:column;gap:3px;max-height:104px;overflow-y:auto}',
      '.mi{display:flex;align-items:center;gap:7px;width:100%;text-align:left;border:1px solid transparent;background:rgba(255,255,255,.05);color:#dfe8f5;padding:6px 8px;border-radius:8px;cursor:pointer;font:inherit;font-size:12.5px}',
      '.mi:hover{background:rgba(255,255,255,.11)}',
      '.mi.on{background:rgba(94,150,255,.24);border-color:rgba(120,170,255,.6)}',
      '.mi .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mi .bg{font-size:10px;padding:1px 5px;border-radius:5px;background:rgba(255,255,255,.13);color:#a9bcd6;flex:none}',
      '.mi .del{flex:none;border:0;background:transparent;color:#8c9bb2;cursor:pointer;font-size:13px;padding:1px 3px;border-radius:5px;line-height:1}',
      '.mi .del:hover{background:rgba(255,90,90,.25);color:#ffb3b3}',
      '.row{display:flex;align-items:center;gap:8px;margin:3px 0}',
      '.row label{flex:none;width:52px;font-size:11.5px;color:#9db0ca}',
      '.row input[type=range]{flex:1;min-width:0;height:18px;-webkit-appearance:none;appearance:none;background:transparent;cursor:pointer;margin:0}',
      '.row input[type=range]::-webkit-slider-runnable-track{height:5px;border-radius:3px;background:rgba(255,255,255,.18)}',
      '.row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;margin-top:-5px;border-radius:50%;background:#5e96ff;border:2px solid #eaf1ff;box-shadow:0 1px 4px rgba(0,0,0,.45);cursor:grab}',
      '.row input[type=range]:active::-webkit-slider-thumb{cursor:grabbing;background:#82b1ff}',
      '.row input[type=range]::-moz-range-track{height:5px;border-radius:3px;background:rgba(255,255,255,.18)}',
      '.row input[type=range]::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:#5e96ff;border:2px solid #eaf1ff;cursor:grab}',
      '.row .num{flex:none;width:50px;text-align:center;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.16);border-radius:6px;color:#e6eefb;padding:2px 4px;font:11px/1.5 inherit;font-variant-numeric:tabular-nums;cursor:ew-resize;-webkit-user-select:none;user-select:none}',
      '.row .num:hover{border-color:rgba(255,255,255,.3)}',
      '.row .num:focus{outline:none;border-color:rgba(120,170,255,.85);background:rgba(0,0,0,.5);cursor:text;-webkit-user-select:text;user-select:text}',
      '.btns{display:flex;flex-wrap:wrap;gap:6px}',
      '.bt{border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.07);color:#e2ebf8;border-radius:8px;padding:5px 9px;font:inherit;font-size:12px;cursor:pointer}',
      '.bt:hover{background:rgba(255,255,255,.15)}',
      '.bt.pri{background:rgba(94,150,255,.26);border-color:rgba(120,170,255,.5)}',
      '.bt.pri:hover{background:rgba(94,150,255,.4)}',
      '.bt:disabled{opacity:.45;cursor:default}',
      '.tin{flex:1;min-width:0;background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.16);border-radius:8px;color:#e6eefb;padding:5px 8px;font:inherit;font-size:12px}',
      '.tin::placeholder{color:#7f90a8}',
      '.ta{display:block;width:100%;height:78px;resize:vertical;background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.16);border-radius:8px;color:#e6eefb;padding:6px 8px;font:inherit;font-size:12px;line-height:1.5}',
      '.ta::placeholder{color:#7f90a8}',
      '.sw{display:flex;align-items:center;gap:6px;font-size:12px;color:#cfdcef;cursor:pointer;user-select:none}',
      '.sw input{accent-color:#5e96ff;width:14px;height:14px}',
      '.msg{margin-top:6px;font-size:11.5px;color:#9fd0a8;min-height:14px;word-break:break-all}',
      '.msg.err{color:#ffb0b0}',
      '.hint{font-size:10.5px;color:#8296b0;margin-top:4px;line-height:1.45}',
      '.toast{position:fixed;left:50%;transform:translateX(-50%);bottom:24px;background:rgba(22,27,38,.95);border:1px solid rgba(255,255,255,.16);color:#e8eef7;padding:8px 14px;border-radius:10px;font-size:12.5px;pointer-events:none;opacity:0;transition:opacity .25s ease}',
      '.toast.on{opacity:1}',
    ].join('\n')
    sh.appendChild(css)

    var dock = document.createElement('div')
    dock.className = 'dock'

    var panel = document.createElement('div')
    panel.className = 'panel'

    var bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.innerHTML = '<span class="who"></span><span class="say"></span>'

    var stage = document.createElement('div')
    stage.className = 'stage'

    var canvas = document.createElement('canvas')
    stage.appendChild(canvas)

    var fab = document.createElement('button')
    fab.className = 'fab'
    fab.type = 'button'
    fab.title = 'Live2D 设置（Ctrl+Shift+L 显示/隐藏）'
    fab.textContent = 'L2D'
    stage.appendChild(fab)

    var toast = document.createElement('div')
    toast.className = 'toast'

    dock.appendChild(panel)
    dock.appendChild(bubble)
    dock.appendChild(stage)
    sh.appendChild(dock)
    sh.appendChild(toast)
    document.body.appendChild(host)

    function say(text, isError) {
      var el = panel.querySelector('[data-msg]')
      if (el) {
        el.textContent = text || ''
        el.className = 'msg' + (isError ? ' err' : '')
      }
    }

    var toastTimer = null
    function flash(text, isError) {
      toast.textContent = text
      toast.style.color = isError ? '#ffb0b0' : '#e8eef7'
      toast.classList.add('on')
      clearTimeout(toastTimer)
      toastTimer = setTimeout(function () {
        toast.classList.remove('on')
      }, 2600)
    }

    // ---- speech bubble ----------------------------------------------------
    function hideBubble() {
      clearTimeout(bubbleTimer)
      bubbleTimer = null
      bubble.classList.remove('on')
    }

    function speak(text, who) {
      if (!state || !state.settings.bubble) return
      bubble.querySelector('.who').textContent = who || ''
      bubble.querySelector('.say').textContent = text || ''
      bubble.classList.add('on')
      var secs = Number(state.settings.bubbleSec)
      if (!isFinite(secs) || secs <= 0) secs = 6
      clearTimeout(bubbleTimer)
      bubbleTimer = setTimeout(function () {
        bubble.classList.remove('on')
      }, secs * 1000)
    }

    function modelLines(model) {
      if (!model) return []
      if (Array.isArray(model.lines) && model.lines.length) return model.lines
      return ['……']
    }

    /** Pick a line, avoiding an immediate repeat when there is a choice. */
    function speakRandom(model) {
      var lines = modelLines(model)
      var idx = 0
      if (lines.length > 1) {
        do {
          idx = Math.floor(Math.random() * lines.length)
        } while (idx === lastLine)
      }
      lastLine = idx
      speak(lines[idx], model ? model.name : '')
    }

    // ---- persist ----------------------------------------------------------
    function persist(immediate) {
      if (!state) return
      clearTimeout(saveTimer)
      var run = function () {
        postJson(SETTINGS_URL, { settings: state.settings }).catch(function () {})
      }
      if (immediate) run()
      else saveTimer = setTimeout(run, SAVE_DEBOUNCE_MS)
    }

    function currentModel() {
      if (!state) return null
      var id = state.settings.activeId
      for (var i = 0; i < state.models.length; i++) {
        if (state.models[i].id === id) return state.models[i]
      }
      return state.models[0] || null
    }

    function perModel(id) {
      if (!state.settings.perModel) state.settings.perModel = {}
      if (!state.settings.perModel[id]) state.settings.perModel[id] = {}
      return state.settings.perModel[id]
    }

    // ---- layout -----------------------------------------------------------
    // Must be safe to call before the host state arrives (the boot sequence
    // positions the dock immediately), so settings fall back to defaults.
    function layoutSettings() {
      if (state && state.settings) return state.settings
      return {
        side: 'left',
        offset: { x: 18, y: 6 },
        visible: true,
        opacity: 1,
        mirror: false,
        panelOpen: false,
        size: 1,
      }
    }

    function stageSizeFrom(size) {
      var s = Number(size)
      if (!isFinite(s) || s <= 0) s = 1
      s = clamp(s, MIN_SIZE, MAX_SIZE)
      return { w: Math.round(BASE_W * s), h: Math.round(BASE_W * s * STAGE_RATIO) }
    }

    function applyStyles() {
      var s = layoutSettings()
      var offset = s.offset && typeof s.offset === 'object' ? s.offset : { x: 18, y: 6 }
      var x = Number(offset.x) || 0
      var y = Number(offset.y) || 0

      canvasBox = stageSizeFrom(s.size)
      dock.classList.toggle('right', s.side === 'right')
      dock.style.left = s.side === 'right' ? 'auto' : x + 'px'
      dock.style.right = s.side === 'right' ? x + 'px' : 'auto'
      dock.style.bottom = y + 'px'
      dock.style.alignItems = s.side === 'right' ? 'flex-end' : 'flex-start'
      stage.style.width = canvasBox.w + 'px'
      stage.style.height = canvasBox.h + 'px'
      // Own the canvas box explicitly. The runtime freezes the canvas's inline
      // width/height to its first laid-out size, so leaving this to CSS
      // percentages lets the canvas get pinned and stop following the stage.
      canvas.style.width = canvasBox.w + 'px'
      canvas.style.height = canvasBox.h + 'px'
      stage.style.opacity = s.visible ? '1' : '0'
      stage.style.display = s.visible ? '' : 'none'
      canvas.style.opacity = String(typeof s.opacity === 'number' ? s.opacity : 1)
      stage.classList.toggle('mirror', !!s.mirror)
      panel.classList.toggle('open', !!s.panelOpen)
      fab.textContent = s.panelOpen ? '×' : 'L2D'
      bubble.style.maxWidth = canvasBox.w + 'px'

      // Cap the panel so panel + bubble + stage always fit above the bottom
      // edge; the dock's own max-height would otherwise clip its top. Skipped
      // while a slider is being dragged: re-capping mid-drag can scroll the
      // panel under the pointer, which makes the slider feel like it jumps.
      var room = window.innerHeight - y - canvasBox.h - 16
      var tight = room < MIN_PANEL_ROOM
      panel.classList.toggle('overlay', tight)
      if (!draggingRange) {
        panel.style.maxHeight =
          Math.max(MIN_PANEL_ROOM, tight ? window.innerHeight - y - 16 : room) + 'px'
      }
    }

    /**
     * Pull the dock back inside the viewport. Clamped against the *stage*, not
     * the whole dock: the panel is transient, and clamping against it would pin
     * a model near the bottom whenever the panel happened to be open.
     */
    function clampIntoView() {
      if (drag) return false
      var s = layoutSettings()
      if (!s.offset || typeof s.offset !== 'object') s.offset = { x: 18, y: 6 }
      var nx = Math.round(clamp(Number(s.offset.x) || 0, 0, Math.max(0, window.innerWidth - canvasBox.w)))
      var ny = Math.round(clamp(Number(s.offset.y) || 0, 0, Math.max(0, window.innerHeight - canvasBox.h)))
      if (nx === s.offset.x && ny === s.offset.y) return false
      s.offset.x = nx
      s.offset.y = ny
      return true
    }

    function applyLayout() {
      applyStyles()
      if (clampIntoView()) applyStyles()
    }

    /**
     * Sync the canvas backing store to its CSS box, then let the runtime
     * rebuild its projection.
     *
     * The runtime only refreshes `canvas.width/height` from its own
     * ResizeObserver path, which is asynchronous; without this the canvas can
     * keep a stale backing store after a size change, so the bitmap is upscaled
     * and the model looks soft and mis-scaled.
     */
    function resizeCanvas() {
      if (!inst) return
      var dpr = window.devicePixelRatio || 1
      var w = Math.max(1, Math.round(canvas.clientWidth * dpr))
      var h = Math.max(1, Math.round(canvas.clientHeight * dpr))
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
      try {
        inst.resize()
      } catch (err) {}
    }

    // ---- model loading ----------------------------------------------------
    /** The runtime `scale` for a model: its calibrated fit times the user's adapt. */
    function effectiveScale(model) {
      var pm = perModel(model.id)
      var adapt = typeof pm.adapt === 'number' ? pm.adapt : 1
      return (Number(model.fitScale) || 1) * adapt
    }

    function loadModel(model, opts) {
      if (!inst || !model) return Promise.resolve()
      opts = opts || {}
      var token = ++loadToken
      var pm = perModel(model.id)
      var scale = effectiveScale(model)
      var position = Array.isArray(pm.position) ? pm.position : model.position
      say('正在加载「' + model.name + '」…')
      hideBubble()

      return new Promise(function (resolve) {
        var settled = false
        var timer = setTimeout(function () {
          finish(false, '超时（资源过大或网络中断）')
        }, 45000)

        function finish(ok, err) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (pendingLoad && pendingLoad.token === token) pendingLoad = null
          if (token !== loadToken) return resolve()
          if (ok) {
            say('')
            if (!opts.silent) {
              flash('已切换到「' + model.name + '」')
              speakRandom(model)
            }
          } else {
            say('加载失败：' + (err || '未知错误'), true)
            flash('模型加载失败：' + model.name, true)
          }
          syncPanel()
          resolve()
        }

        pendingLoad = { token: token, finish: finish }

        inst
          .load({
            path: model.url,
            scale: scale,
            position: position,
            volume: 0,
            logLevel: 'warn',
          })
          .catch(function (err) {
            finish(false, (err && err.message) || String(err))
          })

        syncTuningInputs()
        resizeCanvas()
      })
    }

    function switchTo(id) {
      if (!state) return
      var target = null
      for (var i = 0; i < state.models.length; i++) {
        if (state.models[i].id === id) target = state.models[i]
      }
      if (!target) return
      state.settings.activeId = id
      persist(true)
      loadModel(target)
    }

    // ---- panel ------------------------------------------------------------
    /**
     * One tuning row: a draggable slider plus a field you can also type into
     * (or drag sideways on, for coarse scrub). Both are driven from CONTROLS so
     * they always agree.
     */
    function controlRow(key, label) {
      var c = CONTROLS[key]
      return (
        '<div class="row"><label>' + label + '</label>' +
        '<input type="range" data-k="' + key + '" min="' + c.min + '" max="' + c.max + '" step="' + c.step + '">' +
        '<input class="num" type="text" inputmode="decimal" spellcheck="false" data-num="' + key +
        '" title="可直接输入，或按住左右拖动微调">' +
        '</div>'
      )
    }

    panel.innerHTML = [
      '<div class="hd"><b>Live2D 桌宠</b><button class="x" data-act="close" title="收起">×</button></div>',
      '<div class="sec"><div class="lb">模型</div><div class="list" data-list></div>',
      '  <div class="hint">按住模型可直接拖到任意位置。</div></div>',
      '<div class="sec"><div class="lb">外观</div>',
      controlRow('size', '大小'),
      controlRow('adapt', '适配'),
      controlRow('px', '左右'),
      controlRow('py', '上下'),
      controlRow('opacity', '透明'),
      '  <div class="btns" style="margin-top:7px">',
      '    <button class="bt" data-act="mirror">左右翻转</button>',
      '    <button class="bt" data-act="side">换边</button>',
      '    <button class="bt" data-act="motion">随机动作</button>',
      '    <button class="bt" data-act="expr">随机表情</button>',
      '    <button class="bt" data-act="reset">恢复默认</button>',
      '    <button class="bt" data-act="hide">隐藏模型</button>',
      '  </div>',
      '</div>',
      // The panel has to fit in the space above the model, which is far less
      // than the panel's full content height. Secondary sections therefore start
      // collapsed, so the default view is the model list plus the sliders.
      '<details class="sec fold" data-fold="lines"><summary class="lb">点击台词</summary>',
      '  <label class="sw"><input type="checkbox" data-k="bubble"> 点击模型时说话</label>',
      controlRow('bubbleSec', '停留'),
      '  <textarea class="ta" data-k="lines" spellcheck="false" placeholder="每行一句台词，点模型时随机说一句"></textarea>',
      '  <div class="btns" style="margin-top:6px">',
      '    <button class="bt pri" data-act="save-lines">保存台词</button>',
      '    <button class="bt" data-act="default-lines">恢复默认台词</button>',
      '    <button class="bt" data-act="test-line">试说一句</button>',
      '  </div>',
      '  <div class="hint">台词按模型分别保存，可以为每个角色写符合人设的话。</div>',
      '</details>',
      '<details class="sec fold" data-fold="import"><summary class="lb">导入自己的模型</summary>',
      '  <div class="btns">',
      '    <button class="bt pri" data-act="imp-zip">选择 zip 压缩包</button>',
      '    <button class="bt" data-act="imp-dir">选择模型文件夹</button>',
      '  </div>',
      '  <div class="row" style="margin-top:7px"><input class="tin" data-k="path" placeholder="或填写本机模型目录，如 D:\\models\\senko"><button class="bt" data-act="imp-path">导入</button></div>',
      '  <div class="hint">支持 <b>*.model3.json</b>（Cubism 3/4/5）、<b>*.model.json</b>，以及 <b>model.json</b> / 自定义文件名（按内容识别）。会自动去除外层文件夹。</div>',
      '  <div class="msg" data-msg></div>',
      '</details>',
    ].join('')

    var zipInput = document.createElement('input')
    zipInput.type = 'file'
    zipInput.accept = '.zip,application/zip'
    zipInput.style.display = 'none'

    var dirInput = document.createElement('input')
    dirInput.type = 'file'
    dirInput.multiple = true
    dirInput.webkitdirectory = true
    dirInput.style.display = 'none'

    sh.appendChild(zipInput)
    sh.appendChild(dirInput)

    // ---- numeric controls -------------------------------------------------
    // A control's stored value and its displayed value differ when `mul` is set
    // (opacity is stored 0.15..1 but shown 15..100), so both directions live
    // here and nothing else converts.

    /** Stored value -> the number a person sees and types. */
    function toDisplay(key, raw) {
      var c = CONTROLS[key]
      var v = Number(raw)
      if (!isFinite(v)) v = c.min
      return c.mul ? v * c.mul : v
    }

    /** Typed/text number -> a clamped stored value, or null when unparsable. */
    function fromDisplay(key, shown) {
      var c = CONTROLS[key]
      var text = String(shown == null ? '' : shown).trim().replace(/[^0-9.eE+-]/g, '')
      if (!text) return null
      var v = Number(text)
      if (!isFinite(v)) return null
      if (c.mul) v = v / c.mul
      return clamp(v, c.min, c.max)
    }

    /** Trim trailing zeros so 1.00 shows as 1 and 0.90 as 0.9. */
    function formatDisplay(key, raw) {
      var c = CONTROLS[key]
      var v = toDisplay(key, raw)
      var text = v.toFixed(c.dp)
      if (c.dp > 0 && text.indexOf('.') >= 0) text = text.replace(/0+$/, '').replace(/\.$/, '')
      return text
    }

    /** Push every control's stored value into its field, unless being typed in. */
    function syncControlDisplays() {
      Object.keys(CONTROLS).forEach(function (key) {
        var range = panel.querySelector('[data-k=' + key + ']')
        var num = panel.querySelector('[data-num=' + key + ']')
        if (!range || !num) return
        if (document.activeElement === num) return
        num.value = formatDisplay(key, range.value)
      })
    }

    /** The one place a control's value is applied, from slider, typing or scrub. */
    function applyControl(key, raw) {
      if (!state) return null
      var c = CONTROLS[key]
      if (!c) return null
      var v = Number(raw)
      if (!isFinite(v)) return null
      v = clamp(v, c.min, c.max)
      var model = currentModel()

      if (key === 'size') {
        // Straight to the canvas: the model is fitted to it, so it grows with
        // the canvas instead of being cropped by a larger internal scale.
        state.settings.size = v
        applyLayout()
        resizeCanvas()
      } else if (key === 'adapt') {
        if (model) perModel(model.id).adapt = v
        if (inst) {
          try {
            inst.setScale(effectiveScale(model))
          } catch (err) {}
        }
      } else if (key === 'px' || key === 'py') {
        var px = key === 'px' ? v : Number(panel.querySelector('[data-k=px]').value)
        var py = key === 'py' ? v : Number(panel.querySelector('[data-k=py]').value)
        if (model) perModel(model.id).position = [px, py]
        if (inst) {
          try {
            inst.setPosition(px, py)
          } catch (err) {}
        }
      } else if (key === 'opacity') {
        state.settings.opacity = v
        canvas.style.opacity = String(v)
      } else if (key === 'bubbleSec') {
        state.settings.bubbleSec = v
      }

      var range = panel.querySelector('[data-k=' + key + ']')
      if (range && range.value !== String(v)) range.value = String(v)
      persist()
      syncControlDisplays()
      return v
    }

    /** Push the active model's tuning into the sliders without rebuilding the list. */
    function syncTuningInputs() {
      if (!state) return
      var model = currentModel()
      var s = state.settings
      var pm = model ? perModel(model.id) : {}
      var position = model && Array.isArray(pm.position) ? pm.position : model ? model.position : [0, 0]
      panel.querySelector('[data-k=size]').value = String(typeof s.size === 'number' ? s.size : 1)
      panel.querySelector('[data-k=adapt]').value = String(typeof pm.adapt === 'number' ? pm.adapt : 1)
      panel.querySelector('[data-k=px]').value = String(position[0])
      panel.querySelector('[data-k=py]').value = String(position[1])
      panel.querySelector('[data-k=opacity]').value = String(s.opacity)
      panel.querySelector('[data-k=bubble]').checked = !!s.bubble
      panel.querySelector('[data-k=bubbleSec]').value = String(s.bubbleSec || 6)
      var linesEl = panel.querySelector('[data-k=lines]')
      if (linesEl && document.activeElement !== linesEl) linesEl.value = modelLines(model).join('\n')
      syncControlDisplays()
    }

    function syncPanel() {
      if (!state) return
      var model = currentModel()
      var list = panel.querySelector('[data-list]')
      list.innerHTML = ''
      state.models.forEach(function (m) {
        var item = document.createElement('div')
        item.className = 'mi' + (model && m.id === model.id ? ' on' : '')
        var nm = document.createElement('span')
        nm.className = 'nm'
        nm.textContent = m.name
        nm.title = m.name + '\n' + m.entry
        var bg = document.createElement('span')
        bg.className = 'bg'
        bg.textContent = m.source === 'user' ? '导入' : '内置'
        item.appendChild(nm)
        item.appendChild(bg)
        if (m.source === 'user') {
          var del = document.createElement('button')
          del.className = 'del'
          del.type = 'button'
          del.textContent = '×'
          del.title = '删除这个导入的模型'
          del.addEventListener('click', function (ev) {
            ev.stopPropagation()
            removeModel(m)
          })
          item.appendChild(del)
        }
        item.addEventListener('click', function () {
          if (!model || m.id !== model.id) switchTo(m.id)
        })
        list.appendChild(item)
      })

      syncTuningInputs()

      var exprBtn = panel.querySelector('[data-act=expr]')
      var motionBtn = panel.querySelector('[data-act=motion]')
      var hasExpr = false
      var hasMotion = false
      try {
        hasExpr = !!(inst && inst.getExpressions && inst.getExpressions().length)
        var motions = (inst && inst.getMotions && inst.getMotions()) || {}
        hasMotion = Object.keys(motions).some(function (k) {
          return motions[k] && motions[k].length
        })
      } catch (err) {}
      if (exprBtn) exprBtn.disabled = !hasExpr
      if (motionBtn) motionBtn.disabled = !hasMotion
    }

    // ---- interactions -----------------------------------------------------
    fab.addEventListener('click', function () {
      if (!state) return
      state.settings.panelOpen = !state.settings.panelOpen
      if (!state.settings.panelOpen) hideBubble()
      applyLayout()
      // The panel sits above the stage, so opening it grows the dock upwards.
      requestAnimationFrame(applyLayout)
      persist()
    })

    panel.addEventListener('change', function (ev) {
      var el = ev.target
      if (!state) return
      var numKey = el.getAttribute && el.getAttribute('data-num')
      if (numKey) {
        // Committed by Enter or blur. Unparsable or out-of-range text snaps the
        // field back to the value that is actually in effect.
        var v = fromDisplay(numKey, el.value)
        if (v === null) syncControlDisplays()
        else applyControl(numKey, v)
        return
      }
      var key = el.getAttribute && el.getAttribute('data-k')
      if (key === 'bubble') {
        state.settings.bubble = !!el.checked
        if (!state.settings.bubble) hideBubble()
        persist()
      }
    })

    // A number field is also a scrubber: press and drag sideways to sweep it.
    // A press that never moves focuses the field so it can be typed into.
    var scrub = null
    panel.addEventListener('pointerdown', function (ev) {
      var el = ev.target
      if (el && el.type === 'range') draggingRange = true
      var numKey = el && el.getAttribute && el.getAttribute('data-num')
      if (!numKey || !state || !CONTROLS[numKey]) return
      var c = CONTROLS[numKey]
      scrub = {
        el: el,
        key: numKey,
        startX: ev.clientX,
        startShown: toDisplay(numKey, el.value === '' ? c.min : fromDisplay(numKey, el.value)),
        // Sweep the whole range across a fixed travel, in display units.
        perPx: ((c.max - c.min) * (c.mul || 1)) / SCRUB_TRAVEL_PX,
        moved: false,
      }
      try {
        el.setPointerCapture(ev.pointerId)
      } catch (err) {}
    })

    panel.addEventListener('pointermove', function (ev) {
      if (!scrub) return
      var dx = ev.clientX - scrub.startX
      if (!scrub.moved) {
        if (Math.abs(dx) < 3) return
        scrub.moved = true
      }
      ev.preventDefault()
      var v = fromDisplay(scrub.key, scrub.startShown + dx * scrub.perPx)
      if (v !== null) applyControl(scrub.key, v)
    })

    function endScrub(ev) {
      if (!scrub) return
      var s = scrub
      scrub = null
      try {
        if (ev && ev.pointerId !== undefined) s.el.releasePointerCapture(ev.pointerId)
      } catch (err) {}
      if (!s.moved) {
        s.el.focus()
        try {
          s.el.select()
        } catch (err) {}
      } else {
        syncControlDisplays()
      }
    }
    panel.addEventListener('pointerup', endScrub)
    panel.addEventListener('pointercancel', endScrub)

    // Releasing anywhere ends a range drag, then layout re-caps the panel once.
    function clearRangeDrag() {
      if (!draggingRange) return
      draggingRange = false
      applyStyles()
    }
    window.addEventListener('pointerup', clearRangeDrag)
    window.addEventListener('pointercancel', clearRangeDrag)

    panel.addEventListener('blur', function (ev) {
      var el = ev.target
      if (el && el.getAttribute && el.getAttribute('data-num')) {
        var v = fromDisplay(el.getAttribute('data-num'), el.value)
        if (v === null) syncControlDisplays()
        else applyControl(el.getAttribute('data-num'), v)
      }
    }, true)

    panel.addEventListener('click', function (ev) {
      if (!state) return
      var btn = ev.target.closest ? ev.target.closest('[data-act]') : null
      if (!btn) return
      var act = btn.getAttribute('data-act')
      var model = currentModel()
      if (act === 'close') {
        state.settings.panelOpen = false
        hideBubble()
        applyLayout()
        persist()
      } else if (act === 'mirror') {
        state.settings.mirror = !state.settings.mirror
        applyLayout()
        persist()
      } else if (act === 'side') {
        state.settings.side = state.settings.side === 'right' ? 'left' : 'right'
        applyLayout()
        persist()
      } else if (act === 'hide') {
        state.settings.visible = false
        hideBubble()
        applyLayout()
        persist(true)
        flash('模型已隐藏，Ctrl+Shift+L 可恢复')
      } else if (act === 'motion') {
        try {
          var motions = inst.getMotions() || {}
          var groups = Object.keys(motions).filter(function (k) {
            return motions[k] && motions[k].length
          })
          if (groups.length) {
            var g = groups[Math.floor(Math.random() * groups.length)]
            inst.playMotion(g)
            flash('播放动作：' + g)
          }
        } catch (err) {
          flash('动作播放失败', true)
        }
      } else if (act === 'expr') {
        try {
          inst.setExpression()
          flash('已切换表情')
        } catch (err) {
          flash('表情切换失败', true)
        }
      } else if (act === 'test-line') {
        speakRandom(model)
      } else if (act === 'save-lines') {
        if (!model) return
        var raw = panel.querySelector('[data-k=lines]').value || ''
        var parsed = raw
          .split('\n')
          .map(function (x) {
            return x.trim()
          })
          .filter(Boolean)
        if (!state.settings.lines) state.settings.lines = {}
        state.settings.lines[model.id] = parsed
        model.lines = parsed.length ? parsed : ['……']
        persist(true)
        flash('台词已保存（' + parsed.length + ' 句）')
      } else if (act === 'default-lines') {
        if (!model) return
        if (state.settings.lines) delete state.settings.lines[model.id]
        model.lines = Array.isArray(model.defaultLines) ? model.defaultLines.slice() : ['……']
        panel.querySelector('[data-k=lines]').value = modelLines(model).join('\n')
        persist(true)
        flash('已恢复默认台词')
      } else if (act === 'reset') {
        if (model) {
          delete perModel(model.id).adapt
          delete perModel(model.id).position
          state.settings.size = 1
          state.settings.opacity = 1
          state.settings.mirror = false
          state.settings.side = 'left'
          state.settings.offset = { x: 18, y: 6 }
          applyLayout()
          resizeCanvas()
          if (state.settings.activeId === model.id) loadModel(model, { silent: true })
          else syncPanel()
          persist(true)
          flash('已恢复默认')
        }
      } else if (act === 'imp-zip') {
        zipInput.click()
      } else if (act === 'imp-dir') {
        dirInput.click()
      } else if (act === 'imp-path') {
        var input = panel.querySelector('[data-k=path]')
        var dir = (input.value || '').trim()
        if (!dir) return say('请先填写模型目录路径', true)
        say('正在从本机目录导入…')
        postJson(IMPORT_PATH_URL, { dir: dir })
          .then(function (res) {
            afterImport(res, '已从目录导入')
            input.value = ''
          })
          .catch(function (err) {
            say('导入失败：' + err.message, true)
          })
      }
    })

    panel.addEventListener('input', function (ev) {
      var el = ev.target
      var key = el.getAttribute && el.getAttribute('data-k')
      // Number fields are `type=text` and carry `data-num`, not `data-k`, so
      // typing in them never reaches this path.
      if (!key || !state || !CONTROLS[key]) return
      applyControl(key, el.value)
    })

    // Drag the model to reposition it. Listeners live on the canvas (the only
    // pointer-interactive child) and a drag suppresses the click that follows,
    // so dragging never also pops a speech bubble.
    canvas.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0 || !state) return
      drag = {
        x: ev.clientX,
        y: ev.clientY,
        ox: state.settings.offset.x,
        oy: state.settings.offset.y,
        moved: false,
      }
      stage.classList.add('dragging')
      try {
        canvas.setPointerCapture(ev.pointerId)
      } catch (err) {}
    })

    canvas.addEventListener('pointermove', function (ev) {
      if (!drag) return
      var dx = ev.clientX - drag.x
      var dy = ev.clientY - drag.y
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
      drag.moved = true
      // Clamp against the stage so the model can be placed anywhere on screen;
      // the panel's own max-height keeps the dock from overflowing.
      var maxX = Math.max(0, window.innerWidth - canvasBox.w)
      var maxY = Math.max(0, window.innerHeight - canvasBox.h)
      state.settings.offset.x = Math.round(clamp(drag.ox + dx, 0, maxX))
      state.settings.offset.y = Math.round(clamp(drag.oy - dy, 0, maxY))
      applyStyles()
      // The dock's height changes with the position, so the panel cap must too.
      var room = window.innerHeight - state.settings.offset.y - canvasBox.h - 16
      panel.style.maxHeight = Math.max(120, room) + 'px'
    })

    function endDrag(ev) {
      if (!drag) return
      var moved = drag.moved
      drag = null
      stage.classList.remove('dragging')
      try {
        if (ev && ev.pointerId !== undefined) canvas.releasePointerCapture(ev.pointerId)
      } catch (err) {}
      if (moved) {
        suppressClickUntil = Date.now() + 400
        persist()
      }
    }
    canvas.addEventListener('pointerup', endDrag)
    canvas.addEventListener('pointercancel', endDrag)

    // Capture phase: runs before anything else, so a drag never also counts as
    // a click on the model.
    canvas.addEventListener(
      'click',
      function (ev) {
        if (Date.now() < suppressClickUntil) {
          ev.stopPropagation()
          ev.preventDefault()
          return
        }
        // A genuine click: react and say something.
        if (!state || !state.settings.visible) return
        var model = currentModel()
        try {
          if (inst) inst.playMotion('Tap')
        } catch (err) {}
        speakRandom(model)
      },
      true,
    )

    // ---- import -----------------------------------------------------------
    function afterImport(res, okText) {
      if (res && res.state) {
        state = res.state
        applyLayout()
        syncPanel()
        var model = currentModel()
        if (model) loadModel(model, { silent: true })
        say((okText || '导入完成') + '：' + ((res.model && res.model.name) || ''))
        flash('已导入「' + ((res.model && res.model.name) || '') + '」')
      }
    }

    zipInput.addEventListener('change', function () {
      var file = zipInput.files && zipInput.files[0]
      zipInput.value = ''
      if (!file) return
      say('正在读取并解压 ' + file.name + '…')
      readAsArrayBuffer(file)
        .then(function (buf) {
          return api(IMPORT_ZIP_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/zip',
              'X-Model-Name': encodeURIComponent(baseName(file.name)),
            },
            body: buf,
          })
        })
        .then(function (res) {
          afterImport(res, '已从压缩包导入')
        })
        .catch(function (err) {
          say('导入失败：' + err.message, true)
          flash('导入失败', true)
        })
    })

    dirInput.addEventListener('change', function () {
      var files = dirInput.files ? Array.prototype.slice.call(dirInput.files) : []
      dirInput.value = ''
      if (!files.length) return
      var name = baseName((files[0].webkitRelativePath || files[0].name).split('/')[0])
      say('正在读取 ' + files.length + ' 个文件…')
      Promise.all(
        files.map(function (f) {
          return readAsArrayBuffer(f).then(function (buf) {
            return { path: f.webkitRelativePath || f.name, b64: toBase64(buf) }
          })
        }),
      )
        .then(function (list) {
          say('正在导入（' + list.length + ' 个文件）…')
          return postJson(IMPORT_FILES_URL, { name: name, files: list })
        })
        .then(function (res) {
          afterImport(res, '已从文件夹导入')
        })
        .catch(function (err) {
          say('导入失败：' + err.message, true)
          flash('导入失败', true)
        })
    })

    function removeModel(model) {
      if (!window.confirm('确定删除导入的模型「' + model.name + '」？模型文件会被一并删除。')) return
      postJson(DELETE_URL, { id: model.id })
        .then(function (res) {
          state = res.state
          var next = currentModel()
          applyLayout()
          syncPanel()
          if (next) loadModel(next, { silent: true })
          flash('已删除「' + model.name + '」')
        })
        .catch(function (err) {
          flash('删除失败：' + err.message, true)
        })
    }

    // ---- global keys / resize --------------------------------------------
    window.addEventListener('keydown', function (ev) {
      if (!state) return
      if (ev.ctrlKey && ev.shiftKey && (ev.key === 'L' || ev.key === 'l')) {
        ev.preventDefault()
        state.settings.visible = !state.settings.visible
        if (!state.settings.visible) hideBubble()
        applyLayout()
        persist(true)
        flash(state.settings.visible ? '已显示模型' : '已隐藏模型')
      }
    })

    var resizeTimer = null
    window.addEventListener('resize', function () {
      if (!state) return
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(function () {
        // Keep the dock inside the viewport after a window shrink.
        applyLayout()
        resizeCanvas()
        persist()
      }, 200)
    })

    window.__dshLive2dApi = {
      state: function () {
        return state
      },
      open: function () {
        if (!state) return
        state.settings.panelOpen = true
        applyLayout()
      },
      switchTo: switchTo,
      speak: function (text) {
        speak(text || '测试台词', currentModel() ? currentModel().name : '')
      },
      /** Same path a real click takes: pick one of the model's own lines. */
      speakRandom: function () {
        speakRandom(currentModel())
      },
      instance: function () {
        return inst
      },
    }

    // ---- boot -------------------------------------------------------------
    applyLayout()

    Promise.all([loadRuntime(), api(STATE_URL)])
      .then(function (out) {
        state = out[1]
        if (!state || !state.models || !state.models.length) {
          // No bundled characters (a publisher may have stripped them, or the
          // model folders are missing). The only useful action is importing, so
          // open the panel and the import section instead of failing silently.
          if (state) state.settings.panelOpen = true
          applyLayout()
          var importFold = panel.querySelector('[data-fold=import]')
          if (importFold) importFold.open = true
          say('没有可用的模型。用下面的「导入自己的模型」添加一个，或把模型放进 assets/models。', true)
          return
        }
        if (!state.settings.lines || typeof state.settings.lines !== 'object') state.settings.lines = {}
        if (typeof state.settings.size !== 'number') state.settings.size = 1
        if (typeof state.settings.bubble !== 'boolean') state.settings.bubble = true
        if (typeof state.settings.bubbleSec !== 'number') state.settings.bubbleSec = 6
        applyLayout()
        syncPanel()
        // The host skips models it cannot load (e.g. a file that arrived
        // truncated); say so instead of letting them vanish silently.
        if (Array.isArray(state.skipped) && state.skipped.length) {
          flash(
            state.skipped
              .map(function (s) {
                return '「' + (s.name || s.id) + '」' + (s.reason || '不可用')
              })
              .join('；'),
            true,
          )
        }

        inst = window.L2D.init(canvas)
        if (!inst) {
          say('Live2D 初始化失败（canvas 无效）', true)
          return
        }
        // Registered once and for all: `load()` re-emits `loaded` on every
        // switch, and the Emitter has no `off`, so listeners must not pile up.
        inst.on('loaded', function () {
          if (pendingLoad) pendingLoad.finish(true)
          syncPanel()
        })

        var model = currentModel()
        if (!model) {
          // The earlier length check already handled the empty-list case, so
          // reaching here means the active model could not be resolved.
          say('当前模型不可用，请在「模型」里换一个。', true)
          return
        }
        state.settings.activeId = model.id
        // The canvas must be laid out before the runtime reads its size, and the
        // first model's greeting should wait until it is actually on screen.
        resizeCanvas()
        return loadModel(model, { silent: true }).then(function () {
          setTimeout(function () {
            speakRandom(model)
          }, 400)
        })
      })
      .catch(function (err) {
        say('启动失败：' + ((err && err.message) || err), true)
        console.warn('[live2d] 启动失败', err)
      })
  }
})()
