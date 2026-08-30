# GuGu Cloudflare Worker

该 Worker 接替本机 Python 长轮询：Telegram 通过 Webhook 发送更新，Worker 使用 D1 保存学习进度。题库源自项目的 `knowledge.py`，并已内置为 100 道基础题和 20 道高阶综合题。

## 生产环境变量

- `TELEGRAM_BOT_TOKEN`：Cloudflare Secret，绝不写入仓库。
- `SESSION_SECRET`：Cloudflare Secret，用于 Mini App 会话签名。
- `WEBHOOK_SECRET`：Cloudflare Secret，同时用作私密 Webhook 路径与 Telegram 请求头校验值。
- `MINI_APP_URL`：Pages 的正式 HTTPS 地址。
- `ALLOWED_ORIGIN`：与 `MINI_APP_URL` 相同，仅允许该站点调用 API。

## 部署顺序

1. 创建 D1 数据库并把返回的 database id 填入 `wrangler.jsonc`。
2. 执行 `wrangler d1 execute gugu-learning --remote --file=schema.sql`。
3. 写入三个 Secret；不在代码、GitHub 或 Pages 中输入 Token。`WEBHOOK_SECRET` 使用 32 位以上的随机字母、数字、下划线或连字符。
4. 部署 Worker，取得 `workers.dev` 地址。
5. 更新 Pages 的 `webapp/cloudflare-config.js`，写入 Worker 地址（此文件不含 Secret）。
6. 调用 Telegram `setWebhook`，并在 BotFather 将 Mini App 地址改为 Pages 地址。
