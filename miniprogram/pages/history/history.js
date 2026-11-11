const { getHistory, updateHistory, removeHistory, clearHistory } = require('../../utils/storage')
const { downloadVideo, getFileSize, saveToAlbum } = require('../../utils/media')
const { withAdGate, ensureAdGrant } = require('../../utils/ad')
const { formatSize, formatTime } = require('../../utils/format')

Page({
  data: {
    list: [],
    savingId: '',
  },

  task: null,

  onShow() {
    this.loadList()
  },

  onHide() {
    this.abortTask()
  },

  onUnload() {
    this.abortTask()
  },

  loadList() {
    const list = getHistory().map(item => Object.assign({}, item, {
      timeText: formatTime(item.createTime),
      sizeText: formatSize(item.size),
      progress: 0,
    }))
    this.setData({ list, savingId: '' })
  },

  onSave(e) {
    const { id, index } = e.currentTarget.dataset
    if (this.data.savingId) return
    const item = this.data.list[Number(index)]
    if (!item) return

    // 与首页一致：保存同样需要广告授权
    withAdGate(() => this.doSave(item, id, Number(index)))
  },

  doSave(item, id, index) {
    this.setData({ savingId: id })

    ensureAdGrant()
      .then(res => {
        if (!res.ok) {
          wx.showToast({ title: res.reason || '需完整观看广告后才能保存', icon: 'none', duration: 3000 })
          return null
        }
        return downloadVideo(
          item.videoUrl,
          progress => {
            this.setData({ [`list[${index}].progress`]: progress })
          },
          task => {
            this.task = task
          },
        )
          .then(res => getFileSize(res.filePath).then(size => ({ filePath: res.filePath, size })))
          .then(({ filePath, size }) => saveToAlbum(filePath).then(() => size))
          .then(size => {
            wx.showToast({ title: '已保存到相册', icon: 'success' })
            if (size && size !== item.size) {
              updateHistory(item.id, { size })
            }
          })
      })
      .catch(err => {
        wx.showToast({ title: ((err && err.message) || '保存失败').slice(0, 20), icon: 'none', duration: 3000 })
      })
      .then(() => {
        this.abortTask()
        this.setData({ savingId: '' })
        this.loadList()
      })
  },

  onRemove(e) {
    const { id } = e.currentTarget.dataset
    wx.showModal({
      title: '删除记录',
      content: '确定删除这条历史记录吗？',
      success: res => {
        if (!res.confirm) return
        removeHistory(id)
        this.loadList()
      },
    })
  },

  onClearAll() {
    if (!this.data.list.length) return
    wx.showModal({
      title: '清空历史',
      content: '确定清空全部历史记录吗？',
      success: res => {
        if (!res.confirm) return
        clearHistory()
        this.loadList()
        wx.showToast({ title: '已清空', icon: 'none', duration: 3000 })
      },
    })
  },

  onCopy(e) {
    const { url } = e.currentTarget.dataset
    if (!url) return
    // 与首页一致：复制链接同样需要广告授权
    withAdGate(() => {
      ensureAdGrant().then(res => {
        if (!res.ok) {
          wx.showToast({ title: res.reason || '需完整观看广告后才能复制', icon: 'none', duration: 3000 })
          return
        }
        wx.setClipboardData({ data: url })
      })
    })
  },

  abortTask() {
    if (this.task && typeof this.task.abort === 'function') {
      this.task.abort()
    }
    this.task = null
  },
})
