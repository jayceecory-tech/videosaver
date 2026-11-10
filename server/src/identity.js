/**
 * 身份（uifid / ttwid / cookie / UA）
 *
 * 实测结论（2026-11-02，详见 docs 内说明）：
 * - 真正不可伪造、必须提供的只有一个：**uifid**（160 字符，参与 md5 签名）
 * - ttwid 可以用 iPhone UA 访问 iesdouyin 分享页**自动领取**，且与 uifid 不需要同源
 * - cookie 里其余字段（UIFID_TEMP / odin_tt / passport_csrf_token / s_v_web_id）值可以是假的
 * - 不需要 a_bogus
 *
 * 配置方式（优先级从高到低）：
 *   1. 环境变量 DOUYIN_UIFID（推荐，云托管只配这一条）
 *   2. 环境变量 DOUYIN_COOKIE（整串，可选）
 *   3. identity.json（本机由 tools/refresh-identity.js 生成）
 * ttwid：环境变量 DOUYIN_TTWID > DOUYIN_COOKIE 里的 > 自动领取
 */
const fs = require('fs')
const path = require('path')

const CANDIDATES = [
  process.env.IDENTITY_FILE,
  path.join(__dirname, '..', 'identity.json'),
  path.join(__dirname, '..', '..', 'videosaver-server-py', 'identity.json'),
].filter(Boolean)

const UIFID_COOKIE_NAMES = ['uifid', 'uifid_temp', 'uifidtemp', 'UIFID', 'UIFID_TEMP', 'UIFIDTEMP']

/** 领取 ttwid 必须用移动端 UA（实测 PC UA 只会下发 __ac_nonce） */
const SHARE_UA =
  process.env.SHARE_UA ||
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/** passport_csrf_token 这个键必须存在，值可以随便填（实测） */
const FAKE_CSRF = '0123456789abcdef0123456789abcdef'

/**
 * 实测结论（Evil0ctal 项目文档 + 我们自己的测试）：
 * 同一出口下「频繁换 cookie/ttwid」比单纯高频更可疑 —— 在抖音看来那是一台设备
 * 不停换访客。所以 ttwid 领到后就长期复用（默认 12 小时），
 * 只有解析被风控时才调用 invalidateTtwid() 强制换一个。
 */
const TTWID_TTL = Number(process.env.TTWID_TTL || 12 * 60 * 60 * 1000)

const ttwidCache = { value: '', expire: 0, fetching: null }

function cookieJar(cookie) {
  const jar = {}
  String(cookie || '')
    .split(';')
    .forEach(part => {
      const idx = part.indexOf('=')
      if (idx > 0) jar[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
    })
  return jar
}

function loadIdentity() {
  if (process.env.DOUYIN_UIFID || process.env.DOUYIN_COOKIE || process.env.DOUYIN_TTWID) {
    return {
      uifid: process.env.DOUYIN_UIFID || '',
      cookie: process.env.DOUYIN_COOKIE || '',
      ttwid: process.env.DOUYIN_TTWID || '',
      ua: process.env.DOUYIN_UA || '',
      file: 'env',
    }
  }
  for (const file of CANDIDATES) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (data && (data.uifid || data.cookie || data.ua)) return Object.assign({ file }, data)
    } catch (e) {
      // 继续找下一个候选
    }
  }
  return {}
}

function getUifid(identity) {
  if (identity && identity.uifid) return identity.uifid
  const jar = cookieJar(identity && identity.cookie)
  for (const name of UIFID_COOKIE_NAMES) {
    if (jar[name]) return jar[name]
  }
  return ''
}

function setCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const raw = headers.get('set-cookie')
  return raw ? [raw] : []
}

/** 访问分享页领一个 ttwid（免任何身份，纯 HTTP） */
async function fetchTtwid(awemeId) {
  const url = `https://www.iesdouyin.com/share/video/${awemeId || '1'}/`
  const resp = await fetch(url, { headers: { 'User-Agent': SHARE_UA }, redirect: 'follow' })
  for (const cookie of setCookies(resp.headers)) {
    const m = /ttwid=([^;]+)/.exec(cookie)
    if (m) return m[1]
  }
  return ''
}

async function getTtwid(identity, awemeId) {
  if (identity && identity.ttwid) return identity.ttwid
  const fromCookie = cookieJar(identity && identity.cookie).ttwid
  if (fromCookie) return fromCookie

  // 未过期直接用
  if (ttwidCache.value && ttwidCache.expire > Date.now()) return ttwidCache.value

  // 过期或首次：领取（并发请求合并为一次）。实测高频领取会被限流，
  // 所以领取失败时继续沿用旧值（stale-on-error），只有从未成功过才返回空
  if (!ttwidCache.fetching) {
    ttwidCache.fetching = fetchTtwid(awemeId)
      .then(value => {
        ttwidCache.fetching = null
        if (value) {
          ttwidCache.value = value
          ttwidCache.expire = Date.now() + TTWID_TTL
        }
        return value
      })
      .catch(() => {
        ttwidCache.fetching = null
        return ''
      })
  }
  const fresh = await ttwidCache.fetching
  return fresh || ttwidCache.value || ''
}

/** 组装实际要发的 Cookie 头 */
async function getCookie(identity, awemeId) {
  if (identity && identity.cookie) return identity.cookie
  const ttwid = await getTtwid(identity, awemeId)
  if (!ttwid) return ''
  return `ttwid=${ttwid}; passport_csrf_token=${FAKE_CSRF}`
}

/** 被风控时调用：丢弃缓存的 ttwid，下次重新领取 */
function invalidateTtwid() {
  ttwidCache.value = ''
  ttwidCache.expire = 0
}

module.exports = { loadIdentity, getUifid, getCookie, cookieJar, invalidateTtwid, SHARE_UA }
