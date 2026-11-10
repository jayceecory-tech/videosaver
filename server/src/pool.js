/**
 * 身份池：主 + 备（1+1）
 *
 * 设计（对齐 Evil0ctal 项目的三条实测结论）：
 * - 不做请求级轮换：一个身份用到底，**只有被风控才切换**（同一出口频繁换访客比高频更可疑）
 * - 身份与 UA 终身绑定：每个身份记住铸造时的 UA，请求时用它（指纹一致性）
 * - 备份身份是「故障转移」资源，平时不动
 *
 * 流程：
 *   启动：env DOUYIN_UIFID（或 identity.json）为主；无备 → 后台补铸一个备
 *   请求失败（risk_control）→ 主坏：
 *     有备 → 备升主，本次请求立即用新主重试；同时后台铸一个新备
 *     无备 → 触发后台铸新主，本次请求返回「请稍后再试」，下次请求即可用
 *   铸造：互斥 + 验证（真机解析一次）+ 退避（60s 起，上限 30min）
 */
const fs = require('fs')
const path = require('path')

const { mintIdentity } = require('./mint')
const { invalidateTtwid } = require('./identity')

const POOL_FILE = process.env.IDENTITY_POOL_FILE || '/tmp/identity-pool.json'
/** 两次成功铸造的最小间隔（防止连续铸造触发风控；两个身份都缺失时忽略此间隔） */
const MIN_MINT_INTERVAL = Number(process.env.MIN_MINT_INTERVAL || 10 * 60 * 1000)
/** 铸造失败退避 */
const RETRY_BASE = Number(process.env.MINT_RETRY_BASE || 60 * 1000)
const RETRY_MAX = Number(process.env.MINT_RETRY_MAX || 30 * 60 * 1000)

const state = {
  primary: null, // { uifid, ua, mintedAt, source }
  backup: null,
  minting: false,
  nextMintAt: 0,
  promoted: 0, // 备转主次数
  minted: 0, // 成功铸造次数
  lastError: '',
}

let refilling = false
let refillTimer = null

function validIdentity(x) {
  return x && typeof x.uifid === 'string' && x.uifid.length >= 32
}

function persist() {
  try {
    fs.writeFileSync(POOL_FILE, JSON.stringify({ primary: state.primary, backup: state.backup }, null, 2))
  } catch (e) {
    // /tmp 不可写等场景忽略，内存态继续工作
  }
}

/** 初始化：优先池文件，其次环境变量 / identity.json */
function init() {
  try {
    const data = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'))
    if (validIdentity(data.primary)) state.primary = data.primary
    if (validIdentity(data.backup)) state.backup = data.backup
  } catch (e) {
    // 无池文件
  }

  if (!state.primary) {
    // 复用旧的 loadIdentity 逻辑找初始身份
    const legacy = legacyIdentity()
    const uifid = legacy.uifid
    if (uifid) {
      state.primary = {
        uifid,
        ua: legacy.ua || '',
        mintedAt: legacy.mintedAt || Date.now(),
        source: 'env',
      }
    }
  }

  if (!state.backup) scheduleRefill(3000)
  return state
}

function legacyIdentity() {
  if (process.env.DOUYIN_UIFID) {
    return { uifid: process.env.DOUYIN_UIFID, ua: process.env.DOUYIN_UA || '', mintedAt: 0 }
  }
  const candidates = [
    process.env.IDENTITY_FILE,
    path.join(__dirname, '..', 'identity.json'),
    path.join(__dirname, '..', '..', 'videosaver-server-py', 'identity.json'),
  ].filter(Boolean)
  for (const file of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (data && data.uifid) {
        return { uifid: data.uifid, ua: data.ua || '', mintedAt: data.mintedAt || 0 }
      }
      const m = /UIFID_TEMP=([^;\s]{32,})/.exec(data.cookie || '')
      if (m) return { uifid: m[1], ua: data.ua || '', mintedAt: 0 }
    } catch (e) {
      // 下一个
    }
  }
  return {}
}

function getPrimary() {
  return state.primary
}

/**
 * 主身份被风控：
 * @returns {boolean} 是否切换到了备份（true 时调用方应立即用新主重试）
 */
