const { maxHistory } = require('../config')

const KEY = 'videosaver_history'

function getHistory() {
  try {
    const list = wx.getStorageSync(KEY)
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

function setHistory(list) {
  try {
    wx.setStorageSync(KEY, list)
  } catch (e) {
    // ignore
  }
  return list
}

function createId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** 新增/更新一条历史（同一来源链接去重后置于顶部） */
function addHistory(item) {
  const list = getHistory().filter(i => i.sourceUrl !== item.sourceUrl)
  const record = Object.assign({ id: createId(), createTime: Date.now(), size: 0 }, item)
  list.unshift(record)
  return setHistory(list.slice(0, maxHistory))
}

/** 更新某条记录（如文件大小） */
function updateHistory(id, patch) {
  const list = getHistory().map(item => (item.id === id ? Object.assign({}, item, patch) : item))
  return setHistory(list)
}

function removeHistory(id) {
  return setHistory(getHistory().filter(i => i.id !== id))
}

function clearHistory() {
  return setHistory([])
}

module.exports = {
  getHistory,
  addHistory,
  updateHistory,
  removeHistory,
  clearHistory,
}
