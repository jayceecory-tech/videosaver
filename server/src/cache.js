/**
 * 解析结果缓存（LRU + TTL）
 *
 * 这是最有效的「降频」手段：同一个视频被多人请求时只真正解析一次。
 * TTL 不宜太长——抖音下发的直链带签名，过期后下载会 403，默认 30 分钟。
 */
const DEFAULT_TTL = Number(process.env.CACHE_TTL_MS || 30 * 60 * 1000)
const DEFAULT_MAX = Number(process.env.CACHE_MAX || 500)

class TTLCache {
  constructor({ max = DEFAULT_MAX, ttl = DEFAULT_TTL } = {}) {
    this.max = max
    this.ttl = ttl
    this.map = new Map()
    this.hits = 0
    this.misses = 0
  }

  get(key) {
    const item = this.map.get(key)
    if (!item) {
      this.misses += 1
      return null
    }
    if (item.expire < Date.now()) {
      this.map.delete(key)
      this.misses += 1
      return null
    }
    // LRU：命中后移到队尾
    this.map.delete(key)
    this.map.set(key, item)
    this.hits += 1
    return item.value
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { value, expire: Date.now() + this.ttl })
    while (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value)
    }
  }

  get stats() {
    const total = this.hits + this.misses
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? Number((this.hits / total).toFixed(3)) : 0,
    }
  }
}

module.exports = { TTLCache }
