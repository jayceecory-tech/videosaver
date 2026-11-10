/**
 * VideoSaver 解析服务
 *   POST /parse   body: { text | url }  -> { code: 0, data: { url, title, cover, author } }
 *   GET  /proxy?t=<token>              -> 代理下载（解决动态 CDN 域名与签名过期问题）
 *   GET  /health                       -> { ok: true }
 */
const http = require('http')
const { Readable } = require('stream')
const crypto = require('crypto')

const config = require('./config')
const { parseVideo, cacheStats } = require('./douyin')
const { extractFirstUrl, UA } = require('./url')
const pool = require('./pool')

const poolState = pool.init()

const tokens = new Map()

function createToken(item) {
  const token = crypto.randomBytes(12).toString('hex')
  tokens.set(token, Object.assign({ expire: Date.now() + config.tokenTTL }, item))
  return token
}

function takeToken(token) {
  const item = tokens.get(token)
  if (!item) return null
  if (item.expire < Date.now()) {
    tokens.delete(token)
    return null
  }
  return item
}

setInterval(() => {
  const now = Date.now()
  tokens.forEach((item, key) => {
    if (item.expire < now) tokens.delete(key)
  })
}, 60 * 1000).unref()

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', c => {
      raw += c
      if (raw.length > 1024 * 1024) {
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

  const shareUrl = body.url || extractFirstUrl(body.text || '')
  if (!shareUrl) {
    return sendJson(res, 400, { code: 400, message: '未识别到链接，请检查分享文案' })
  }

  try {
    const info = await parseVideo(shareUrl)
    const token = createToken({ url: info.url })
    sendJson(res, 200, {
      code: 0,
      data: {
        url: `${config.publicBase}/proxy?t=${token}`,
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
    // 错误分类回传，前端可以给出不同提示（风控/作品不存在/配置缺失/网络）
    sendJson(res, 200, {
      code: e.code || 'internal_error',
      message: e.message || '解析失败',
      httpStatus: e.httpStatus || 500,
    })
  }
}

async function handleProxy(req, res, url) {
  const token = url.searchParams.get('t')
  const item = takeToken(token)
  if (!item) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('token 无效或已过期，请重新解析')
  }

  const headers = { 'User-Agent': UA, Referer: 'https://www.douyin.com/' }
  if (req.headers.range) headers.Range = req.headers.range

  try {
    const upstream = await fetch(item.url, { headers, redirect: 'follow' })
    const passHeaders = {
      'content-type': upstream.headers.get('content-type') || 'video/mp4',
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
    }
    const len = upstream.headers.get('content-length')
    if (len) passHeaders['content-length'] = len
    const range = upstream.headers.get('content-range')
    if (range) passHeaders['content-range'] = range

    res.writeHead(upstream.status, passHeaders)

    if (req.method === 'HEAD' || !upstream.body) {
      return res.end()
    }
    Readable.fromWeb(upstream.body).pipe(res)
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`代理下载失败：${e.message}`)
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    })
    return res.end()
  }

  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      tokens: tokens.size,
      identityReady: !!poolState.primary && !poolState.primary.dead,
      identityPool: pool.status(),
      cache: cacheStats(),
    })
  }

  if (url.pathname === '/parse' && req.method === 'POST') {
    handleParse(req, res).catch(err => sendJson(res, 500, { code: 500, message: err.message }))
    return
  }

  if (url.pathname === '/proxy') {
    handleProxy(req, res, url)
    return
  }

  sendJson(res, 404, { code: 404, message: 'not found' })
})

server.listen(config.port, config.host, () => {
  console.log(`[videosaver] 解析服务已启动: ${config.publicBase}`)
  console.log(`[videosaver] POST ${config.publicBase}/parse  GET ${config.publicBase}/proxy?t=...`)
})

process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})
