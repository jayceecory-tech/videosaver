const os = require('os')

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '0.0.0.0'

/** 取第一个局域网 IPv4，便于真机/模拟器都用同一个地址 */
function firstLanIp() {
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return '127.0.0.1'
}

module.exports = {
  port: PORT,
  host: HOST,

  /** 对外可访问的服务地址，用于拼接代理下载地址（真机调试填局域网 IP 或已备案 https 域名） */
  publicBase: process.env.PUBLIC_BASE || `http://${firstLanIp()}:${PORT}`,

  /** 请求用的 UA（identity.json 里带了则以 identity.json 为准） */
  ua: process.env.UA
    || 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',

  /** 解析超时（毫秒） */
  parseTimeout: Number(process.env.PARSE_TIMEOUT || 45000),

  /** 代理令牌有效期（毫秒） */
  tokenTTL: Number(process.env.TOKEN_TTL || 30 * 60 * 1000),
}
