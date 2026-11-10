const { downloadTimeout } = require('../config')
const { guessExt } = require('./parser')

const ALBUM_SCOPE = 'scope.writePhotosAlbum'

/** 确保已获得保存到相册授权 */
function ensureAlbumAuth() {
  return new Promise((resolve, reject) => {
    wx.getSetting({
      success(res) {
        const auth = res.authSetting[ALBUM_SCOPE]
        if (auth === true) {
          resolve()
          return
        }
        if (auth === false) {
          wx.showModal({
            title: '需要相册权限',
            content: '保存视频到相册需要「保存到相册」权限，是否前往开启？',
            confirmText: '去开启',
            success(r) {
              if (!r.confirm) {
                reject(new Error('未获得相册权限'))
                return
              }
              wx.openSetting({
                success(s) {
                  if (s.authSetting[ALBUM_SCOPE]) resolve()
                  else reject(new Error('未获得相册权限'))
                },
                fail() {
                  reject(new Error('打开设置失败'))
                },
              })
            },
          })
          return
        }
        wx.authorize({
          scope: ALBUM_SCOPE,
          success: resolve,
          fail() {
            reject(new Error('未获得相册权限'))
          },
        })
      },
      fail() {
        reject(new Error('获取授权状态失败'))
      },
    })
  })
}

/**
 * 下载视频到本地
 * @param {string} url 视频地址
 * @param {(progress:number, totalSize:number, writtenSize:number) => void} onProgress
 * @param {(task:object) => void} onTask 返回 DownloadTask，用于取消
 */
/** 清理下载缓存，仅保留最近 keep 个文件（小程序本地文件上限 200MB） */
function cleanCache(keep) {
  try {
    const fsm = wx.getFileSystemManager()
    const dir = wx.env.USER_DATA_PATH
    const files = fsm.readdirSync(dir) || []
    const mine = files
      .filter(name => typeof name === 'string' && name.indexOf('videosaver_') === 0)
      .map(name => ({ name, ts: Number((name.match(/videosaver_(\d+)/) || [])[1] || 0) }))
      .sort((a, b) => b.ts - a.ts)
    mine.slice(keep).forEach(item => {
      try {
        fsm.unlinkSync(`${dir}/${item.name}`)
      } catch (e) {
        // ignore
      }
    })
  } catch (e) {
    // ignore
  }
}

function downloadVideo(url, onProgress, onTask) {
  return new Promise((resolve, reject) => {
    // 小程序本地文件总量上限 200MB，下载前清理旧缓存，避免「空间不足」
    cleanCache(2)

    const filePath = `${wx.env.USER_DATA_PATH}/videosaver_${Date.now()}.${guessExt(url)}`
    const task = wx.downloadFile({
      url,
      filePath,
      timeout: downloadTimeout,
      success(res) {
        if (res.statusCode && res.statusCode !== 200) {
          reject(new Error(`下载失败（${res.statusCode}）`))
          return
        }
        resolve({ filePath: res.filePath, tempFilePath: res.tempFilePath })
      },
      fail(err) {
        const msg = (err && err.errMsg) || ''
        if (msg.indexOf('abort') >= 0) {
          reject(new Error('已取消下载'))
          return
        }
        if (msg.indexOf('exceed') >= 0 || msg.indexOf('max file size') >= 0 || msg.indexOf('no space') >= 0) {
          reject(new Error('本地存储空间不足，请清理后重试'))
          return
        }
        reject(new Error(msg || '下载失败'))
      },
    })

    if (typeof onTask === 'function') onTask(task)
    if (task && typeof task.onProgressUpdate === 'function' && typeof onProgress === 'function') {
      task.onProgressUpdate(res => {
        onProgress(res.progress || 0, res.totalBytesWritten || 0, res.totalBytesExpectedToWrite || 0)
      })
    }
  })
}

/** 获取文件大小（失败返回 0） */
function getFileSize(filePath) {
  return new Promise(resolve => {
    wx.getFileSystemManager().getFileInfo({
      filePath,
      success(res) {
        resolve(res.size || 0)
      },
      fail() {
        resolve(0)
      },
    })
  })
}

/** 保存视频到系统相册 */
function saveToAlbum(filePath) {
  return ensureAlbumAuth().then(() => new Promise((resolve, reject) => {
    wx.saveVideoToPhotosAlbum({
      filePath,
      success: resolve,
      fail(err) {
        const msg = (err && err.errMsg) || ''
        if (msg.indexOf('auth deny') >= 0 || msg.indexOf('authorize') >= 0) {
          reject(new Error('未获得相册权限'))
          return
        }
        if (msg.indexOf('invalid video') >= 0 || msg.indexOf('format') >= 0) {
          reject(new Error('视频格式不支持保存到相册'))
          return
        }
        if (msg.indexOf('privacy') >= 0 || msg.indexOf('112') >= 0) {
          reject(new Error('未声明隐私权限：请在小程序后台「用户隐私保护指引」中勾选相册（仅写入）'))
          return
        }
        reject(new Error(msg || '保存失败'))
      },
    })
  }))
}

module.exports = {
  ensureAlbumAuth,
  downloadVideo,
  getFileSize,
  saveToAlbum,
}
