/**
 * VideoSaver 配置
 */
module.exports = {
  /** 微信云托管 */
  cloud: {
    /** 云托管环境 ID */
    env: 'prod-d1g7rwnvf8b5efd99',
    /** 云托管服务名 */
    service: 'videosaver',
    /** 云托管公网域名（用于下载视频） */
    publicHost: 'https://videosaver-339855-12-1523300355.sh.run.tcloudbase.com',
  },

  /** 是否允许「视频直链」直接下载（不经过解析服务） */
  allowDirectLink: true,

  requestTimeout: 15000,
  downloadTimeout: 180000,

  /** 历史记录最多保存条数 */
  maxHistory: 100,
}
