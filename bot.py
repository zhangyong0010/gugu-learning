"""Telegram learning bot: Three Kingdoms first, adaptive review by SQLite."""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update, WebAppInfo
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

from knowledge import expansion_questions, seed_questions

ROOT = Path(__file__).parent
DB_PATH = ROOT / "learning.sqlite3"
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
# httpx logs full request URLs, which include Telegram's bot token. Keep request
# diagnostics quiet; application-level events remain available at INFO level.
logging.getLogger("httpx").setLevel(logging.WARNING)


def load_local_env() -> None:
    """Load a tiny local .env without requiring another dependency."""
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def conn() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return db


def now() -> datetime:
    return datetime.now(timezone.utc)


def init_db() -> None:
    with conn() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS questions (
          id INTEGER PRIMARY KEY, domain TEXT NOT NULL, node TEXT NOT NULL, stage TEXT NOT NULL,
          type TEXT NOT NULL, prompt TEXT NOT NULL, answer TEXT NOT NULL, keywords TEXT NOT NULL,
          source TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
          telegram_id INTEGER PRIMARY KEY, display_name TEXT, current_question_id INTEGER,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS progress (
          telegram_id INTEGER NOT NULL, question_id INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
          correct_streak INTEGER NOT NULL DEFAULT 0, mastery REAL NOT NULL DEFAULT 0,
          due_at TEXT, last_result TEXT, PRIMARY KEY (telegram_id, question_id)
        );
        CREATE TABLE IF NOT EXISTS attempts (
          id INTEGER PRIMARY KEY, telegram_id INTEGER NOT NULL, question_id INTEGER NOT NULL,
          answer TEXT NOT NULL, score REAL NOT NULL, created_at TEXT NOT NULL
        );
        """)
        for q in seed_questions():
            db.execute("""INSERT OR IGNORE INTO questions
              (domain,node,stage,type,prompt,answer,keywords,source,created_at)
              VALUES (?,?,?,?,?,?,?,?,?)""", (*[q[k] for k in ("domain", "node", "stage", "type", "prompt", "answer")], json.dumps(q["keywords"], ensure_ascii=False), q["source"], now().isoformat()))


def ensure_user(user_id: int, name: str | None) -> None:
    with conn() as db:
        db.execute("INSERT OR IGNORE INTO users (telegram_id,display_name,created_at) VALUES (?,?,?)", (user_id, name, now().isoformat()))


def choose_question(user_id: int, only_due: bool = False) -> sqlite3.Row | None:
    stamp = now().isoformat()
    with conn() as db:
        due = db.execute("""SELECT q.* FROM questions q JOIN progress p ON p.question_id=q.id
          WHERE p.telegram_id=? AND p.due_at<=? ORDER BY p.due_at LIMIT 1""", (user_id, stamp)).fetchone()
        if due:
            return due
        if only_due:
            return None
        return db.execute("""SELECT q.* FROM questions q LEFT JOIN progress p
          ON q.id=p.question_id AND p.telegram_id=? WHERE q.domain='三国' AND p.question_id IS NULL
          ORDER BY CASE q.stage WHEN '基础' THEN 1 WHEN '中等' THEN 2 ELSE 3 END, q.id LIMIT 1""", (user_id,)).fetchone()


def question_text(q: sqlite3.Row) -> str:
    return f"📚 <b>三国 · {q['stage']}</b>　·　{q['type']}\n🧭 知识节点：{q['node']}\n\n{q['prompt']}\n\n请直接回复你的答案。"


def grade(answer: str, q: sqlite3.Row) -> tuple[float, str, list[str]]:
    normalized = answer.lower().replace(" ", "")
    keys = json.loads(q["keywords"])
    hits = [key for key in keys if key.lower().replace(" ", "") in normalized]
    score = len(hits) / max(1, len(keys))
    if score >= 0.75:
        verdict = "准确"
    elif score >= 0.4:
        verdict = "基本正确"
    else:
        verdict = "偏差较大"
    return score, verdict, hits


def record_attempt(user_id: int, q: sqlite3.Row, answer: str, score: float, verdict: str) -> tuple[int, float]:
    with conn() as db:
        old = db.execute("SELECT * FROM progress WHERE telegram_id=? AND question_id=?", (user_id, q["id"])).fetchone()
        attempts = (old["attempts"] if old else 0) + 1
        streak = (old["correct_streak"] if old and score >= .75 else 0) + 1 if score >= .75 else 0
        mastery = min(1.0, ((old["mastery"] if old else 0) * .55) + score * .45)
        hours = 24 if score < .4 else 72 if score < .75 else (14 * 24 if streak >= 2 else 7 * 24)
        due = (now() + timedelta(hours=hours)).isoformat()
        db.execute("""INSERT INTO progress (telegram_id,question_id,attempts,correct_streak,mastery,due_at,last_result)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(telegram_id,question_id) DO UPDATE SET
          attempts=excluded.attempts,correct_streak=excluded.correct_streak,mastery=excluded.mastery,due_at=excluded.due_at,last_result=excluded.last_result""",
          (user_id, q["id"], attempts, streak, mastery, due, verdict))
        db.execute("INSERT INTO attempts (telegram_id,question_id,answer,score,created_at) VALUES (?,?,?,?,?)", (user_id, q["id"], answer, score, now().isoformat()))
    return streak, mastery


def maybe_expand(user_id: int) -> bool:
    with conn() as db:
        covered = db.execute("SELECT COUNT(*) FROM progress p JOIN questions q ON q.id=p.question_id WHERE p.telegram_id=? AND q.source='initial-100' AND p.mastery>=.75", (user_id,)).fetchone()[0]
        existing = db.execute("SELECT COUNT(*) FROM questions WHERE source='auto-expansion'").fetchone()[0]
        if covered < 80 or existing:
            return False
        for q in expansion_questions():
            db.execute("""INSERT INTO questions (domain,node,stage,type,prompt,answer,keywords,source,created_at)
             VALUES (?,?,?,?,?,?,?,?,?)""", (q['domain'],q['node'],q['stage'],q['type'],q['prompt'],q['answer'],json.dumps(q['keywords'],ensure_ascii=False),q['source'],now().isoformat()))
    return True


async def send_next(update: Update, context: ContextTypes.DEFAULT_TYPE, only_due: bool = False) -> None:
    user = update.effective_user
    if not user:
        return
    q = choose_question(user.id, only_due)
    if not q:
        msg = "🎉 目前没有到期复习题。你已完成首批框架，稍后再来复习。" if only_due else "🎉 你已完成当前题库。系统会在基础节点稳定后自动加入综合题。"
        await update.effective_message.reply_text(msg)
        return
    with conn() as db:
        db.execute("UPDATE users SET current_question_id=? WHERE telegram_id=?", (q["id"], user.id))
    await update.effective_message.reply_html(question_text(q))


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if not user:
        return
    ensure_user(user.id, user.full_name)
    web_app_url = os.getenv("WEB_APP_URL")
    keyboard = None
    if web_app_url:
        keyboard = InlineKeyboardMarkup([[InlineKeyboardButton("🦉 打开 GuGu 学习空间", web_app=WebAppInfo(web_app_url))]])
    await update.message.reply_html(
        "<b>欢迎来到 GuGu 🦉</b>\n\nGuGu 是取自智慧猫头鹰的叫声：帮你把零散知识连成自己的体系。第一站是三国：事件、地缘、制度，以及《三国演义》与正史辨析。\n\n"
        "点击下方进入学习空间，或输入 /practice 直接练习。",
        reply_markup=keyboard,
    )


async def practice(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await send_next(update, context)


async def review(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await send_next(update, context, only_due=True)


async def stats(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if not user:
        return
    with conn() as db:
        total = db.execute("SELECT COUNT(*) FROM questions WHERE source='initial-100'").fetchone()[0]
        row = db.execute("SELECT COUNT(*) AS seen, SUM(CASE WHEN mastery>=.75 THEN 1 ELSE 0 END) AS solid, AVG(mastery) AS avg FROM progress WHERE telegram_id=?", (user.id,)).fetchone()
        due = db.execute("SELECT COUNT(*) FROM progress WHERE telegram_id=? AND due_at<=?", (user.id, now().isoformat())).fetchone()[0]
    await update.message.reply_text(f"📊 三国学习档案\n\n已接触：{row['seen'] or 0}/{total}\n稳定掌握：{row['solid'] or 0}/{total}\n平均掌握度：{round((row['avg'] or 0)*100)}%\n当前待复习：{due} 题\n\n掌握 80 道基础题后，将自动解锁高阶综合题。")


async def map_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text("🧭 三国知识地图\n\n1. 东汉末局：黄巾、董卓、关东联军\n2. 地缘格局：荆州、益州、江东与中原\n3. 关键转折：官渡、赤壁、夷陵\n4. 政权结构：屯田、九品中正制、权臣政治\n5. 三分归晋：北伐、灭蜀、灭吴\n6. 史实与演义：空城计、桃园结义、草船借箭\n\n每一层由基础题进入因果题与综合题。")


async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text("可用命令：\n/practice 开始下一题\n/review 只做今日到期复习\n/stats 查看掌握情况\n/map 查看三国知识地图\n/help 查看帮助\n\n答题时直接回复文字即可。系统会按关键得分点给出纠错和下次复习时间。")


async def answer(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if not user or not update.message or not update.message.text:
        return
    with conn() as db:
        current = db.execute("SELECT current_question_id FROM users WHERE telegram_id=?", (user.id,)).fetchone()
        q = db.execute("SELECT * FROM questions WHERE id=?", (current["current_question_id"],)).fetchone() if current and current["current_question_id"] else None
    if not q:
        await update.message.reply_text("先输入 /practice 获取一道题吧。")
        return
    score, verdict, hits = grade(update.message.text, q)
    streak, mastery = record_attempt(user.id, q, update.message.text, score, verdict)
    expanded = maybe_expand(user.id)
    missing = [k for k in json.loads(q["keywords"]) if k not in hits]
    interval = "1 天" if score < .4 else "3 天" if score < .75 else ("14 天" if streak >= 2 else "7 天")
    text = f"<b>判定：{verdict}</b>（掌握度 {round(mastery*100)}%）\n\n<b>参考答案</b>\n{q['answer']}\n\n<b>得分点</b>\n命中：{'、'.join(hits) or '暂无'}\n待补：{'、'.join(missing) or '无'}\n\n这题将在约 {interval} 后再次出现。"
    if expanded:
        text += "\n\n✨ 你已经稳定掌握 80 道首批题，已自动解锁 20 道高阶综合题。"
    await update.message.reply_html(text)
    with conn() as db:
        db.execute("UPDATE users SET current_question_id=NULL WHERE telegram_id=?", (user.id,))
    await update.message.reply_text("输入 /practice 继续，或 /stats 查看学习档案。")


def main() -> None:
    load_local_env()
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token or token == "replace_me":
        raise SystemExit("请设置 TELEGRAM_BOT_TOKEN 后再运行。参见 .env.example 和 README.md。")
    init_db()
    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("practice", practice))
    app.add_handler(CommandHandler("review", review))
    app.add_handler(CommandHandler("stats", stats))
    app.add_handler(CommandHandler("map", map_cmd))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, answer))
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
