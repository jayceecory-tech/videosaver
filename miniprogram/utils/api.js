const { cloud: cloudConf, allowDirectLink } = require('../config')
const { extractFirstUrl, isDirectVideoUrl } = require('./parser')
const { callContainer } = require('./cloud')

/**
 * 云托管在微信私有链路里返回的可能是内网 host，
 * 而 wx.downloadFile 必须走公网域名，所以按配置强制改写 host
 */
function withPublicHost(url) {
  const base = (cloudConf && cloudConf.publicHost) || ''
  if (!base) return url
  const idx = String(url).indexOf('/api/')
  if (idx < 0) return url
  return base.replace(/\/+$/, '') + String(url).slice(idx)
}

function normalize(data) {
  return {
    url: data.url,
    title: data.title || '视频',
    cover: data.cover || data.thumbnail || '',
    author: data.author || data.nickname || '',
    duration: data.duration || 0,
    watermark: !!data.watermark,
    cached: !!data.cached,
  }
}

/**
 * 服务端错误分类 -> 用户能看懂的提示
 * 服务端会返回 code：risk_control / business_error / identity_missing / network_error / bad_input
 */
const ERROR_HINTS = {
  risk_control: '当前请求较多，请稍后再试',
  business_error: '该作品不存在、已删除或设为私密',
  identity_missing: '服务正在维护，请稍后再试',
  network_error: '网络异常，请稍后重试',
  bad_input: '没识别到有效链接',
}

function friendlyError(code, fallback) {
  return ERROR_HINTS[String(code)] || fallback || '解析失败，请稍后重试'
}

/** 调用云托管解析分享文案 */
function parseViaCloud(text, url) {
  return callContainer('/api/parse', 'POST', { text: String(text || ''), url }).then(body => {
    const payload = body && body.data && typeof body.data === 'object' ? body.data : body
    if (body && body.code !== undefined && Number(body.code) !== 0) {
      throw new Error(friendlyError(body.code, body.message || body.msg))
    }
    if (!payload || !payload.url) throw new Error('解析失败，请稍后重试')
    const info = normalize(payload)
    info.url = withPublicHost(info.url)
    return Object.assign(info, { sourceUrl: url })
  })
}

/**
 * 解析分享文案 -> 视频直链
 * @param {string} text 分享文案或链接
 * @returns {Promise<{url:string, title:string, cover:string, author:string, sourceUrl:string}>}
 */
function parseShareText(text) {
  const url = extractFirstUrl(text)
  if (!url) {
    return Promise.reject(new Error('没有识别到链接，请粘贴包含 http(s) 链接的分享文案'))
  }

  if (isDirectVideoUrl(url) && allowDirectLink) {
    return Promise.resolve({
      url,
      title: decodeURIComponent(url.split('/').pop().split('?')[0] || '视频'),
      cover: '',
      author: '',
      duration: 0,
      watermark: false,
      sourceUrl: url,
    })
  }

  return parseViaCloud(text, url)
}

module.exports = {
  parseShareText,
}
