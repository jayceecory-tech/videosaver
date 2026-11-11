/**
 * 微信云托管调用封装
 *
 * 说明：
 * - callContainer 走微信私有协议，不需要在 mp 后台配置 request 合法域名
 * - 限制：超时 ≤15s、请求体 ≤100K、响应仅 json/text，因此只用来「解析」，
 *   视频本体用 wx.downloadFile 拉云托管公网域名（需配置 downloadFile 合法域名）
 * - 实例最小副本为 0 时存在冷启动（10~20s），超时自动重试 1 次；
 *   仍失败则提示「服务正在唤醒」
 */
const { cloud } = require('../config')

function callOnce(path, method, data, timeout) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud || typeof wx.cloud.callContainer !== 'function') {
      reject(new Error('当前微信版本过低，请升级微信后重试'))
      return
    }

    wx.cloud.callContainer({
      config: { env: cloud.env },
      path,
      method: method || 'POST',
      header: { 'X-WX-SERVICE': cloud.service, 'content-type': 'application/json' },
      data: data || {},
      timeout: timeout || 15000,
      success(res) {
        if (res.statusCode && res.statusCode >= 400) {
          // 服务端结构化错误码优先（rate_limited / forbidden 等），让 api.js 做友好映射
          const bodyCode = res.data && typeof res.data === 'object' && res.data.code && Number(res.data.code) !== 0
            ? res.data.code
            : ''
          if (bodyCode) {
            const err = new Error('服务暂时不可用，请稍后重试')
            err.code = bodyCode
            reject(err)
            return
          }
          const err = new Error('服务暂时不可用，请稍后重试')
          err.retriable = res.statusCode >= 500
          reject(err)
          return
        }
        resolve(res.data)
      },
      fail(e) {
        const msg = (e && e.errMsg) || ''
        const err = new Error('服务正在唤醒，请稍候重试')
        // 超时/连接类失败大多由冷启动导致，值得重试
        err.retriable = msg.indexOf('timeout') >= 0 || msg.indexOf('request:fail') >= 0
        reject(err)
      },
    })
  })
}

/**
 * 调用云托管服务，返回响应体（对象）。
 * 不在此层重试：重试由页面层统一做一次（失败时已有 warmup 拉着实例，语义更清晰、不叠加等待）
 */
function callContainer(path, method, data, timeout) {
  return callOnce(path, method, data, timeout)
}

module.exports = {
  callContainer,
}
