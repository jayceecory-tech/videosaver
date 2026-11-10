/**
 * 一次性生成 identity.json（本机工具，不属于服务运行路径）
 *
 * 抖音的 uifid 由页面里的 secsdk JS 生成，纯 HTTP 拿不到，所以需要真实浏览器跑一次；
 * 生成后服务侧长期复用，直到身份过期（/health 的 identityReady 变 false）再跑一次。
 *
 * 用法（本机）：
 *   npm install            # puppeteer 在 devDependencies
 *   node tools/refresh-identity.js
 *
 * 系统已有 Chrome、不想下载 Chromium 时：
 *   CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node tools/refresh-identity.js
 */
const fs = require('fs')
const path = require('path')

const OUT = process.env.IDENTITY_FILE || path.join(__dirname, '..', 'identity.json')
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

async function main() {
  let puppeteer
  try {
    puppeteer = require('puppeteer')
  } catch (e) {
    console.error('未安装 puppeteer，请先在服务端目录执行：npm install')
    process.exit(1)
  }

  const opts = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  }
  if (process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH

  const browser = await puppeteer.launch(opts)
  try {
    const page = await browser.newPage()
    await page.setUserAgent(UA)
    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await new Promise(r => setTimeout(r, 8000))
    const cookies = await page.cookies()
    const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ')
    fs.writeFileSync(OUT, JSON.stringify({ ua: UA, cookie, updated_at: Math.floor(Date.now() / 1000) }, null, 2))
    console.log('已写入:', OUT)
    console.log('cookie 长度:', cookie.length)
    console.log('关键 cookie:', cookies.filter(c => /uifid|ttwid|odin/i.test(c.name)).map(c => c.name).join(', ') || '(无)')
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch(e => {
  console.error(e && e.stack)
  process.exit(1)
})
