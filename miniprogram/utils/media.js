const { downloadTimeout } = require('../config')
const { guessExt } = require('./parser')

const ALBUM_SCOPE = 'scope.writePhotosAlbum'

/** 带 code 的业务错误：让页面能区分「用户取消 / 权限 / 存储 / 网络」并给出对应提示 */
function bizError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

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
                reject(bizError('user_cancel', '已取消保存'))
                return
              }
              wx.openSetting({
                success(s) {
                  if (s.authSetting[ALBUM_SCOPE]) resolve()
                  else reject(bizError('auth_denied', '未开启相册权限，无法保存'))
                },
                fail() {
                  reject(bizError('auth_denied', '未开启相册权限，无法保存'))
                },
              })
            },
            fail() {
              reject(bizError('user_cancel', '已取消保存'))
            },
          })
          return
        }
        wx.authorize({
          scope: ALBUM_SCOPE,
          success: resolve,
          fail() {
            reject(bizError('auth_denied', '未开启相册权限，无法保存'))
          },
        })
      },
      fail() {
        reject(bizError('auth_denied', '无法获取相册权限状态'))
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
          reject(bizError('user_cancel', '已取消下载'))
          return
        }
        if (msg.indexOf('exceed') >= 0 || msg.indexOf('max file size') >= 0 || msg.indexOf('no space') >= 0) {
          reject(bizError('storage', '本地存储空间不足，请清理后重试'))
          return
        }
        reject(bizError('network', '网络异常，下载失败'))
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
        if (msg.indexOf('cancel') >= 0) {
          reject(bizError('user_cancel', '已取消保存'))
          return
        }
        if (msg.indexOf('auth deny') >= 0 || msg.indexOf('authorize') >= 0) {
          reject(bizError('auth_denied', '未开启相册权限，无法保存'))
          return
        }
        if (msg.indexOf('invalid video') >= 0 || msg.indexOf('format') >= 0) {
          reject(bizError('format', '视频格式不支持保存，请重试'))
          return
        }
        if (msg.indexOf('privacy') >= 0 || msg.indexOf('112') >= 0) {
          reject(bizError('privacy', '相册权限未声明，暂时无法保存'))
          return
        }
        reject(bizError('unknown', '保存失败，请重试'))
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
