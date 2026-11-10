/**
 * 微信云托管版解析服务（零第三方依赖，Node 原生 http）
 *
 * 路由：
 *   GET  /api/health            健康检查（含身份是否就绪）
 *   POST /api/parse             body: { text | url } -> { code:0, data:{ url,title,cover,author } }
 *   GET  /api/video?t=<token>   代理下载（补 UA + Referer，支持 Range）
 *   POST /api/count             兼容云托管官方模板的示例接口
 *
 * 部署要点：
 * - 端口用环境变量 PORT（云托管默认 80），只监听一个端口
 * - 身份用环境变量 DOUYIN_UIFID（可选 DOUYIN_COOKIE / DOUYIN_UA），不要打包 cookie 进镜像
 * - 解析走纯 HTTP（src/douyin.js），不需要浏览器
 */
const http = require('http')
const crypto = require('crypto')
const { Readable } = require('stream')

const config = require('../src/config')
const { parseVideo, cacheStats } = require('../src/douyin')
const { extractFirstUrl, UA } = require('../src/url')
const pool = require('../src/pool')

const poolState = pool.init()

const PORT = Number(process.env.PORT || 80)
const TOKEN_TTL = Number(process.env.TOKEN_TTL || 30 * 60 * 1000)
const tokens = new Map()

function publicBase(req) {
  if (process.env.PUBLIC_HOST) return String(process.env.PUBLIC_HOST).replace(/\/+$/, '')
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0]
  return `${proto}://${req.headers.host}`
}

function cors(res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  cors(res)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', c => {
      raw += c
      // callContainer 请求体上限 100K，这里给 256K 余量
      if (raw.length > 256 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

async function handleParse(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch (e) {
    return sendJson(res, 400, { code: 400, message: e.message })
  }

  const share = body.url || extractFirstUrl(body.text || '')
  if (!share) return sendJson(res, 400, { code: 400, message: '未识别到链接' })

  try {
    const info = await parseVideo(share)
    const token = crypto.randomBytes(12).toString('hex')
    tokens.set(token, { url: info.url, expire: Date.now() + TOKEN_TTL })
    sendJson(res, 200, {
      code: 0,
      data: {
        url: `${publicBase(req)}/api/video?t=${token}`,
        title: info.title,
        cover: info.cover,
        author: info.author,
        duration: info.duration,
        watermark: info.watermark,
        awemeId: info.awemeId,
        cached: info.cached,
      },
    })
  } catch (e) {
    sendJson(res, 200, {
      code: e.code || 'internal_error',
      message: e.message || '解析失败',
      httpStatus: e.httpStatus || 500,
    })
  }
}

async function handleVideo(req, res, url) {
  const token = url.searchParams.get('t')
  const item = tokens.get(token)
  if (!item || item.expire < Date.now()) {
    tokens.delete(token)
    cors(res)
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('token 无效或已过期，请重新解析')
  }

  const headers = { 'User-Agent': UA, Referer: 'https://www.douyin.com/' }
  if (req.headers.range) headers.Range = req.headers.range

  try {
    const upstream = await fetch(item.url, { headers, redirect: 'follow' })
    const pass = {
      'content-type': upstream.headers.get('content-type') || 'video/mp4',
      'accept-ranges': 'bytes',
    }
    const len = upstream.headers.get('content-length')
    if (len) pass['content-length'] = len
    const range = upstream.headers.get('content-range')
    if (range) pass['content-range'] = range
    cors(res)
    res.writeHead(upstream.status, pass)
    if (req.method === 'HEAD' || !upstream.body) return res.end()
    Readable.fromWeb(upstream.body).pipe(res)
  } catch (e) {
    cors(res)
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`代理下载失败：${e.message}`)
  }
}

setInterval(() => {
  const now = Date.now()
  tokens.forEach((item, key) => {
    if (item.expire < now) tokens.delete(key)
  })
}, 60 * 1000).unref()

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)

  if (req.method === 'OPTIONS') {
    cors(res)
    res.writeHead(204)
    return res.end()
  }

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      tokens: tokens.size,
      identityReady: !!poolState.primary && !poolState.primary.dead,
      identityPool: pool.status(),
      cache: cacheStats(),
      service: process.env.K_SERVICE || 'videosaver',
    })
  }

  if (url.pathname === '/api/parse' && req.method === 'POST') {
    handleParse(req, res).catch(err => sendJson(res, 500, { code: 500, message: err.message }))
    return
  }

  if (url.pathname === '/api/video') {
    handleVideo(req, res, url)
    return
  }

  // 兼容云托管官方 express 模板的示例接口
  if (url.pathname === '/api/count' && req.method === 'POST') {
    return sendJson(res, 200, { code: 0, data: { ok: true } })
  }

  sendJson(res, 404, { code: 404, message: 'not found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[videosaver-cloud] 监听 ${PORT}`)
  const p = pool.status()
  console.log(
    `[videosaver-cloud] 身份池 主: ${p.primary ? p.primary.uifid : '无'} 备: ${p.backup ? p.backup.uifid : '（补充中）'}`
  )
})
