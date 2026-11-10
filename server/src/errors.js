/**
 * 错误分类：不同故障要用不同处置，不能一锅端
 *
 * - risk     命中风控（403 / 空响应 / status_code 8·2154…）：换身份 + 冷却退避
 * - business 作品不存在、已删除、私密、被过滤：与身份无关，**不要**换身份
 * - network  请求没到抖音（DNS/超时/连接重置）：计数 +1，不冷却
 * - identity 我方缺 uifid / 签名缺失：配置问题，提示配 DOUYIN_UIFID
 * - input    链接不合法
 */
const CODES = {
  risk: 'risk_control',
  business: 'business_error',
  network: 'network_error',
  identity: 'identity_missing',
  input: 'bad_input',
}

/** HTTP 状态码映射（对外的接口用） */
const HTTP_STATUS = {
  risk_control: 429,
  business_error: 404,
  network_error: 502,
  identity_missing: 503,
  bad_input: 400,
}

class ParseError extends Error {
  constructor(code, message, extra) {
    super(message)
    this.name = 'ParseError'
    this.code = code
    if (extra) Object.assign(this, extra)
  }

  get httpStatus() {
    return HTTP_STATUS[this.code] || 500
  }
}

const risk = (msg, extra) => new ParseError(CODES.risk, msg, extra)
const business = (msg, extra) => new ParseError(CODES.business, msg, extra)
const network = (msg, extra) => new ParseError(CODES.network, msg, extra)
const identity = (msg, extra) => new ParseError(CODES.identity, msg, extra)
const input = (msg, extra) => new ParseError(CODES.input, msg, extra)

/** 判断 payload 是否风控 */
function isRiskPayload(payload) {
  const code = payload && payload.status_code
  return [8, 2154, 2156, 10000, 10001].indexOf(code) >= 0
}

module.exports = { ParseError, CODES, HTTP_STATUS, risk, business, network, identity, input, isRiskPayload }