function failover(reason) {
  invalidateTtwid()
  state.lastError = `${new Date().toISOString()} ${String(reason).slice(0, 120)}`

  if (validIdentity(state.backup)) {
    const dead = state.primary
    state.primary = state.backup
    state.backup = null
    state.promoted += 1
    persist()
    console.warn(
      '[pool] 主身份失效，备已转主 uifid=%s…（原 %s…）原因: %s',
      state.primary.uifid.slice(0, 8),
      dead ? dead.uifid.slice(0, 8) : '无',
      String(reason).slice(0, 80)
    )
    scheduleRefill(0) // 立刻补一个新备
    return true
  }

  // 没有备：本次请求只能失败，后台铸新主
  console.warn('[pool] 主身份失效且无备，开始铸造新主：%s', String(reason).slice(0, 80))
  if (state.primary && state.primary.source === 'env') {
    // env 身份死了也标记，避免继续用它
    state.primary.dead = true
  }
  scheduleRefill(0)
  return false
}

function scheduleRefill(delayMs) {
  const at = Date.now() + (delayMs || 0)
  if (refillTimer && state.nextMintAt <= at) return
  if (state.nextMintAt > Date.now() && delayMs !== 0) {
    state.nextMintAt = Math.max(state.nextMintAt, at)
  } else {
    state.nextMintAt = at
  }
  if (refillTimer) clearTimeout(refillTimer)
  refillTimer = setTimeout(refill, Math.max(0, at - Date.now()))
  if (refillTimer.unref) refillTimer.unref()
}

async function refill() {
  if (refilling) return
  if (validIdentity(state.primary) && validIdentity(state.backup)) return // 满编

  const now = Date.now()
  const noIdentity = !validIdentity(state.primary)
  if (!noIdentity && now < state.nextMintAt) {
    scheduleRefill(state.nextMintAt - now)
    return
  }
  // 距上次成功铸造太近时，稍等（主身份还在时不急）
  if (!noIdentity && state.minted > 0 && now - (state.lastMintAt || 0) < MIN_MINT_INTERVAL) {
    const wait = MIN_MINT_INTERVAL - (now - (state.lastMintAt || 0))
    state.nextMintAt = now + wait
    scheduleRefill(wait)
    return
  }

  refilling = true
  state.minting = true
  try {
    const minted = await mintIdentity()
    const verified = await verify(minted)
    if (!verified.ok) throw new Error('新身份验证失败：' + verified.error)

    if (!validIdentity(state.primary) || (state.primary && state.primary.dead)) {
      state.primary = Object.assign({ mintedAt: Date.now(), source: 'minted' }, minted)
      console.warn('[pool] 新主就位 uifid=%s…', minted.uifid.slice(0, 8))
    } else {
      state.backup = Object.assign({ mintedAt: Date.now(), source: 'minted' }, minted)
      console.warn('[pool] 新备就位 uifid=%s…', minted.uifid.slice(0, 8))
    }
    state.minted += 1
    state.lastMintAt = Date.now()
    state.nextMintAt = 0
    state.lastError = ''
    persist()
  } catch (e) {
    state.lastError = `${new Date().toISOString()} ${String(e.message).slice(0, 120)}`
    const backoff = Math.min(RETRY_MAX, RETRY_BASE * Math.pow(2, state.failCount = (state.failCount || 0) + 1))
    state.nextMintAt = Date.now() + backoff
    console.error('[pool] 铸造失败：%s（%d 分钟后重试）', e.message, Math.round(backoff / 60000))
    scheduleRefill(backoff)
  } finally {
    refilling = false
    state.minting = false
  }
}

/** 铸完立即真机验证一次；失败重试一次，再失败视为铸造环境问题 */
async function verify(minted) {
  const { verifyIdentity } = require('./verify')
  let first = await verifyIdentity(minted)
  if (first.ok) return first
  await new Promise(r => setTimeout(r, 3000))
  const second = await verifyIdentity(minted)
  return second.ok ? second : first
}

function status() {
  const brief = x =>
    x && {
      uifid: x.uifid.slice(0, 8) + '…',
      ua: (x.ua || '').slice(0, 24),
      source: x.source,
      ageHours: x.mintedAt ? Math.round(((Date.now() - x.mintedAt) / 3600000) * 10) / 10 : null,
      dead: !!x.dead,
    }
  return {
    primary: brief(state.primary),
    backup: brief(state.backup),
    minting: state.minting,
    nextMintAt: state.nextMintAt || null,
    promoted: state.promoted,
    minted: state.minted,
    lastError: state.lastError,
  }
}

module.exports = { init, getPrimary, failover, status, persist }
