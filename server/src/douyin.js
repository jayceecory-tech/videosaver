/**
 * 抖音视频解析（纯 HTTP，无浏览器、无 a_bogus）
 *
 *   分享短链 →（跟随 302）→ aweme_id →（缓存？）→（限速队列内）详情接口 + uifid 签名 → 公开播放地址
 *
 * 最小化实测结论（2026-11-02）：
 * - 参数只需要 aweme_id；签名只放 query（签名头都能省）；但签名本身必需
 * - cookie 只需 ttwid（真）+ passport_csrf_token（值可假）；ttwid 可自动领取、长期复用
 * - 只取抖音对访客公开下发的地址，不做去水印、不绕验证码
 */
const crypto = require('crypto')

const config = require('./config')
const { resolveRedirect, extractAwemeId, isDirectVideoUrl } = require('./url')
const { loadIdentity, getUifid, getCookie, invalidateTtwid } = require('./identity')
const pool = require('./pool')
const { schedule } = require('./limiter')
const { TTLCache } = require('./cache')
const { risk, business, network, identity: identityError, input } = require('./errors')

const DETAIL_URL = 'https://www.douyin.com/aweme/v1/web/aweme/detail/'

/** douyin_web 项目的签名盐（来自官方 web SDK 常量） */
const SALT = 'A96D855A08C0A9707F8BEF0D9A527E4E'

const cache = new TTLCache()
/** 短链 -> 真实地址 的映射缓存，避免重复跟随 302 */
const redirectCache = new TTLCache({ max: 500 })

function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex')
}

/** 拼查询串并签名：sig = md5(uifid_stamp_SALT_query)，签名只放 query */
function buildSignedQuery(params, uifid) {
  const stamp = String(Math.floor(Date.now() / 1000))
  const pairs = Object.keys(params).map(k => [k, String(params[k])])
  pairs.push(['uifid', uifid], ['timestamp', stamp])
  const query = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  const sig = md5(`${uifid}_${stamp}_${SALT}_${query}`)
  return `${query}&x-secsdk-web-signature=${sig}`
}

function urlList(addr) {
  if (!addr || !Array.isArray(addr.url_list)) return []
  return addr.url_list.filter(u => typeof u === 'string' && u.indexOf('http') === 0)
}

/** 选地址：play_addr（无水印）→ bit_rate 最高码率 → download_addr（带水印） */
function pickVideo(detail) {
  const video = (detail && detail.video) || {}
  const play = urlList(video.play_addr)
  if (play.length) return { url: play[0], watermark: false }

  const bitrate = []
  ;(video.bit_rate || []).forEach(item => bitrate.push(...urlList(item.play_addr)))
  if (bitrate.length) {
    const score = u => {
      const m = String(u).match(/br=(\d+)/)
      return m ? Number(m[1]) : 0
    }
    bitrate.sort((a, b) => score(b) - score(a))
    return { url: bitrate[0], watermark: false }
  }

  const download = urlList(video.download_addr)
  if (download.length) return { url: download[0], watermark: true }
  return { url: '', watermark: false }
}

