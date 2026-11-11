// 昼夜壁纸 · 浏览器半区
//
// 一个「跟着真实时钟走的静态壁纸」：把一天映射到 assets/schedule.json 里的
// 时刻锚点，任何时候都把「此刻」夹在相邻两个锚点之间，用两层 <img> 做连续叠化。
// 于是当天的天色从凌晨的星空一路走到正午的蓝天、傍晚的落日，不需要动画文件。
//
// 为什么是插件而不是皮肤：
//   本地皮肤目录（~/.dsh/skins/<id>/）里的 hooks.mjs 被皮肤中心按 provenance
//   fail-closed 拒绝执行，皮肤清单只能声明静态背景媒体，拿不到时钟。要「随现实
//   时间改变」就必须有 JS，所以这一层由插件画。
//
// 与皮肤的关系（三条，互不冲突）：
//   1. 默认共存：自绘层插在皮肤中心背景层之后（同 z-index:-2，后出现者在上），
//      压住皮肤的背景画作，但面板/玻璃/配色仍然是皮肤自己的。
//   2. 皮肤在主画面上作画时（例如 ORCA LINK 把角色画在会话区背景），会整片盖住
//      壁纸；此时由设置页的「让皮肤让位」给 body 打 data-we-wallpaper，
//      皮肤中心读这个属性会整体停画，只留壁纸 + 官方外观。
//   3. 没装皮肤中心 / 没有任何皮肤层时，自绘层直接挂到 body 末尾，同样可用。
//
// 不依赖任何包：factory 里只 require('react')（宿主提供的共享模块），
// 避免链接安装时按 realpath 解析不到 profile 里的包。

