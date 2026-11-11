/**
 * 请求防护（零依赖）：
 * 1. 来源校验：微信云托管私有链路（callContainer）会自动注入 x-wx-source / x-wx-openid，
 *    外域直接 curl 公网域名没有这些头 → 拒绝，防止身份池被脚本滥用。
 * 2. 按用户限流：以 openid 为 key 的内存时间窗（每用户每分钟 5 次、每小时 30 次）。
 *
 * 环境变量 DISABLE_GUARD=1 可关闭（本地调试用）。
 */

const LIMITS = {
  minute: { ms: 60 * 1000, max: 5 },
  hour: { ms: 60 * 60 * 1000, max: 30 },
}

const windows = new Map() // openid -> { minute: {ts,n}, hour: {ts,n} }
let lastSweep = Date.now()

function sweep(now) {
  if (now - lastSweep < 5 * 60 * 1000) return
  lastSweep = now
  windows.forEach((w, key) => {
    if (w.minute.ts + LIMITS.minute.ms < now && w.hour.ts + LIMITS.hour.ms < now) {
      windows.delete(key)
    }
  })
}

function overLimit(openid, now) {
  let w = windows.get(openid)
  if (!w) {
    w = { minute: { ts: 0, n: 0 }, hour: { ts: 0, n: 0 } }
    windows.set(openid, w)
  }
  let over = false
  for (const key of Object.keys(LIMITS)) {
    const { ms, max } = LIMITS[key]
    const slot = w[key]
    if (now - slot.ts >= ms) {
      slot.ts = now
      slot.n = 0
    }
    slot.n += 1
    if (slot.n > max) over = true
  }
  return over
}

/**
 * 校验解析请求。
 * @returns {null} 通过
 * @returns {{status:number, body:object}} 拒绝
 */
function guardParse(req) {
  if (process.env.DISABLE_GUARD === '1') return null

  const source = req.headers['x-wx-source']
  const openid = req.headers['x-wx-openid']
  if (!source || !openid) {
    return { status: 403, body: { code: 'forbidden', message: 'forbidden' } }
  }

  sweep(Date.now())
  if (overLimit(String(openid), Date.now())) {
    return { status: 429, body: { code: 'rate_limited', message: '今日使用已达上限，请明天再试' } }
  }
  return null
}

module.exports = { guardParse }
