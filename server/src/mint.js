/**
 * 身份铸造：用无头浏览器打开抖音首页，领取访客身份（UIFID_TEMP cookie）
 *
 * 实测结论（2026-11-04）：
 * - 桌面 UA 能铸出 uifid；移动端 UA 页面不下发 UIFID_TEMP，铸不出来
 * - uifid 前 32 位由 UA 的 OS 部分派生（Mac/Win/Linux 三个"设备"），后半段每次不同
 * - 短时间连续铸造 + 立即使用会触发风控 → 铸完由调用方验证，且铸造有最小间隔
 */
const fs = require('fs')

/** 桌面 UA 变体：铸造出的身份会绑定其中一个（指纹一致性） */
const UA_VARIANTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
]

const UIFID_NAMES = ['UIFID_TEMP', 'uifid_temp', 'uifid', 'UIFID']
const MINT_TIMEOUT = Number(process.env.MINT_TIMEOUT || 30000)

let puppeteer = null
let puppeteerTried = false

function loadPuppeteer() {
  if (puppeteerTried) return puppeteer
  puppeteerTried = true
  // 优先用容器内安装的 puppeteer-core；本机开发时退回全局 puppeteer
  for (const name of ['puppeteer-core', process.env.PUPPETEER_PATH, '/usr/local/lib/node_modules/puppeteer']) {
    if (!name) continue
    try {
      puppeteer = require(name)
      return puppeteer
    } catch (e) {
      // 试下一个
    }
  }
  return null
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const candidates = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  for (const p of candidates) {
    try {
      fs.accessSync(p)
      return p
    } catch (e) {
      // 下一个
    }
  }
  return ''
}

/**
 * 铸造一个新身份
 * @returns {Promise<{uifid:string, ua:string}>}
 */
async function mintIdentity() {
  const driver = loadPuppeteer()
  if (!driver) throw new Error('未安装 puppeteer（容器内由 Dockerfile 安装 chromium + puppeteer-core）')

  const executablePath = findChrome()
  if (!executablePath) throw new Error('找不到 Chrome/Chromium 可执行文件（可设 CHROME_PATH）')

  const ua = UA_VARIANTS[Math.floor(Math.random() * UA_VARIANTS.length)]
  const browser = await driver.launch({
    executablePath,
    headless: true,
    timeout: MINT_TIMEOUT,
    // 容器内（1 核 alpine）Chromium 启动较慢，放宽 CDP 协议超时
    protocolTimeout: Number(process.env.CDP_TIMEOUT || 90000),
    // 容器里便于把 chromium 自身的 stderr 打到服务日志
    dumpio: !!process.env.MINT_DEBUG,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-zygote',
      '--renderer-process-limit=1',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-blink-features=AutomationControlled',
    ],
  })

  try {
    const page = await browser.newPage()
    await page.setUserAgent(ua)
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: MINT_TIMEOUT })

    const started = Date.now()
    while (Date.now() - started < MINT_TIMEOUT) {
      const cookies = await page.cookies()
      const hit = cookies.find(c => UIFID_NAMES.indexOf(c.name) >= 0 && c.value && c.value.length >= 32)
      if (hit) return { uifid: hit.value, ua }
      await new Promise(r => setTimeout(r, 700))
    }
    throw new Error(`铸造超时（${MINT_TIMEOUT}ms 内未收到 UIFID）`)
  } finally {
    try {
      await browser.close()
    } catch (e) {
      // ignore
    }
  }
}

module.exports = { mintIdentity, UA_VARIANTS }
