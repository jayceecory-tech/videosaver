/**
 * 新身份验证：铸造出的 uifid 用一次真实解析确认可用，才允许入池
 * （避免把「铸出来了但实际不能用」的身份放进池子）
 */
const { fetchDetailWith } = require('./douyin')

/** 用一个公开视频做验证（不写解析缓存） */
const VERIFY_AWEME_ID = process.env.VERIFY_AWEME_ID || '7701635552671567119'

async function verifyIdentity(minted) {
  try {
    const info = await fetchDetailWith(minted, VERIFY_AWEME_ID)
    if (info && info.url) return { ok: true }
    return { ok: false, error: '验证解析未返回视频地址' }
  } catch (e) {
    return { ok: false, error: e.message ? String(e.message).slice(0, 100) : '未知错误' }
  }
}

module.exports = { verifyIdentity }
