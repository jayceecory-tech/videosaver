const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const URL_RE = /https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g
const DIRECT_VIDEO_RE = /\.(mp4|mov|m4v|webm|m3u8)(\?|#|$)/i

/** 从整段分享文案中提取第一个 http(s) 链接 */
function extractFirstUrl(text) {
  if (!text) return ''
  const matched = String(text).match(URL_RE)
  if (!matched || !matched.length) return ''
  return matched[0].replace(/[，。！？、；：）】》"']+$/, '')
}

function isDirectVideoUrl(url) {
  return !!url && DIRECT_VIDEO_RE.test(url)
}

/** 跟随 302 取最终地址 */
async function resolveRedirect(url, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA },
    })
    return res.url || url
  } finally {
    clearTimeout(timer)
  }
}

/** 从抖音各类链接中提取视频 ID */
function extractAwemeId(url) {
  const patterns = [
    /\/video\/(\d+)/,
    /\/share\/video\/(\d+)/,
    /modal_id=(\d+)/,
    /\/note\/(\d+)/,
    /aweme_id=(\d+)/,
  ]
  for (const re of patterns) {
    const m = String(url).match(re)
    if (m) return m[1]
  }
  return ''
}

module.exports = {
  extractFirstUrl,
  isDirectVideoUrl,
  resolveRedirect,
  extractAwemeId,
  UA,
}
