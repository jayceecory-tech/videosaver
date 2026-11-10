# VideoSaver

短视频分享链接 → 视频文件 → 保存到手机相册。

微信小程序 + 自建解析服务（微信云托管），支持从分享链接解析出无水印视频并代理下载。

## 目录结构

```
videosaver/
├── miniprogram/        微信小程序（原生）
│   ├── pages/index     首页：粘贴链接 → 解析 → 下载 → 保存相册
│   ├── pages/history   历史记录
│   ├── utils/          api（云托管调用）、media（下载/保存）、parser（链接提取）
│   └── config.js       云托管环境与域名配置
└── server/             解析服务（Node.js ≥18，零第三方运行时依赖）
    ├── src/douyin.js   抖音详情接口 + 短链解析 + LRU 缓存
    ├── src/identity.js 身份（uifid / ttwid）加载与领取
    ├── src/pool.js     1+1 身份池：主失效自动切备、后台补铸
    ├── src/mint.js     无头浏览器铸造新身份（puppeteer-core + Chromium）
    ├── cloud/server.js 微信云托管入口（PORT 80，/api/parse、/api/video、/api/health）
    └── Dockerfile      云托管镜像（node:18-alpine + chromium）
```

## 服务端

```bash
cd server

# 本地跑（需要环境变量 DOUYIN_UIFID；不配则自动铸造）
DOUYIN_UIFID=<160 字符 uifid> node src/server.js

# 健康检查
curl localhost:8787/health
```

关键接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/parse` | 入参 `{ text \| url }`，返回视频直链（带 token 的代理地址） |
| GET | `/api/video?t=<token>` | 代理下载，支持 Range，补 UA/Referer |
| GET | `/api/health` | 服务与身份池状态（主/备、铸造次数、缓存命中率） |

身份策略：

- 一个出口只挂一个身份，不做请求级轮换（同一出口频繁换访客是风控特征）
- 主身份被风控 → 备用身份转正 + 当前请求自动重试一次 → 后台补铸新备
- 无备可用时 → 本次请求报错，后台铸新主，下次请求可用
- 铸造完必须真机验证通过才入池，失败按 60s→2min→…→30min 退避

## 小程序

```bash
# 用微信开发者工具打开 miniprogram/ 目录
```

`miniprogram/config.js` 需要填：

```js
cloud: {
  env: '<云托管环境 ID>',
  service: 'videosaver',
  publicHost: 'https://<云托管公网域名>',   // 用于 downloadFile
}
```

小程序后台「开发设置 → 服务器域名」需把该公网域名加入 **downloadFile 合法域名**
（解析走 `wx.cloud.callContainer` 私有链路，不需要配 request 域名）。

## 部署

服务端以 Zip 包上传到微信云托管（本地上传 → 端口 80）。
Dockerfile 内置 Chromium，因此镜像约 400MB，构建 3~5 分钟。
建议实例规格 1 核 2GB（铸造峰值内存约 1GB）。

## 分享

- 右上角菜单与结果卡片支持「发送给朋友」「分享到朋友圈」
- 分享卡片带 `share=<链接>` 参数，好友点开自动填入并开始解析
- 朋友圈单页模式（scene 1154）只填链接不自动执行（该模式下保存相册受限）
