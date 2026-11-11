/**
 * 昼夜壁纸 · 宿主半区
 *
 * 两件事，都只挂在一条只读/半只读的前缀路由上：
 *
 *   GET  /dsh-daynight-wallpaper/scenes.json              场景清单（有哪些取景）
 *   GET  /dsh-daynight-wallpaper/<scene>/schedule.json    该场景的时刻表
 *   GET  /dsh-daynight-wallpaper/<scene>/frames/NNN.webp  该场景的定帧
 *   GET  /dsh-daynight-wallpaper/settings                 壁纸设置（缺省值 + 磁盘上存过的）
 *   POST /dsh-daynight-wallpaper/settings                 合并保存设置（同源才接受）
 *
 * 素材由 `tools/build-frames.sh` 从源动图生成；设置存在
 * `$DSH_HOME/daynight-wallpaper/settings.json`（跟着 DSH_HOME 走，换 profile 也不会串）。
 *
 * 为什么宿主半区零外部 import：本包常以 `link:` 装进 profile，Node 按 realpath
 * 解析，会从插件目录往上找 node_modules —— 那里没有宿主/平台包。所以这里只用
 * Node 内置模块，也不声明任何运行时依赖。
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 路由前缀：与包名同名，避免与其他插件的路由前缀相撞。 */
const ROUTE = '/dsh-daynight-wallpaper'

/** 素材目录（跟随包位置，链接安装时就是工作区里的目录）。 */
const ASSET_ROOT = new URL('./assets/', import.meta.url)

/** 只允许这几类素材路径：场景清单、单场景时刻表、单场景定帧。 */
const ASSET_PATH = /^(?:scenes\.json|[a-z0-9-]{1,24}\/(?:schedule\.json|frames\/[0-9]{3}\.webp))$/

/**
 * v1.1 及更早的客户端只认 `schedule.json` 与 `frames/NNN.webp`（那时只有一个场景）。
 * 页面在升级后可能还跑着旧产物，这里把这两个路径指到 mountain 场景，
 * 免得"刷新之前壁纸直接消失"。
 */
function legacyAsset(rel) {
  if (rel === 'schedule.json') return 'mountain/schedule.json'
  if (/^frames\/[0-9]{3}\.webp$/.test(rel)) return `mountain/${rel}`
  return rel
}

/** 设置文件：$DSH_HOME/daynight-wallpaper/settings.json */
const SETTINGS_PATH = join(
  process.env.DSH_HOME || join(homedir(), '.dsh'),
  'daynight-wallpaper',
  'settings.json',
)

/** 蒙皮预设（id → 色值），与浏览器半区保持一致。 */
const TINT_IDS = ['none', 'night', 'ember', 'pine', 'violet', 'graphite']

/** 缺省设置：只有这里是权威，前端拿到的也是这一份。 */
const DEFAULTS = {
  /** 壁纸总开关 */
  enabled: true,
  /** 场景 id（见 assets/scenes.json），由 knownScenes() 校验 */
  scene: 'mountain',
  /** 蒙皮颜色 id */
  tint: 'none',
  /** 蒙皮浓度 0–80（%）。整层纱已经有亮度自适应，这里只给用户额外压暗/调色的余地 */
  tintOpacity: 0,
  /** 让皮肤让位：给 body 打 data-we-wallpaper，皮肤中心会整体停画 */
  yieldSkin: false,
}

function reply(res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function replyJson(res, status, value) {
  reply(res, status, 'application/json; charset=utf-8', JSON.stringify(value))
}

/**
 * 场景 id 白名单：读 assets/scenes.json（构建脚本生成的唯一权威），进程内缓存一次。
 * 读不到就退回 DEFAULTS.scene，绝不因为素材缺失而拒绝保存设置。
 */
let cachedSceneIds = null
async function knownScenes() {
  if (cachedSceneIds) return cachedSceneIds
  try {
    const raw = await readFile(new URL('scenes.json', ASSET_ROOT), 'utf8')
    const ids = (JSON.parse(raw).scenes || [])
      .map((scene) => scene && scene.id)
      .filter((id) => typeof id === 'string' && /^[a-z0-9-]{1,24}$/.test(id))
    cachedSceneIds = ids.length > 0 ? ids : [DEFAULTS.scene]
  } catch {
    cachedSceneIds = [DEFAULTS.scene]
  }
  return cachedSceneIds
}

/** 把任意输入收敛成合法设置对象（未知字段丢弃，数值夹紧）。 */
function sanitize(input, sceneIds) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const merged = { ...DEFAULTS, ...source }
  const opacity = Number(merged.tintOpacity)
  const scenes = Array.isArray(sceneIds) && sceneIds.length > 0 ? sceneIds : [DEFAULTS.scene]
  return {
    enabled: merged.enabled !== false,
    scene: scenes.includes(merged.scene) ? merged.scene : scenes[0],
    tint: TINT_IDS.includes(merged.tint) ? merged.tint : DEFAULTS.tint,
    tintOpacity: Number.isFinite(opacity) ? Math.min(80, Math.max(0, Math.round(opacity))) : DEFAULTS.tintOpacity,
    yieldSkin: merged.yieldSkin === true,
  }
}

