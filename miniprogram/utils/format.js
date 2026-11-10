/** 字节数格式化 */
function formatSize(size) {
  const n = Number(size) || 0
  if (n <= 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 时间戳格式化为 YYYY-MM-DD HH:mm */
function formatTime(ts) {
  const d = new Date(Number(ts) || Date.now())
  const pad = v => (v < 10 ? `0${v}` : `${v}`)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

module.exports = {
  formatSize,
  formatTime,
}
