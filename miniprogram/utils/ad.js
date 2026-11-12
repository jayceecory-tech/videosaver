/**
 * 激励视频广告 + 24 小时授权
 *
 * 规则：
 * - 首次保存（或距上次授权超过 24 小时）需观看一次激励视频
 * - 看完后 24 小时内保存不再检查
 * - 广告拉取失败不阻断用户（放行），用户中途关闭则不放行
 */
const { ad, cloud } = require('../config')

const STORAGE_KEY = 'videosaver_ad_until'
const WINDOW_MS = 24 * 60 * 60 * 1000

let rewardedAd = null
let adError = ''
let warmupAt = 0

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
      // 放行且非正常看完（fail-open）时告知用户，避免「没看广告就通过了」的困惑
      if (ok && reason) {
        try {
          wx.showToast({ title: reason.slice(0, 20), icon: 'none', duration: 3000 })
        } catch (e) {
          // ignore
        }
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
        finish(false, '需完整观看广告后才能继续')
      }
    }

    // 广告组件报错只记录，交给 show 重试链路处理；重试耗尽才放行
    const onError = () => {
      adError = '广告加载失败'
    }

    instance.onClose(onClose)
    instance.onError(onError)

    /**
     * 关键修复：show 失败大多是「素材尚在加载」（毫秒级失败），
     * 此前直接走 fail-open 导致没弹广告就放行。
     * 现在按 1.2s 间隔重试 2 次（每次先确保 load），给素材加载留出时间。
     */
    const attemptShow = attempt => {
      instance.show().catch(() => {
        if (attempt >= 2) {
          // 多次尝试仍拉不到广告：放行（合规兜底，不阻断用户），并提示
          finish(true, '广告暂时无法加载，已直接放行')
          return
        }
        setTimeout(() => {
          instance
            .load()
            .catch(() => {})
            .then(() => attemptShow(attempt + 1))
        }, 1200)
      })
    }

    instance
      .load()
      .catch(() => {})
      .then(() => attemptShow(0))
  })
}

/** 预热广告实例（进入页面时调用，减少点击保存后的等待） */
function preload() {
  getAd()
}

/**
 * 探活并顺带拉起云托管实例（有流量即扩容）。
 * 在广告播放期间并行执行：30 秒广告刚好覆盖 10~20 秒冷启动，
 * 用户看完广告时服务通常已就绪。
 */
function warmup() {
  const now = Date.now()
  if (now - warmupAt < 60 * 1000) return
  warmupAt = now
  if (!wx.cloud || typeof wx.cloud.callContainer !== 'function') return
  try {
    wx.cloud.callContainer({
      config: { env: cloud.env },
      path: '/api/health',
      method: 'GET',
      header: { 'X-WX-SERVICE': cloud.service },
      timeout: 8000,
      success() {},
      fail() {},
    })
  } catch (e) {
    // 探活失败不影响主流程
  }
}

/**
 * 广告门槛（页面共享）：
 * 已授权 → 直接执行 action；否则弹窗确认，同意后先探活拉起实例，再播广告，
 * 看完自动执行 action。
 * @param {() => void} action 授权通过后执行的动作
 */
function withAdGate(action) {
  if (isGranted()) {
    action()
    return
  }
  wx.showModal({
    title: '解锁功能',
    content: '观看一小段视频广告，即可解锁提取、保存与复制链接，之后 24 小时内无需重复观看。',
    confirmText: '观看广告',
    cancelText: '暂不使用',
    success: res => {
      if (!res.confirm) return
      // 与广告并行：先把服务实例拉起来，广告看完时实例通常已就绪
      warmup()
      // 确认后立即预加载素材，缩短 show 的等待
      preload()
      action()
    },
  })
}

module.exports = {
  isGranted,
  remainMs,
  ensureAdGrant,
  withAdGate,
  warmup,
  preload,
  STORAGE_KEY,
}