async function readSettings() {
  const sceneIds = await knownScenes()
  try {
    const raw = await readFile(SETTINGS_PATH, 'utf8')
    return sanitize(JSON.parse(raw), sceneIds)
  } catch {
    return sanitize({}, sceneIds)
  }
}

/** 合并保存：只覆盖这次带来的字段，其余沿用磁盘上已有的值。 */
async function writeSettings(value) {
  const sceneIds = await knownScenes()
  const settings = sanitize(
    { ...(await readSettings()), ...(value && typeof value === 'object' ? value : {}) },
    sceneIds,
  )
  await mkdir(join(SETTINGS_PATH, '..'), { recursive: true })
  const temp = `${SETTINGS_PATH}.tmp`
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  await rename(temp, SETTINGS_PATH)
  return settings
}

/**
 * 写操作的同源围栏：不是 index 的路由不走会话 cookie 校验，所以自己看一眼
 * sec-fetch-site 与 Origin —— 别的站点不应该能改我们的壁纸。
 */
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** 读 JSON 请求体（上限 8 KiB）。 */
function readBody(req, limit = 8192) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        resolve(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

async function serveSettings(req, res) {
  if (req.method === 'POST' || req.method === 'PUT') {
    if (!sameOrigin(req)) {
      replyJson(res, 403, { ok: false, error: 'cross-origin' })
      return
    }
    const body = await readBody(req)
    if (body === undefined) {
      replyJson(res, 400, { ok: false, error: 'invalid-json' })
      return
    }
    try {
      replyJson(res, 200, { ok: true, settings: await writeSettings(body) })
    } catch (error) {
      replyJson(res, 500, { ok: false, error: 'write-failed', detail: String(error && error.message) })
    }
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    reply(res, 405, 'text/plain; charset=utf-8', 'method not allowed')
    return
  }
  replyJson(res, 200, { ok: true, settings: await readSettings() })
}

function serveAsset(req, res, rel) {
  readFile(new URL(rel, ASSET_ROOT)).then(
    (body) => {
      res.writeHead(200, {
        'content-type': rel.endsWith('.json') ? 'application/json; charset=utf-8' : 'image/webp',
        'content-length': body.length,
        'cache-control': 'public, max-age=3600',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    },
    () => reply(res, 404, 'text/plain; charset=utf-8', 'not found'),
  )
}

function handler(req, res) {
  const path = String(req.url || '').split('?')[0]
  if (!path.startsWith(`${ROUTE}/`)) {
    reply(res, 404, 'text/plain; charset=utf-8', 'not found')
    return
  }
  let rel
  try {
    rel = legacyAsset(decodeURIComponent(path.slice(ROUTE.length + 1)))
  } catch {
    reply(res, 404, 'text/plain; charset=utf-8', 'not found')
    return
  }
  if (rel === 'settings') {
    serveSettings(req, res).catch(() =>
      reply(res, 500, 'text/plain; charset=utf-8', 'settings failed'),
    )
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    reply(res, 405, 'text/plain; charset=utf-8', 'method not allowed')
    return
  }
  if (!ASSET_PATH.test(rel)) {
    reply(res, 404, 'text/plain; charset=utf-8', 'not found')
    return
  }
  serveAsset(req, res, rel)
}

/**
 * 硬依赖 `webServer`：没有 Web 通道时这一行保持 pending（桌面/浏览器形态都有它）。
 * 注意 cordis 的规则——没写进 inject 的服务连属性访问都不允许，
 * `ctx.webServer` 会直接抛 "cannot get property ... without inject"，
 * 所以这里声明 inject 而不是用 `ctx.get()` 试探。
 */
export const inject = ['webServer']

/**
 * Mount the asset + settings routes.
 * @param ctx - Cordis context of this Loader entry.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }))
}
