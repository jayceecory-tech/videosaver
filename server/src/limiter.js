/**
 * 单身份串行调度：全局并发 = 1，相邻任务间隔 >= MIN_INTERVAL
 *
 * 依据（Evil0ctal 项目文档）：真实会话本来就不会并发发请求，
 * 「同一出口 + 同一 UA 后面轮换 cookie」比单纯高频更可疑，
 * 所以提升吞吐应当靠缓存和多身份，而不是提高并发。
 */
const MIN_INTERVAL = Number(process.env.MIN_REQUEST_INTERVAL_MS || 1000)

let tail = Promise.resolve()
let lastAt = 0

/** 排队执行；返回 Promise。前一个任务失败不影响后面 */
function schedule(task) {
  const run = async () => {
    const wait = lastAt + MIN_INTERVAL - Date.now()
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    lastAt = Date.now()
    return task()
  }
  const result = tail.then(run, run)
  tail = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

module.exports = { schedule, MIN_INTERVAL }
