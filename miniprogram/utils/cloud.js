/**
 * 微信云托管调用封装
 *
 * 说明：
 * - callContainer 走微信私有协议，不需要在 mp 后台配置 request 合法域名
 * - 限制：超时 ≤15s、请求体 ≤100K、响应仅 json/text，因此只用来「解析」，
 *   视频本体用 wx.downloadFile 拉云托管公网域名（需配置 downloadFile 合法域名）
 */
const { cloud } = require('../config')

/** 调用云托管服务，返回响应体（对象） */
function callContainer(path, method, data, timeout) {
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
          reject(new Error('服务暂时不可用，请稍后重试'))
          return
        }
        resolve(res.data)
      },
      fail() {
        reject(new Error('网络异常，请稍后重试'))
      },
    })
  })
}

module.exports = {
  callContainer,
}
