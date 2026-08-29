# GuGu Telegram 学习 Bot

一个以“知识图谱 + 自适应复习”为核心的个人学习 Bot。当前版本已实现三国历史与《三国演义》方向的第一期内容。

GuGu 取自智慧猫头鹰的叫声。聊天 Bot 负责练习与提醒；`webapp/` 是其 Telegram Mini App 视觉界面。

## 已实现

- 首批 100 道三国题：25 个知识节点 × 短答、背景、因果、知识连接四类题型。
- 基础／中等／高阶标签，以及事件、地缘、制度、人物战略、史实与演义辨析等分类。
- SQLite 保存用户掌握度、连续答对次数、作答记录和下次复习时间；不会把全部历史记录放进对话上下文。
- 答案按关键得分点评分，返回判定、参考答案、命中点与待补点。
- 间隔复习：偏差较大约 1 天后复习，基本正确约 3 天，准确约 7 天，连续准确约 14 天。
- 80 道首批题稳定掌握后，自动加入 20 道高阶综合比较题。

## 运行

1. 在 Telegram 的 [@BotFather](https://t.me/BotFather) 创建 Bot 并取得 token。
2. 安装依赖：`python3 -m pip install -r requirements.txt`
3. 设置环境变量：`export TELEGRAM_BOT_TOKEN='你的 token'`
4. 运行：`python3 bot.py`

不要把 token 提交到仓库。可以复制 `.env.example` 到本地私密的 `.env` 作为记录，但当前程序只读取环境变量。

## 启用 Telegram Mini App

Mini App 必须部署到可公开访问的 **HTTPS** 地址（Telegram 无法打开 localhost）。部署 `webapp/` 后，在 `.env` 添加：

```text
WEB_APP_URL=https://你的域名.example
```

重启 Bot，再向它发送 `/start`，即可出现“打开 GuGu 学习空间”按钮。开发预览可运行 `python3 -m http.server 4173 -d webapp`，然后访问 `http://127.0.0.1:4173`。

## Bot 命令

- `/start` 初始化学习档案
- `/practice` 获取下一题（优先到期复习）
- `/review` 只查看到期复习
- `/stats` 查看掌握度
- `/map` 查看三国知识地图

## 下一轮调整建议

当前关键词评分可稳定运行，但对长篇自由回答仍偏保守。下一步适合增加可选的 LLM 语义评分，以及题库后台／人工审核流程；然后沿相同结构加入 AI 框架、AI 术语和中国宏观历史。
