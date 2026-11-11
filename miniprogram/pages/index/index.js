const { parseShareText } = require('../../utils/api')
const { extractFirstUrl } = require('../../utils/parser')
const { downloadVideo, getFileSize, saveToAlbum } = require('../../utils/media')
const { ad } = require('../../config')
const { isGranted, ensureAdGrant, preload } = require('../../utils/ad')
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

Page({
  data: {
    text: '',
    phase: 'idle',
    busy: false,
    progress: 0,
    progressText: '',
    error: '',
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
    this.setData({ text: (e.detail && e.detail.value) || '', error: '' })
  },

  onPaste() {
    wx.getClipboardData({
      success: res => {
        if (!res || !res.data) {
          wx.showToast({ title: '剪贴板为空', icon: 'none' })
          return
        }
        this.setData({ text: res.data, error: '' })
      },
      fail: () => {
        wx.showToast({ title: '读取剪贴板失败', icon: 'none' })
      },
    })
  },

  onClear() {
    if (this.data.busy) return
    this.filePath = ''
    this.videoSize = 0
    this.setData({ text: '', error: '', result: null, sizeText: '', progress: 0, localPath: '' })
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
      this.setData({ error: '请先粘贴分享文案或视频链接' })
      return
    }

    try {
      wx.setStorageSync('videosaver_draft', text)
    } catch (e) {
      // ignore
    }

    this.setData({ error: '', result: null, sizeText: '', progress: 0, localPath: '' })
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

  /** 保存视频：已授权直接保存；否则弹窗确认 → 观看广告 → 看完自动保存 */
  onSave() {
    if (this.data.busy || !this.filePath) return
    if (isGranted()) {
      this.saveNow()
      return
    }
    wx.showModal({
      title: '解锁保存到相册',
      content: '观看一小段视频广告，即可保存本次视频，之后 24 小时内无需重复观看。',
      confirmText: '观看广告',
      cancelText: '暂不保存',
      success: res => {
        if (res.confirm) this.saveNow()
      },
    })
  },

  /** 确认/授权通过后：真正下载视频 → 写入相册（看完广告自动执行） */
  saveNow() {
    const info = this.data.result || {}
    this.setPhase('downloading', { progress: 0 })

    ensureAdGrant()
      .then(res => {
        if (!res.ok) {
          this.setPhase(this.data.result ? 'ready' : 'idle')
          wx.showToast({ title: res.reason || '需完整观看广告后才能保存', icon: 'none' })
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

  onCopyLink() {
    const url = this.data.result && this.data.result.url
    if (!url) return
    wx.setClipboardData({ data: url })
  },

  onCancel() {
    this.abortTask()
    this.setPhase('idle', { progress: 0 })
    wx.showToast({ title: '已取消', icon: 'none' })
  },

  onFail(err) {
    this.task = null
    const msg = (err && err.message) || '处理失败'
    this.setPhase('failed', { error: msg })
    this.setData({ busy: false, progressText: '' })
    wx.showToast({ title: msg.slice(0, 20), icon: 'none' })
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
