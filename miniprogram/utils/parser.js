const URL_RE = /https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g
const DIRECT_VIDEO_RE = /\.(mp4|mov|m4v|webm|m3u8)(\?|#|$)/i

/** 从分享文案中提取第一个 http(s) 链接 */
function extractFirstUrl(text) {
  if (!text) return ''
  const matched = String(text).match(URL_RE)
  if (!matched || !matched.length) return ''
  // 去掉结尾的中文标点/括号等干扰字符
  return matched[0].replace(/[，。！？、；：）】》"']+$/, '')
}

/** 判断是否为可直接下载的视频直链 */
function isDirectVideoUrl(url) {
  if (!url) return false
  return DIRECT_VIDEO_RE.test(url)
}

/** 生成安全的文件名 */
function safeFileName(name, ext) {
  const base = String(name || 'video').replace(/[\\/:*?"<>|\n\r\t]/g, '_').slice(0, 40)
  return `${base || 'video'}.${ext || 'mp4'}`
}

/** 从 url 推断文件后缀 */
function guessExt(url) {
  const matched = String(url || '').match(/\.(mp4|mov|m4v|webm|m3u8)(?=[?#]|$)/i)
  return matched ? matched[1].toLowerCase() : 'mp4'
}

module.exports = {
  extractFirstUrl,
  isDirectVideoUrl,
  safeFileName,
  guessExt,
}
