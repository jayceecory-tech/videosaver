/**
 * 激励视频广告 + 24 小时授权
 *
 * 规则：
 * - 首次保存（或距上次授权超过 24 小时）需观看一次激励视频
 * - 看完后 24 小时内保存不再检查
 * - 广告拉取失败不阻断用户（放行），用户中途关闭则不放行
 */
const { ad } = require('../config')

const STORAGE_KEY = 'videosaver_ad_until'
const WINDOW_MS = 24 * 60 * 60 * 1000

let rewardedAd = null
let adError = ''

function supported() {
  return !!(wx.createRewardedVideoAd && ad && ad.rewardedUnitId)
}

function getAd() {
  if (!supported()) return null
  if (rewardedAd) return rewardedAd
  try {
    rewardedAd = wx.createRewardedVideoAd({ adUnitId: ad.rewardedUnitId })
    rewardedAd.onError(err => {
      adError = (err && (err.errMsg || err.message)) || '广告加载失败'
    })
    // 预热，减少点击后的等待
    rewardedAd.load().catch(() => {})
  } catch (e) {
    rewardedAd = null
  }
  return rewardedAd
}

/** 当前是否处于免广告窗口内 */
function isGranted() {
  try {
    return Number(wx.getStorageSync(STORAGE_KEY) || 0) > Date.now()
  } catch (e) {
    return false
  }
}

/** 记录授权：从现在起 24 小时免广告 */
function grant() {
  try {
    wx.setStorageSync(STORAGE_KEY, Date.now() + WINDOW_MS)
  } catch (e) {
    // 存储失败不影响本次使用
  }
}

/** 距离下次需要看广告还有多久（毫秒），已过期返回 0 */
function remainMs() {
  try {
    const until = Number(wx.getStorageSync(STORAGE_KEY) || 0)
    return Math.max(0, until - Date.now())
  } catch (e) {
    return 0
  }
}

/**
 * 确保本次操作已获得广告授权
 * @returns {Promise<{ok:boolean, free?:boolean, reason?:string}>}
 */
function ensureAdGrant() {
  if (isGranted()) return Promise.resolve({ ok: true, free: true })

  const instance = getAd()
  // 未配置广告位或基础库不支持：直接放行
  if (!instance) return Promise.resolve({ ok: true, free: true })

  return new Promise(resolve => {
    let settled = false
    const finish = (ok, reason) => {
      if (settled) return
      settled = true
      try {
        if (instance.offClose) instance.offClose(onClose)
        if (instance.offError) instance.offError(onError)
      } catch (e) {
        // ignore
      }
      resolve({ ok, reason })
    }

    const onClose = res => {
      // 基础库 2.1.0 之前 res 为 undefined
      const ended = res === undefined ? true : !!(res && res.isEnded)
      if (ended) {
        grant()
        finish(true)
      } else {
        finish(false, '需完整观看广告后才能保存')
      }
    }

    const onError = () => finish(true, '') // 广告异常放行，不阻断用户

    instance.onClose(onClose)
    instance.onError(onError)

    instance
      .show()
      .catch(() =>
        instance
          .load()
          .then(() => instance.show())
          .catch(() => finish(true, '')), // 拉不到广告也放行
      )
  })
}

/** 预热广告实例（进入页面时调用，减少点击保存后的等待） */
function preload() {
  getAd()
}

/**
 * 广告门槛（页面共享）：
 * 已授权 → 直接执行 action；否则弹窗确认，用户同意后观看广告，看完自动执行。
 * @param {() => void} action 授权通过后执行的动作
 */
function withAdGate(action) {
  if (isGranted()) {
    action()
    return
  }
  wx.showModal({
    title: '解锁功能',
    content: '观看一小段视频广告，即可解锁保存与复制链接，之后 24 小时内无需重复观看。',
    confirmText: '观看广告',
    cancelText: '暂不使用',
    success: res => {
      if (res.confirm) action()
    },
  })
}

module.exports = {
  isGranted,
  remainMs,
  ensureAdGrant,
  withAdGate,
  preload,
  STORAGE_KEY,
}
