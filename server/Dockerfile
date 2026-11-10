FROM node:18-alpine

# Chromium 供 puppeteer-core 在身份失效时自动铸造新身份使用
RUN apk add --no-cache chromium

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

# 云托管只支持一个监听端口，默认 80（可用环境变量 PORT 覆盖）
ENV PORT=80
ENV CHROME_PATH=/usr/bin/chromium-browser
EXPOSE 80

CMD ["node", "cloud/server.js"]