/** 请求详情接口（在限速队列内执行）；identity 由调用方给出（主身份或待验证的新身份） */
async function fetchDetailWith(identity, awemeId) {
  const uifid = getUifid(identity)
  if (!uifid) {
    throw identityError('缺少身份 uifid：请配置环境变量 DOUYIN_UIFID，或本机执行 node tools/refresh-identity.js')
  }

  const ua = identity.ua || config.ua
  const cookie = await getCookie(identity, awemeId)
  const query = buildSignedQuery({ aweme_id: awemeId }, uifid)

  const headers = {
    'User-Agent': ua,
    Referer: `https://www.douyin.com/video/${awemeId}`,
    Accept: 'application/json',
  }
  if (cookie) headers.Cookie = cookie

  let resp
  let text
  try {
    resp = await fetch(`${DETAIL_URL}?${query}`, { headers })
    text = await resp.text()
  } catch (e) {
    throw network(`请求抖音失败（网络层）：${e.message}`)
  }

  if (resp.status !== 200) {
    if (/Uifid\s*Not\s*Found/i.test(text)) {
      throw identityError('抖音提示 Uifid Not Found：请刷新 DOUYIN_UIFID')
    }
    invalidateTtwid()
    throw risk(`抖音返回 HTTP ${resp.status}（疑似风控），已丢弃 ttwid`)
  }
  if (!text) {
    // 实测：身份被拒时返回 200 + 空 body
    invalidateTtwid()
    throw risk('抖音返回空响应（身份被风控），已丢弃 ttwid')
  }

  let payload
  try {
    payload = JSON.parse(text)
  } catch (e) {
    invalidateTtwid()
    throw risk(`抖音返回非 JSON（疑似风控）：${text.slice(0, 60)}`)
  }

  if ([8, 2154, 2156, 10000, 10001].indexOf(payload.status_code) >= 0) {
    invalidateTtwid()
    throw risk(`抖音风控 status_code=${payload.status_code}，已丢弃 ttwid`)
  }

  if (!payload.aweme_detail) {
    // 作品不存在（status_code=5）或已被过滤（filter_detail.filter_reason）
    const filter = payload.filter_detail || {}
    const reason = filter.filter_reason ? `（filter_reason=${filter.filter_reason}）` : ''
    throw business(`作品不存在或不可见${reason}`)
  }

  const detail = payload.aweme_detail
  const best = pickVideo(detail)
  if (!best.url) throw business('接口未返回视频地址（可能需要登录或该作品不可见）')

  const video = detail.video || {}
  return {
    url: best.url,
    title: String(detail.desc || '').trim() || '抖音视频',
    cover: urlList(video.cover)[0] || '',
    author: (detail.author && detail.author.nickname) || '',
    duration: Math.floor(Number(video.duration || 0) / 1000),
    watermark: best.watermark,
    awemeId,
  }
}

/** 解析一条分享链接 / 分享文案 */
async function parseVideo(shareUrl) {
  const target = String(shareUrl || '').trim()
  if (!target) throw input('缺少链接')

  if (isDirectVideoUrl(target)) {
    return {
      url: target,
      title: decodeURIComponent(target.split('/').pop().split('?')[0] || '视频'),
      cover: '',
      author: '',
      duration: 0,
      watermark: false,
      awemeId: '',
      cached: false,
    }
  }

  let finalUrl = redirectCache.get(target)
  if (!finalUrl) {
    try {
      finalUrl = await resolveRedirect(target)
      redirectCache.set(target, finalUrl)
    } catch (e) {
      throw network(`短链解析失败（网络层）：${e.message}`)
    }
  }

  const awemeId = extractAwemeId(finalUrl) || extractAwemeId(target)
  if (!awemeId) throw input(`无法从链接中识别视频 ID（${String(finalUrl).slice(0, 80)}）`)

  const cached = cache.get(awemeId)
  if (cached) return Object.assign({}, cached, { cached: true })

  // 全局并发 1 + 最小间隔：避免同一出口短时间密集请求
  let info
  try {
    info = await schedule(() => fetchDetail(awemeId))
  } catch (e) {
    if (e && e.code === 'risk_control') {
      // 主身份被风控：有备则备转主并立即重试一次；无备则后台铸新主，本次先报错
      const switched = pool.failover(e.message)
      if (!switched) throw e
      console.warn('[douyin] 已切换到备用身份，重试 %s', awemeId)
      info = await schedule(() => fetchDetail(awemeId))
    } else {
      throw e
    }
  }
  cache.set(awemeId, info)
  return Object.assign({}, info, { cached: false })
}

/** 用当前主身份请求详情（fetchDetailWith 的默认入口） */
async function fetchDetail(awemeId) {
  const identity = pool.getPrimary()
  if (!identity || identity.dead) {
    throw identityError('暂无可用身份，正在自动补充，请稍后重试')
  }
  return fetchDetailWith(identity, awemeId)
}

function cacheStats() {
  return cache.stats
}

module.exports = { parseVideo, fetchDetailWith, cacheStats }
