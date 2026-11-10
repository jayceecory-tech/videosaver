// app.js
const { cloud } = require('./config')

App({
  onLaunch() {
    if (wx.cloud && typeof wx.cloud.init === 'function') {
      try {
        wx.cloud.init({ env: cloud.env, traceUser: true })
      } catch (e) {
        // 初始化失败时，后续云调用会给出统一错误提示
      }
    }
    // 开启右上角菜单的「发送给朋友」与「分享到朋友圈」入口
    if (wx.showShareMenu) {
      try {
        wx.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage', 'shareTimeline'] })
      } catch (e) {
        // 低版本基础库不支持 menus 参数，忽略
      }
    }
  },
})