window.__ModuleLoader__.load({
  id: '@local/dsh-daynight-wallpaper',
  factory(require) {
    'use strict'

    const React = require('react')

    /** 素材路由前缀（相对文档基址，远程访问/子路径挂载都对）。 */
    const ROUTE = 'dsh-daynight-wallpaper'
    /** 挂在自己图层上的属性，便于调试与清理。 */
    const ATTR = 'data-dsh-daynight-wallpaper'
    /** 重算间隔：20 s 一步，相邻锚点最密处也只需 1/10 的步进。 */
    const TICK_MS = 20000
    /** 时间表/设置复查间隔。 */
    const REFRESH_MS = 30 * 60 * 1000
    /** 与皮肤背景层同一个 z-index：负值画在 html/body 背景之上、面板之下。 */
    const LAYER_Z = -2
    /** 自己的 locale 命名空间。 */
    const NS = 'dsh-daynight-wallpaper'
    /** 皮肤中心认定的「外部壁纸正在渲染」标记。 */
    const YIELD_ATTR = 'data-we-wallpaper'

    /** 缺省设置：与宿主半区的 DEFAULTS 一致，宿主那份是权威。 */
    const DEFAULT_SETTINGS = { enabled: true, scene: 'mountain', tint: 'none', tintOpacity: 0, yieldSkin: false }

    /** 蒙皮预设：id → 色值。null 表示「不罩」。 */
    const TINTS = {
      none: null,
      night: '#0b1b33',
      ember: '#3a2317',
      pine: '#0f2418',
      violet: '#1d1633',
      graphite: '#12151a',
    }

    // ------------------------------------------------------------------
    // 纯函数：时刻 → 锚点
    // ------------------------------------------------------------------

    /** 当前时刻在一整天里的分钟数（含秒的小数部分）。 */
    function minutesOfDay(date) {
      return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60
    }

    /**
     * 预览开关：地址栏加 `?time=HH:MM` 就把壁纸钉在那一刻（不填就按真实时钟走）。
     * 只为了想看看傍晚长什么样，不用真的等到傍晚。
     * `?dnp=` 是改名前的旧写法，继续认。
     */
    function previewMinutes(search) {
      const params = new URLSearchParams(search || '')
      const raw = params.get('time') || params.get('dnp')
      if (!raw) return null
      const matched = /^(\d{1,2}):(\d{2})$/.exec(raw.trim())
      if (!matched) return null
      const hours = Number(matched[1])
      const minutes = Number(matched[2])
      if (hours > 23 || minutes > 59) return null
      return hours * 60 + minutes
    }

    /** 找出把 `minutes` 夹在中间的两个锚点。 */
    function bracket(points, minutes) {
      const last = points.length - 1
      if (minutes <= points[0].at) return { index: 0, fraction: 0 }
      for (let i = last; i >= 0; i -= 1) {
        if (points[i].at > minutes) continue
        if (i >= last) return { index: last - 1, fraction: 1 }
        const span = points[i + 1].at - points[i].at
        return { index: i, fraction: span > 0 ? (minutes - points[i].at) / span : 0 }
      }
      return { index: 0, fraction: 0 }
    }

    /** 校验并规整宿主给的时刻表；首尾补齐成覆盖 0–1440 的闭环。 */
    function normalizeSchedule(payload) {
      const raw = payload && payload.points
      if (!Array.isArray(raw)) return []
      const points = []
      for (const item of raw) {
        if (!item || typeof item.src !== 'string' || item.src.length === 0) continue
        const at = Number(item.at)
        if (!Number.isFinite(at)) continue
        let dim = Number(item.dim)
        if (!Number.isFinite(dim)) dim = 0.3
        points.push({
          at: Math.min(1440, Math.max(0, at)),
          src: item.src,
          dim: Math.min(0.9, Math.max(0, dim)),
          label: typeof item.label === 'string' ? item.label : '',
          labelEn: typeof item.labelEn === 'string' ? item.labelEn : '',
        })
      }
      points.sort((x, y) => x.at - y.at)
      if (points.length < 2) return []
      const tail = points[points.length - 1]
      if (tail.at < 1440) {
        points.push({
          at: 1440,
          src: points[0].src,
          dim: points[0].dim,
          label: points[0].label,
          labelEn: points[0].labelEn,
        })
      }
      return points
    }

    /** 校验并规整宿主给的场景清单。 */
    function normalizeScenes(payload) {
      const raw = payload && payload.scenes
      if (!Array.isArray(raw)) return []
      const scenes = []
      for (const item of raw) {
        if (!item || typeof item.id !== 'string' || !/^[a-z0-9-]{1,24}$/.test(item.id)) continue
        if (typeof item.schedule !== 'string') continue
        scenes.push({
          id: item.id,
          name: typeof item.name === 'string' ? item.name : item.id,
          nameEn: typeof item.nameEn === 'string' ? item.nameEn : item.id,
          schedule: item.schedule,
        })
      }
      return scenes
    }

    /** 遮罩：顶部略轻、上下两端略重，浓度跟着时刻表里的 dim 走。 */
    function scrimCss(dim) {
      const top = Math.min(0.9, dim * 0.86).toFixed(3)
      const mid = dim.toFixed(3)
      const bottom = Math.min(0.92, dim * 1.1).toFixed(3)
      return `linear-gradient(180deg, rgba(3,6,12,${top}) 0%, rgba(3,6,12,${mid}) 46%, rgba(3,6,12,${bottom}) 100%)`
    }

    /** 分钟数 → HH:MM */
    function clock(minutes) {
      const value = ((Math.round(minutes) % 1440) + 1440) % 1440
      return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
    }

    // ------------------------------------------------------------------
    // 文案（走 Client locale 服务，跟随界面语言）
    // ------------------------------------------------------------------

    const UI_zh = {
      nav: '壁纸',
      title: '昼夜壁纸',
      lead: '背景跟着你所在时区的真实时钟走：破晓、正午、落日、星夜随着一天推进。',
      nowLabel: '此刻',
      skinLabel: '当前皮肤',
      skinNone: '官方默认外观',
      coexistNote: '壁纸只替换皮肤的背景画作，面板、玻璃与配色仍然是你的皮肤——两者可以自由组合。',
      frameLabel: '帧',
      sceneTitle: '场景',
      sceneHint: '换一套图：两段延时都按同一个真实时钟推进，只是取景不同。',
      enableLabel: '启用壁纸',
      enableHint: '关掉后界面回到皮肤自己的背景；插件仍在后台待命，随时可以再打开。',
      tintTitle: '蒙皮',
      tintHint: '在壁纸之上罩一层颜色，用来压暗或统一色调。天色越亮整层纱越厚，所以这里只需要少量浓度。',
      tintNone: '无',
      tintNight: '夜蓝',
      tintEmber: '暖褐',
      tintPine: '墨绿',
      tintViolet: '紫夜',
      tintGraphite: '石墨',
      tintOpacity: '蒙皮浓度',
      yieldLabel: '让皮肤让位',
      yieldHint: '有些皮肤把画作画在面板上（例如 ORCA LINK），会整片盖住壁纸。打开这个开关会临时收起皮肤的全部外观，只留壁纸 + 官方外观；关掉立刻恢复。',
      yieldBadgeOn: '皮肤停画中',
      yieldBadgeOff: '皮肤正常显示',
      previewHint: '想先看别的时段：在地址栏加 ?time=18:10',
      saveFailed: '设置没能存到宿主，刷新后可能丢失。',
      loading: '正在读取设置…',
    }

    const UI_en = {
      nav: 'Wallpaper',
      title: 'Day & Night Wallpaper',
      lead: 'The backdrop follows your real clock: dawn, noon, sunset and the starry night advance with the day.',
      nowLabel: 'Now',
      skinLabel: 'Skin',
      skinNone: 'official look',
      coexistNote: 'The wallpaper only replaces the skin’s backdrop art. Panels, glass and palette still come from your skin, so the two compose freely.',
      frameLabel: 'frame',
      sceneTitle: 'Scene',
      sceneHint: 'Switch the image set: both timelapses follow the same real clock, only the view differs.',
      enableLabel: 'Enable wallpaper',
      enableHint: 'Off restores the skin’s own backdrop. The plugin keeps idling and can be turned back on anytime.',
      tintTitle: 'Colour gel',
      tintHint: 'A colour layer on top of the wallpaper for dimming or unifying the tone. The scrim already scales with brightness, so a little goes a long way.',
      tintNone: 'None',
      tintNight: 'Night blue',
      tintEmber: 'Ember',
      tintPine: 'Pine',
      tintViolet: 'Violet',
      tintGraphite: 'Graphite',
      tintOpacity: 'Gel strength',
      yieldLabel: 'Make the skin step aside',
      yieldHint: 'Some skins paint over the panes themselves (ORCA LINK, for instance) and cover the wallpaper entirely. Turning this on suspends the whole skin look and leaves the wallpaper with the official surfaces; turning it off restores the skin instantly.',
      yieldBadgeOn: 'skin suspended',
      yieldBadgeOff: 'skin active',
      previewHint: 'To preview another hour: add ?time=18:10 to the address bar',
      saveFailed: 'Settings could not be saved to the host and may be lost after a refresh.',
      loading: 'Reading settings…',
    }

    /** 设置页样式：只用自己的 dnw-* 类，颜色全部取官方设计 token。 */
    const PAGE_CSS = `
.dnw-wrap { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 28px; max-width: 760px; }
.dnw-head { display: flex; flex-direction: column; gap: 6px; }
.dnw-title { margin: 0; font-size: 18px; font-weight: 650; color: var(--dsw-alias-label-primary, inherit); }
.dnw-lead { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.95)); }
.dnw-card { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08));
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); }
.dnw-cardTitle { font-size: 13px; font-weight: 650; color: var(--dsw-alias-label-primary, inherit); }
.dnw-stat { display: flex; align-items: center; gap: 12px; }
.dnw-thumb { width: 104px; height: 66px; flex: 0 0 auto; border-radius: 8px; object-fit: cover;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25)); }
.dnw-statText { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dnw-k { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.9)); }
.dnw-v { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.dnw-sub { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.9)); }
.dnw-note { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.9)); }
.dnw-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.dnw-rowText { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dnw-label { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.dnw-hint { font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.9)); }
.dnw-switch { position: relative; flex: 0 0 auto; width: 40px; height: 22px; padding: 0; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4));
  background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.22)); transition: background .18s ease, border-color .18s ease; }
.dnw-switch.on { background: var(--dsw-alias-brand-primary, #4d6bfe); border-color: transparent; }
.dnw-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-bg-overlay, #fff); box-shadow: 0 1px 2px rgba(0,0,0,.35); transition: transform .18s ease; }
.dnw-switch.on .dnw-knob { transform: translateX(18px); }
.dnw-swatches { display: flex; flex-wrap: wrap; gap: 8px; }
.dnw-swatch { display: flex; align-items: center; gap: 7px; padding: 5px 10px 5px 6px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08));
  color: var(--dsw-alias-label-primary, inherit); font-size: 12px; }
.dnw-swatch.active { border-color: var(--dsw-alias-brand-primary, #4d6bfe);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary, #4d6bfe); }
.dnw-chip { width: 16px; height: 16px; border-radius: 50%; border: 1px solid rgba(255,255,255,.28); }
.dnw-sliderRow { display: flex; align-items: center; gap: 12px; }
.dnw-range { flex: 1 1 auto; accent-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dnw-value { flex: 0 0 auto; font-size: 12px; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary, rgba(128,128,128,.9)); min-width: 38px; text-align: right; }
.dnw-badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; font-size: 11px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
  color: var(--dsw-alias-label-secondary, rgba(128,128,128,.9)); }
.dnw-badge.warn { color: var(--dsw-alias-state-warn-primary, #b8860b);
  border-color: var(--dsw-alias-state-warn-primary, rgba(184,134,11,.6)); }
.dnw-err { font-size: 12px; color: var(--dsw-alias-state-error-primary, #d9534f); }
`

    // ------------------------------------------------------------------
    // 插件主体
    // ------------------------------------------------------------------

    function apply(ctx) {
      const doc = document

      // ---------- 共享状态（设置页与图层读同一份） ----------
      let snap = {
        ready: false,
        settings: { ...DEFAULT_SETTINGS },
        scenes: [],
        sceneId: null,
        status: null,
        skin: null,
        saveError: false,
      }
      const listeners = new Set()
      const getSnapshot = () => snap
      const subscribe = (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      }
      const emit = (patch) => {
        snap = { ...snap, ...patch }
        for (const fn of listeners) fn()
      }

      // ---------- 图层状态 ----------
      let layer = null
      let scrim = null
      let tintEl = null
      let curEl = null
      let nextEl = null
      let curIndex = -1
      let points = null
      /** 场景清单（来自 assets/scenes.json）与当前场景 id。 */
      let scenes = []
      let sceneId = null
      let tickTimer = null
      let refreshTimer = null
      let observer = null
      let skinObserver = null
      let placeQueued = false
      let disposed = false
      let ownYield = false
      const preloads = new Map()
      /** 底色兜底层：官方外观的 --dsw-alias-bg-base 是不透明的，壁纸会被它整片盖住。 */
      let baseStyle = null
      /** 预览锁定（`?dnp=HH:MM`），null 表示跟随真实时钟。 */
      const pinned = previewMinutes(doc.location && doc.location.search)

      /** 素材绝对地址（以文档基址解析，兼容子路径挂载与远程访问）。 */
      function urlOf(path) {
        try {
          return new URL(`${ROUTE}/${path}`, doc.baseURI).href
        } catch {
          return `${ROUTE}/${path}`
        }
      }

      // ------------------------------------------------------------------
      // 设置：读写 + 落到图层上
      // ------------------------------------------------------------------

      function loadSettings() {
        if (disposed) return
        fetch(urlOf('settings'), { cache: 'no-cache', credentials: 'same-origin' })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
          .then((payload) => {
            if (disposed) return
            const settings = payload && payload.settings
            if (!settings || typeof settings !== 'object') return
            emit({
              ready: true,
              settings: {
                enabled: settings.enabled !== false,
                scene:
                  typeof settings.scene === 'string' && /^[a-z0-9-]{1,24}$/.test(settings.scene)
                    ? settings.scene
                    : DEFAULT_SETTINGS.scene,
                tint: Object.prototype.hasOwnProperty.call(TINTS, settings.tint) ? settings.tint : 'none',
                tintOpacity: Number.isFinite(Number(settings.tintOpacity))
                  ? Math.min(80, Math.max(0, Math.round(Number(settings.tintOpacity))))
                  : 0,
                yieldSkin: settings.yieldSkin === true,
              },
              saveError: false,
            })
            applySettings()
          })
          .catch(() => {
            if (disposed) return
            emit({ ready: true })
            applySettings()
          })
      }

      /** 设置页改值：先本地生效（瞬时反馈），再落盘。 */
      function saveSettings(patch) {
        const settings = { ...snap.settings, ...patch }
        emit({ settings, saveError: false })
        applySettings()
        fetch(urlOf('settings'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(settings),
          credentials: 'same-origin',
        })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
          .then((payload) => {
            if (disposed || !payload || !payload.settings) return
            emit({ settings: { ...payload.settings }, saveError: false })
            applySettings()
          })
          .catch(() => {
            if (disposed) return
            emit({ saveError: true })
          })
      }

      /** 让皮肤让位：给 body 打上皮肤中心认的标记（只摘自己打的那一次）。 */
      function syncYield() {
        const body = doc.body
        if (!body) return
        const want = snap.settings.yieldSkin === true
        if (want && !ownYield) {
          body.setAttribute(YIELD_ATTR, '')
          ownYield = true
        } else if (!want && ownYield) {
          body.removeAttribute(YIELD_ATTR)
          ownYield = false
        }
      }

      /**
       * 官方外观把 `--dsw-alias-bg-base` 定成不透明色（暗色 #151517），外壳的 frame /
       * 会话根都用它当底板，于是任何 z-index 为负的壁纸层都会被整片盖住——这也是
       * 皮肤为什么都把同一个 token 改成半透明的原因。这里做同样的事，但只在需要时：
       * 读出当前底色，把 alpha 压到 ≤0.35 再写回去。已经比 0.35 更透的皮肤不受影响。
       */
      function refreshBase() {
        if (baseStyle) {
          baseStyle.remove()
          baseStyle = null
        }
        const body = doc.body
        if (!body) return
        // 先摘掉自己的覆盖再读，否则读到的是上一次的写入值。
        // 取「真正在画底板」的那个元素的计算后背景色：外壳的 frame 优先，
        // 其次 body / html。读不到就什么都不做。
        const candidates = [doc.querySelector('[data-dsh-frame]'), body, doc.documentElement]
        let base = null
        for (const element of candidates) {
          if (!element) continue
          const matched = /^rgba?\(([^)]+)\)$/.exec(getComputedStyle(element).backgroundColor || '')
          if (!matched) continue
          const parts = matched[1].split(',').map((value) => Number(value.trim()))
          if (parts.length < 3 || parts.slice(0, 3).some((value) => !Number.isFinite(value))) continue
          const alpha = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1
          if (alpha <= 0) continue
          base = { r: parts[0], g: parts[1], b: parts[2], a: alpha }
          break
        }
        // 底板本来就够透（皮肤自己处理过）就不插手，保持皮肤原样
        if (!base || base.a <= 0.35) return
        const tint = `rgba(${base.r},${base.g},${base.b},0.35)`
        baseStyle = doc.createElement('style')
        baseStyle.setAttribute('data-dsh-daynight-wallpaper-base', '')
        baseStyle.textContent = `:root,body{--dsw-alias-bg-base:${tint} !important}`
        doc.head.appendChild(baseStyle)
      }

      /** 图层真正可见时才有必要动底色。 */
      function syncBase(visible) {
        if (visible) refreshBase()
        else if (baseStyle) {
          baseStyle.remove()
          baseStyle = null
        }
      }

      /** 把「开关 / 蒙皮」落到 DOM 上。 */
      function applySettings() {
        if (!layer) return
        syncYield()
        // 设置里的场景和当前加载的不一致就换场景（先有清单才能换）
        if (scenes.length > 0) {
          const wanted = scenes.some((scene) => scene.id === snap.settings.scene)
            ? snap.settings.scene
            : scenes[0].id
          if (wanted !== sceneId) switchScene(wanted)
        }
        const { enabled, tint, tintOpacity } = snap.settings
        layer.style.display = enabled ? '' : 'none'
        if (tintEl) {
          const color = TINTS[tint]
          tintEl.style.backgroundColor = color || 'transparent'
          tintEl.style.opacity = color ? String(Math.min(80, Math.max(0, tintOpacity)) / 100) : '0'
        }
        syncBase(enabled)
        if (enabled) render()
      }

      // ------------------------------------------------------------------
      // 图层
      // ------------------------------------------------------------------

      /** 预取一帧（只保留最近若干张，避免内存无限增长）。 */
      function preload(src) {
        const url = urlOf(src)
        if (preloads.has(url)) return
        const img = new Image()
        img.decoding = 'async'
        img.src = url
        preloads.set(url, img)
        if (preloads.size > 12) {
          const oldest = preloads.keys().next().value
          if (oldest !== undefined && oldest !== url) preloads.delete(oldest)
        }
      }

      function makeImg() {
        const img = doc.createElement('img')
        img.alt = ''
        img.decoding = 'async'
        img.draggable = false
        img.style.cssText =
          'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;' +
          'object-position:50% 46%;opacity:0;user-select:none;-webkit-user-drag:none;'
        return img
      }

      function build() {
        layer = doc.createElement('div')
        layer.setAttribute(ATTR, '')
        layer.setAttribute('aria-hidden', 'true')
        layer.style.cssText =
          `position:fixed;top:0;right:0;bottom:0;left:0;z-index:${LAYER_Z};` +
          'pointer-events:none;overflow:hidden;opacity:0;' +
          'transition:opacity 700ms ease-out;background:#05070c;'
        curEl = makeImg()
        nextEl = makeImg()
        layer.appendChild(curEl)
        layer.appendChild(nextEl)
        scrim = doc.createElement('div')
        scrim.setAttribute('aria-hidden', 'true')
        scrim.style.cssText = 'position:absolute;inset:0;pointer-events:none;'
        layer.appendChild(scrim)
        tintEl = doc.createElement('div')
        tintEl.setAttribute('aria-hidden', 'true')
        tintEl.style.cssText =
          'position:absolute;inset:0;pointer-events:none;background-color:transparent;' +
          'opacity:0;transition:opacity 260ms ease,background-color 260ms ease;'
        layer.appendChild(tintEl)
      }

      /**
       * 就位：插在皮肤中心背景层之后（同 z-index，后出现者在上），
       * 没有皮肤背景层时直接挂在 body 末尾。
       */
      function place() {
        const body = doc.body
        if (!body || !layer) return
        const skinBg = body.querySelector('[data-dsh-skin-layer="background"]')
        if (skinBg && skinBg.parentNode === body) {
          if (skinBg.nextSibling !== layer) body.insertBefore(layer, skinBg.nextSibling)
          return
        }
        if (layer.parentNode !== body) body.appendChild(layer)
      }

      function render() {
        if (disposed || !layer) return
        const body = doc.body
        if (!body) return
        // 别的壁纸插件（Wallpaper Engine）画着的时候整层让位；自己「让皮肤让位」时除外。
        const yielded = body.hasAttribute(YIELD_ATTR) && !ownYield
        if (yielded || !snap.settings.enabled) {
          layer.style.display = 'none'
          syncBase(false)
          return
        }
        if (!baseStyle) refreshBase()
        layer.style.display = ''
        if (!points) return

        const minutes = pinned === null ? minutesOfDay(new Date()) : pinned
        const { index, fraction } = bracket(points, minutes)
        const from = points[index]
        const to = points[index + 1]
        // 换锚点时把「上一张」提为当前层，任何时刻都不出现空白帧。
        if (index !== curIndex) {
          const swap = curEl
          curEl = nextEl
          nextEl = swap
          curIndex = index
        }
        const fromUrl = urlOf(`${sceneId}/${from.src}`)
        const toUrl = urlOf(`${sceneId}/${to.src}`)
        if (curEl.getAttribute('data-frame') !== fromUrl) {
          curEl.setAttribute('data-frame', fromUrl)
          curEl.src = fromUrl
        }
        if (nextEl.getAttribute('data-frame') !== toUrl) {
          nextEl.setAttribute('data-frame', toUrl)
          nextEl.src = toUrl
        }
        curEl.style.opacity = '1'
        nextEl.style.opacity = String(fraction)
        scrim.style.background = scrimCss(from.dim + (to.dim - from.dim) * fraction)
        layer.style.opacity = '1'
        preload(`${sceneId}/${points[(index + 2) % points.length].src}`)

        const skin = doc.documentElement.getAttribute('data-dsh-skin')
        const status = {
          scene: sceneId,
          label: from.label,
          labelEn: from.labelEn,
          from: from.at,
          to: to.at,
          src: `${sceneId}/${from.src}`,
        }
        const sameStatus =
          snap.status &&
          snap.status.label === status.label &&
          snap.status.labelEn === status.labelEn &&
          snap.status.scene === status.scene &&
          snap.status.from === status.from &&
          snap.status.to === status.to
        if (!sameStatus || snap.skin !== skin) emit({ status, skin })
      }

      /** 取某个场景的时刻表并立刻重画。 */
      function loadScene(id) {
        const scene = scenes.find((entry) => entry.id === id)
        if (!scene) return
        fetch(urlOf(scene.schedule), { cache: 'no-cache', credentials: 'same-origin' })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
          .then((payload) => {
            if (disposed) return
            const next = normalizeSchedule(payload)
            if (next.length === 0) return
            sceneId = scene.id
            points = next
            curIndex = -1
            emit({ sceneId: scene.id })
            place()
            render()
          })
          .catch(() => {
            /* 取不到时刻表就什么都不画，绝不猜 */
          })
      }

      /** 换场景：清掉旧的帧缓存，重新取时刻表。 */
      function switchScene(id) {
        if (id === sceneId && points) return
        points = null
        curIndex = -1
        sceneId = id
        preloads.clear()
        render()
        loadScene(id)
      }

      /** 取场景清单；选中的场景由设置决定（不合法就用第一个）。 */
      function loadScenes() {
        if (disposed) return
        fetch(urlOf('scenes.json'), { cache: 'no-cache', credentials: 'same-origin' })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
          .then((payload) => {
            if (disposed) return
            const next = normalizeScenes(payload)
            if (next.length === 0) return
            const changed =
              next.length !== scenes.length || next.some((scene, index) => scene.id !== scenes[index].id)
            scenes = next
            if (changed) emit({ scenes: next.map((scene) => ({ ...scene })) })
            const wanted = next.some((scene) => scene.id === snap.settings.scene)
              ? snap.settings.scene
              : next[0].id
            if (wanted !== sceneId || !points) loadScene(wanted)
          })
          .catch(() => {
            /* 取不到场景清单就什么都不画 */
          })
      }

      function requestPlace() {
        if (placeQueued || disposed) return
        placeQueued = true
        setTimeout(() => {
          placeQueued = false
          if (disposed) return
          place()
          syncYield()
        }, 0)
      }

      function onResume() {
        if (doc.visibilityState === 'visible') {
          render()
          loadSettings()
          loadScenes()
        }
      }

      function boot() {
        if (disposed || !doc.body) return
        build()
        place()
        observer = new MutationObserver(requestPlace)
        observer.observe(doc.body, {
          childList: true,
          attributes: true,
          attributeFilter: [YIELD_ATTR],
        })
        // 皮肤切换会换掉 --dsw-alias-bg-base，重算底色兜底
        if (doc.documentElement) {
          skinObserver = new MutationObserver(() => refreshBase())
          skinObserver.observe(doc.documentElement, {
            attributes: true,
            attributeFilter: ['data-dsh-skin'],
          })
        }
        doc.addEventListener('visibilitychange', onResume)
        loadSettings()
        loadScenes()
        render()
        tickTimer = setInterval(render, TICK_MS)
        refreshTimer = setInterval(() => {
          render()
          loadScenes()
        }, REFRESH_MS)
      }

      const start = () => {
        if (doc.body) boot()
        else doc.addEventListener('DOMContentLoaded', boot, { once: true })
      }

      // ---------- 生命周期 ----------
      ctx.effect(() => {
        start()
        return () => {
          disposed = true
          if (tickTimer) clearInterval(tickTimer)
          if (refreshTimer) clearInterval(refreshTimer)
          if (observer) observer.disconnect()
          if (skinObserver) skinObserver.disconnect()
          if (baseStyle) baseStyle.remove()
          doc.removeEventListener('DOMContentLoaded', boot)
          doc.removeEventListener('visibilitychange', onResume)
          if (layer && layer.parentNode) layer.parentNode.removeChild(layer)
          if (ownYield && doc.body) doc.body.removeAttribute(YIELD_ATTR)
          ownYield = false
          preloads.clear()
          layer = null
          points = null
        }
      })

      // ---------- 设置页 ----------
      const t = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (key) => key

      ctx.effect(() => ctx.locale.register(NS, { zh: UI_zh, en: UI_en }))

      /** 一行的开关控件。 */
      function Switch(props) {
        return React.createElement(
          'button',
          {
            type: 'button',
            className: `dnw-switch${props.on ? ' on' : ''}`,
            'aria-pressed': props.on,
            onClick: () => props.onChange(!props.on),
          },
          React.createElement('span', { className: 'dnw-knob' }),
        )
      }

      function DaynightPeakSettings(props) {
        const locale = props.locale
        // 语言切换要重渲染
        if (locale && typeof locale.subscribe === 'function') {
          React.useSyncExternalStore(
            (cb) => locale.subscribe(cb),
            () => locale.getSnapshot(),
          )
        }
        const page = React.useSyncExternalStore(subscribe, getSnapshot)
        const settings = page.settings
        const status = page.status
        // 时刻标注跟着界面语言走（schedule.json 里同时带 zh/en 两份）
        const activeLocale = locale && typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en'
        const phaseLabel = status
          ? (activeLocale === 'en' ? status.labelEn || status.label : status.label || status.labelEn)
          : ''
        const frameSrc = status ? urlOf(status.src) : urlOf('frames/016.webp')
        const range = status ? `${clock(status.from)}–${clock(status.to)}` : ''
        const tintLabels = {
          none: t('tintNone'),
          night: t('tintNight'),
          ember: t('tintEmber'),
          pine: t('tintPine'),
          violet: t('tintViolet'),
          graphite: t('tintGraphite'),
        }
        const skinName = page.skin ? page.skin : t('skinNone')
        const sceneList = page.scenes || []
        const sceneLabel = (scene) =>
          activeLocale === 'en' ? scene.nameEn || scene.name : scene.name || scene.nameEn

        return React.createElement(
          'div',
          { className: 'dnw-wrap' },
          React.createElement('style', { key: 'css' }, PAGE_CSS),
          React.createElement(
            'header',
            { className: 'dnw-head', key: 'head' },
            React.createElement('h2', { className: 'dnw-title' }, t('title')),
            React.createElement('p', { className: 'dnw-lead' }, t('lead')),
          ),
          React.createElement(
            'section',
            { className: 'dnw-card', key: 'status' },
            React.createElement(
              'div',
              { className: 'dnw-stat' },
              React.createElement('img', { className: 'dnw-thumb', src: frameSrc, alt: '' }),
              React.createElement(
                'div',
                { className: 'dnw-statText' },
                React.createElement('span', { className: 'dnw-k' }, t('nowLabel')),
                React.createElement(
                  'span',
                  { className: 'dnw-v' },
                  status ? `${phaseLabel || t('frameLabel')} · ${range}` : t('loading'),
                ),
                React.createElement('span', { className: 'dnw-sub' }, `${t('skinLabel')}: ${skinName}`),
              ),
            ),
            React.createElement('p', { className: 'dnw-note' }, t('coexistNote')),
            React.createElement('p', { className: 'dnw-note' }, t('previewHint')),
          ),
          sceneList.length > 1
            ? React.createElement(
                'section',
                { className: 'dnw-card', key: 'scene' },
                React.createElement('div', { className: 'dnw-cardTitle' }, t('sceneTitle')),
                React.createElement('p', { className: 'dnw-note' }, t('sceneHint')),
                React.createElement(
                  'div',
                  { className: 'dnw-swatches' },
                  sceneList.map((scene) =>
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        key: scene.id,
                        className: `dnw-swatch${settings.scene === scene.id ? ' active' : ''}`,
                        onClick: () => saveSettings({ scene: scene.id }),
                      },
                      sceneLabel(scene),
                    ),
                  ),
                ),
              )
            : null,
          React.createElement(
            'section',
            { className: 'dnw-card', key: 'switches' },
            React.createElement(
              'div',
              { className: 'dnw-row' },
              React.createElement(
                'div',
                { className: 'dnw-rowText' },
                React.createElement('span', { className: 'dnw-label' }, t('enableLabel')),
                React.createElement('span', { className: 'dnw-hint' }, t('enableHint')),
              ),
              React.createElement(Switch, {
                on: settings.enabled,
                onChange: (value) => saveSettings({ enabled: value }),
              }),
            ),
            React.createElement(
              'div',
              { className: 'dnw-row' },
              React.createElement(
                'div',
                { className: 'dnw-rowText' },
                React.createElement(
                  'span',
                  { className: 'dnw-label' },
                  t('yieldLabel'),
                  ' ',
                  React.createElement(
                    'span',
                    { className: `dnw-badge${settings.yieldSkin ? ' warn' : ''}` },
                    settings.yieldSkin ? t('yieldBadgeOn') : t('yieldBadgeOff'),
                  ),
                ),
                React.createElement('span', { className: 'dnw-hint' }, t('yieldHint')),
              ),
              React.createElement(Switch, {
                on: settings.yieldSkin,
                onChange: (value) => saveSettings({ yieldSkin: value }),
              }),
            ),
            page.saveError ? React.createElement('span', { className: 'dnw-err' }, t('saveFailed')) : null,
          ),
          React.createElement(
            'section',
            { className: 'dnw-card', key: 'tint' },
            React.createElement('div', { className: 'dnw-cardTitle' }, t('tintTitle')),
            React.createElement('p', { className: 'dnw-note' }, t('tintHint')),
            React.createElement(
              'div',
              { className: 'dnw-swatches' },
              Object.keys(TINTS).map((id) =>
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    key: id,
                    className: `dnw-swatch${settings.tint === id ? ' active' : ''}`,
                    onClick: () => saveSettings({ tint: id }),
                  },
                  React.createElement('span', {
                    className: 'dnw-chip',
                    style: {
                      background: TINTS[id] || 'transparent',
                      borderStyle: TINTS[id] ? 'solid' : 'dashed',
                    },
                  }),
                  tintLabels[id],
                ),
              ),
            ),
            React.createElement(
              'div',
              { className: 'dnw-sliderRow' },
              React.createElement('span', { className: 'dnw-hint' }, t('tintOpacity')),
              React.createElement('input', {
                className: 'dnw-range',
                type: 'range',
                min: 0,
                max: 80,
                step: 5,
                value: settings.tintOpacity,
                disabled: settings.tint === 'none',
                onChange: (event) => saveSettings({ tintOpacity: Number(event.target.value) }),
              }),
              React.createElement('span', { className: 'dnw-value' }, `${settings.tintOpacity}%`),
            ),
          ),
        )
      }

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'daynight-wallpaper',
            order: 62,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ t, locale: ctx.locale }),
          },
          DaynightPeakSettings,
        ),
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
