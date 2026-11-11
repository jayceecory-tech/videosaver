const { parseShareText } = require('../../utils/api')
const { extractFirstUrl } = require('../../utils/parser')
const { downloadVideo, getFileSize, saveToAlbum } = require('../../utils/media')
const { ad } = require('../../config')
const { isGranted, ensureAdGrant, withAdGate, preload } = require('../../utils/ad')
const { addHistory } = require('../../utils/storage')
const { formatSize } = require('../../utils/format')

const PHASE_TEXT = {
  idle: '',
  parsing: '正在解析链接…',
  downloading: '正在下载视频…',
  ready: '提取完成',
  saving: '正在保存到相册…',
  done: '已保存到相册',
  failed: '处理失败',
}
const BUSY_PHASES = ['parsing', 'downloading', 'saving']

/** 统一的轻提示：3 秒后自动消失，不打断用户 */
function toast(title) {
  wx.showToast({ title: String(title || '').slice(0, 20), icon: 'none', duration: 3000 })
}

Page({
  data: {
    text: '',
    phase: 'idle',
    busy: false,
    progress: 0,
    progressText: '',
    sizeText: '',
    result: null,
    adUnitId: (ad && ad.bannerUnitId) || '',
    /** 是否处于免广告窗口内（24 小时） */
    adFree: false,
    /** 提取完成后的本地视频路径（预览用） */
    localPath: '',
  },

  task: null,
  filePath: '',

  onLoad(options) {
    this.restoreDraft()
    // 朋友圈单页模式（scene 1154）下交互受限，仅回填链接，不自动执行
    const singlePage = (() => {
      try {
        return wx.getLaunchOptionsSync().scene === 1154
      } catch (e) {
        return false
      }
    })()
    const shared = options && options.share ? decodeURIComponent(options.share) : ''
    if (shared && extractFirstUrl(shared)) {
      this.setData({ text: shared })
      if (!singlePage) this.onSubmit()
    }
  },

  onShow() {
    this.setData({ adFree: isGranted() })
    preload()
  },

  onShareAppMessage() {
    const result = this.data.result
    const link = extractFirstUrl(this.data.text || '')
    const path = link ? `/pages/index/index?share=${encodeURIComponent(link)}` : '/pages/index/index'
    return {
      title: result && result.title ? `「视频保存」已帮你保存：${String(result.title).slice(0, 24)}` : '视频保存 · 一键把短视频存到相册',
      path,
      imageUrl: (result && result.cover) || '',
    }
  },

  onShareTimeline() {
    const result = this.data.result
    const link = extractFirstUrl(this.data.text || '')
    return {
      title: '视频保存 · 一键把短视频存到相册',
      query: link ? `share=${encodeURIComponent(link)}` : '',
      imageUrl: (result && result.cover) || '',
    }
  },

  onUnload() {
    this.abortTask()
  },

  onInput(e) {
    this.setData({ text: (e.detail && e.detail.value) || '' })
  },

  onPaste() {
    wx.getClipboardData({
      success: res => {
        if (!res || !res.data) {
          toast('剪贴板为空')
          return
        }
        this.setData({ text: res.data })
      },
      fail: () => {
        toast('读取剪贴板失败')
      },
    })
  },

  onClear() {
    if (this.data.busy) return
    this.filePath = ''
    this.videoSize = 0
    this.setData({ text: '', result: null, sizeText: '', progress: 0, localPath: '' })
    this.setPhase('idle')
    try {
      wx.removeStorageSync('videosaver_draft')
    } catch (e) {
      // ignore
    }
  },

  onSubmit() {
    if (this.data.busy) return
    const text = (this.data.text || '').trim()
    if (!text) {
      toast('请先粘贴分享文案或链接')
      return
    }

    try {
      wx.setStorageSync('videosaver_draft', text)
    } catch (e) {
      // ignore
    }

    this.setData({ result: null, sizeText: '', progress: 0, localPath: '' })
    this.filePath = ''
    this.videoSize = 0
    this.setPhase('parsing')

    parseShareText(text)
      .then(info => {
        // 提取 = 仅解析出信息并展示预览图，不下载视频（真正下载在保存时进行）
        this.setData({ result: info })
        this.setPhase('ready')
      })
      .catch(err => this.onFail(err))
  },

  /** 保存视频 */
  onSave() {
    if (this.data.busy || !this.filePath && !this.data.result) return
    withAdGate(() => this.saveNow())
  },

  /** 确认/授权通过后：真正下载视频 → 写入相册（看完广告自动执行） */
  saveNow() {
    const info = this.data.result || {}
    this.setPhase('downloading', { progress: 0 })

    ensureAdGrant()
      .then(res => {
        if (!res.ok) {
          this.setPhase(this.data.result ? 'ready' : 'idle')
          toast(res.reason || '需完整观看广告后才能保存')
          return null
        }
        return downloadVideo(
          info.url,
          progress => {
            this.setData({
              progress,
              progressText: `${PHASE_TEXT.downloading} ${progress}%`,
            })
          },
          task => {
            this.task = task
          },
        )
          .then(dl => {
            this.filePath = dl.filePath
            return getFileSize(dl.filePath)
          })
          .then(size => {
            this.task = null
            this.videoSize = size
            this.setData({ sizeText: formatSize(size), localPath: this.filePath })
            this.setPhase('saving')
            return saveToAlbum(this.filePath)
          })
          .then(() => {
            this.setPhase('done', { progress: 100 })
            this.setData({ adFree: isGranted() })
            addHistory({
              sourceUrl: info.sourceUrl,
              videoUrl: info.url,
              title: info.title,
              cover: info.cover,
              author: info.author,
              size: this.videoSize || 0,
            })
            wx.showToast({ title: '已保存到相册', icon: 'success' })
          })
      })
      .catch(err => this.onFail(err))
  },

  /** 复制视频直链（同样需要广告授权） */
  onCopyLink() {
    const url = this.data.result && this.data.result.url
    if (!url) return
    withAdGate(() => {
      ensureAdGrant().then(res => {
        if (!res.ok) {
          toast(res.reason || '需完整观看广告后才能复制')
          return
        }
        this.setData({ adFree: isGranted() })
        wx.setClipboardData({ data: url })
      })
    })
  },

  onCancel() {
    this.abortTask()
    this.setPhase('idle', { progress: 0 })
    toast('已取消')
  },

  /**
   * 统一失败处理：只弹 toast（3 秒），并回到可重试状态
   * 用户取消保存/下载时按钮不能消失
   */
  onFail(err) {
    this.task = null
    const msg = (err && err.message) || '处理失败'
    // 有结果说明提取成功过，退回到 ready 让「保存视频」可再次点击
    this.setPhase(this.data.result ? 'ready' : 'idle')
    toast(msg)
  },

  setPhase(phase, extra) {
    const patch = {
      phase,
      busy: BUSY_PHASES.indexOf(phase) >= 0,
      progressText: PHASE_TEXT[phase] || '',
    }
    this.setData(Object.assign(patch, extra || {}))
  },

  abortTask() {
    if (this.task && typeof this.task.abort === 'function') {
      this.task.abort()
    }
    this.task = null
  },

  restoreDraft() {
    try {
      const draft = wx.getStorageSync('videosaver_draft')
      if (draft) this.setData({ text: draft })
    } catch (e) {
      // ignore
    }
  },
})
