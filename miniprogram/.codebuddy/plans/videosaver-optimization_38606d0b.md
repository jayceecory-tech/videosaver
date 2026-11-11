---
name: videosaver-optimization
overview: 修复历史页绕过广告门槛的漏洞，为云托管公网 API 增加防滥用防护，并清理小程序残留代码，共 4 项改动。
todos:
  - id: ad-gate-shared
    content: 将广告确认弹窗与授权检查下沉到 utils/ad.js 导出 withAdGate，首页改为引用共享实现
    status: completed
  - id: history-ad-gate
    content: 历史页 onSave 与 onCopy 接入 withAdGate 广告门槛，mock 验证未授权弹窗、看完自动执行、取消不执行
    status: completed
  - id: server-guard
    content: 服务端 /api/parse 增加来源校验（x-wx-source）与按 openid 限流，小程序 api.js 增加 rate_limited 与唤醒提示映射
    status: completed
  - id: cold-start-retry
    content: callContainer 超时自动重试一次，验证冷启动场景提示友好
    status: completed
  - id: cleanup-error-field
    content: 清理首页残留 data.error 字段与相关 setData，整页语法与 mock 回归
    status: completed
  - id: release
    content: 提交 GitHub main，cli upload 上传小程序 1.3.0，输出服务端重新打包部署指引
    status: completed
---

## Product Overview
对 VideoSaver 小程序 + 解析服务做一轮「漏洞修复 + 防滥用 + 体验优化」。用户问“还有哪些问题需要优化”，经排查确认 4 个需要代码修复的问题 + 2 个需用户拍板的运维建议。

## Core Features
- **漏洞修复（高优）**：历史页「保存」「复制链接」完全绕过了广告门槛，用户无需看广告即可从历史记录完成保存/复制，破坏变现设计。需将首页的确认弹窗 + 授权检查抽为共享模块，两页统一接入
- **安全防护（高优）**：云托管公网域名上的 `/api/parse` 无任何鉴权与限流，任何人 curl 即可调用，会耗尽身份池（身份铸造一天仅能低频几次，非常宝贵）。需校验请求来源（云托管私有链路注入的 `X-WX-SOURCE` / `X-WX-OPENID` 头）并对单用户限流
- **冷启动体验（中优）**：实例最小副本 0，10~20 秒冷启动与 `requestTimeout: 15000` 冲突，高峰期首个用户大概率超时。解析超时时自动重试一次 + 友好提示“服务正在唤醒”
- **代码清理（低优）**：首页残留的 `data.error` 字段（UI 已移除但 setData 仍在写入）

## 运维建议（不涉及代码，由用户拍板）
- 实例最小副本 0 → 1：彻底消除冷启动（1C2G 常驻费用约 ¥200+/月）
- 提交审核 1.2.x 时若被质疑“保存被广告阻断”，可用“广告拉取失败自动放行”作为合规说明

## Tech Stack
- 小程序：原生（无框架），现有文件结构不动
- 服务端：Node.js 零依赖 HTTP 服务（cloud/server.js + src/server.js 双入口）
- 部署：小程序 cli upload；服务端 zip 上传云托管

## Implementation Approach
1. **广告门槛下沉为共享模块**：把 `withAdGate(action)`（确认弹窗 + `isGranted` 判断）从 `pages/index/index.js` 移入 `utils/ad.js`，导出供两个页面复用。弹窗文案改为“解锁保存与复制链接”。`onSave`（历史页）与 `onCopy`（历史页）在执行前调用 `withAdGate`，内部动作再走 `ensureAdGrant` 兜底（与首页 saveNow 相同的两层结构）
2. **服务端防滥用**：新增中间件式检查函数（src/ 下新文件 `guard.js` 或直接在 server.js 内）：
   - `/api/parse`：要求 `x-wx-source` 头存在（云托管私有链路自动注入，外域 curl 没有）→ 缺失返回 403 `{code:'forbidden'}`
   - 按 `x-wx-openid` 内存限流：每用户每分钟 5 次、每小时 30 次（LRU+时间窗，零依赖实现），超限返回 `{code:'rate_limited'}`
   - `/api/video` 不加头校验（token 本身是服务端签发的一次性凭证，已有保护）
   - `/api/health` 保持开放（供探活）
   - 小程序端 `utils/api.js` 增加 `rate_limited` → 「今日使用已达上限，请明天再试」的错误映射
3. **冷启动重试**：`utils/cloud.js` 的 `callContainer` 在超时/网络错误时自动重试 1 次（间隔 2s）；`utils/api.js` 错误映射增加「服务正在唤醒，请稍候重试」
4. **性能说明**：限流器为 O(1) 内存时间窗（Map + 定期清理），单实例内存占用可忽略；广告门槛下沉是纯重构，无行为变化（首页）

## Key Code Structures

```js
// utils/ad.js 新增导出（从 index.js 迁移）
function withAdGate(action) // 已授权 → 直接 action()；否则 showModal 确认 → action()

// server 新增（cloud/server.js 与 src/server.js 共用逻辑）
// checkSource(req): 校验 x-wx-source，缺失 → 403
// rateLimit(openid): 时间窗计数，超限 → 429
```

## Implementation Notes
- 历史页 `onSave` 失败后的状态恢复已有 `savingId` 机制，接入门槛后保持不动
- 服务端改动需重新打包 zip 并上传云托管（构建约 3~5 分钟），与小程序上传分开发布
- 全部完成后：commit + push main（已配置 SSH）+ `cli upload` 小程序新版本 1.3.0
