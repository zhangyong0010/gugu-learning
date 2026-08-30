import { QUESTIONS, EXPANSION } from './question-bank.js';

const encoder = new TextEncoder();
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const now = () => new Date().toISOString();
const clean = (value = '') => value.toLowerCase().replaceAll(' ', '');
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const bytes = (value) => { const base64 = value.replaceAll('-', '+').replaceAll('_', '/'); return Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), c => c.charCodeAt(0)); };

async function hmac(key, data) {
  const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data)));
}
async function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0; for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i]; return result === 0;
}
function cors(request, env) {
  const origin = request.headers.get('Origin');
  return origin && origin === env.ALLOWED_ORIGIN ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } : {};
}
function escapeHtml(text) { return String(text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]); }

async function validateInitData(initData, env) {
  const params = new URLSearchParams(initData), hash = params.get('hash');
  if (!hash) throw new Error('缺少 Telegram 签名');
  params.delete('hash');
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) throw new Error('Telegram 授权已过期');
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const webAppKey = await hmac('WebAppData', env.TELEGRAM_BOT_TOKEN);
  const key = await crypto.subtle.importKey('raw', webAppKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(check)));
  if (!await safeEqual(expected, bytes(hash))) throw new Error('Telegram 签名校验失败');
  const user = JSON.parse(params.get('user') || '{}');
  if (!user.id) throw new Error('缺少 Telegram 用户');
  return user;
}
async function sessionFor(user, env) {
  const payload = b64url(encoder.encode(JSON.stringify({ id: String(user.id), exp: Date.now() + 86400000 })));
  return `${payload}.${b64url(await hmac(env.SESSION_SECRET, payload))}`;
}
async function requireSession(request, env) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('未登录');
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !await safeEqual(await hmac(env.SESSION_SECRET, payload), bytes(signature))) throw new Error('会话无效');
  const data = JSON.parse(new TextDecoder().decode(bytes(payload)));
  if (!data.id || data.exp < Date.now()) throw new Error('会话已过期');
  return data.id;
}
async function ensureUser(db, user) {
  await db.prepare('INSERT INTO users (telegram_id, display_name, created_at) VALUES (?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET display_name=excluded.display_name').bind(String(user.id), user.first_name || user.username || 'GuGu 学习者', now()).run();
}
async function progressRows(db, userId) { return (await db.prepare('SELECT * FROM progress WHERE telegram_id=?').bind(String(userId)).all()).results || []; }
async function chooseQuestion(db, userId, onlyDue = false) {
  const records = await progressRows(db, userId), map = new Map(records.map(r => [r.question_id, r]));
  const due = QUESTIONS.find(q => map.get(q.id)?.due_at && map.get(q.id).due_at <= now());
  if (due) return due;
  if (onlyDue) return null;
  const mastered = records.filter(r => r.question_id.startsWith('base-') && r.mastery >= .75).length;
  const set = mastered >= 80 ? [...QUESTIONS, ...EXPANSION] : QUESTIONS;
  return set.find(q => !map.has(q.id)) || null;
}
function grade(answer, question) {
  const value = clean(answer), hits = question.keywords.filter(k => value.includes(clean(k))), score = hits.length / Math.max(1, question.keywords.length);
  return { score, hits, verdict: score >= .75 ? '准确' : score >= .4 ? '基本正确' : '偏差较大' };
}
async function record(db, userId, question, answer, result) {
  const previous = await db.prepare('SELECT * FROM progress WHERE telegram_id=? AND question_id=?').bind(String(userId), question.id).first();
  const attempts = (previous?.attempts || 0) + 1, streak = result.score >= .75 ? (previous?.correct_streak || 0) + 1 : 0;
  const mastery = Math.min(1, (previous?.mastery || 0) * .55 + result.score * .45);
  const hours = result.score < .4 ? 24 : result.score < .75 ? 72 : streak >= 2 ? 336 : 168;
  const dueAt = new Date(Date.now() + hours * 3600000).toISOString();
  await db.batch([
    db.prepare('INSERT INTO progress (telegram_id,question_id,attempts,correct_streak,mastery,due_at,last_result) VALUES (?,?,?,?,?,?,?) ON CONFLICT(telegram_id,question_id) DO UPDATE SET attempts=excluded.attempts,correct_streak=excluded.correct_streak,mastery=excluded.mastery,due_at=excluded.due_at,last_result=excluded.last_result').bind(String(userId), question.id, attempts, streak, mastery, dueAt, result.verdict),
    db.prepare('INSERT INTO attempts (telegram_id,question_id,answer,score,created_at) VALUES (?,?,?,?,?)').bind(String(userId), question.id, answer.slice(0, 2000), result.score, now()),
    db.prepare('UPDATE users SET current_question_id=NULL WHERE telegram_id=?').bind(String(userId))
  ]);
  return { mastery, streak, hours };
}
async function telegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Telegram API ${response.status}`);
  return response.json();
}
async function ensureTelegramDelivery(env, workerOrigin) {
  const webhookUrl = `${workerOrigin}/telegram`;
  const commands = [
    { command: 'start', description: '打开 GuGu 学习空间' },
    { command: 'practice', description: '开始下一题' },
    { command: 'review', description: '复习到期题目' },
    { command: 'stats', description: '查看学习档案' },
    { command: 'map', description: '查看知识地图' },
    { command: 'help', description: '查看帮助' }
  ];
  await Promise.all([
    telegram(env, 'setWebhook', { url: webhookUrl, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message'], drop_pending_updates: false }),
    telegram(env, 'setMyCommands', { commands }),
    telegram(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: '开始学习 🦉', web_app: { url: env.MINI_APP_URL } } })
  ]);
}
const questionText = q => `📚 <b>三国 · ${escapeHtml(q.stage)}</b>　·　${escapeHtml(q.type)}\n🧭 知识节点：${escapeHtml(q.node)}\n\n${escapeHtml(q.prompt)}\n\n请直接回复你的答案。`;
async function reply(env, chatId, text, extra = {}) { return telegram(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra }); }
async function botUpdate(update, env) {
  const message = update.message; if (!message?.text || !message.from) return;
  const user = message.from, text = message.text.trim(), command = text.split(/\s/)[0].replace(/@[^\s]+/, '');
  await ensureUser(env.DB, user);
  if (command === '/start') return reply(env, message.chat.id, '<b>欢迎来到 GuGu 🦉</b>\n\nGuGu 帮你把零散知识连成自己的体系。第一站是三国。', { reply_markup: { inline_keyboard: [[{ text: '🦉 打开 GuGu 学习空间', web_app: { url: env.MINI_APP_URL } }]] } });
  if (command === '/practice' || command === '/review') { const q = await chooseQuestion(env.DB, user.id, command === '/review'); if (!q) return reply(env, message.chat.id, command === '/review' ? '🎉 目前没有到期复习题。' : '🎉 当前题库已完成，请稍后复习。'); await env.DB.prepare('UPDATE users SET current_question_id=? WHERE telegram_id=?').bind(q.id, String(user.id)).run(); return reply(env, message.chat.id, questionText(q)); }
  if (command === '/stats') { const rows = await progressRows(env.DB, user.id), solid = rows.filter(r => r.mastery >= .75).length, due = rows.filter(r => r.due_at && r.due_at <= now()).length, avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.mastery, 0) / rows.length * 100) : 0; return reply(env, message.chat.id, `📊 三国学习档案\n\n已接触：${rows.length}/100\n稳定掌握：${solid}/100\n平均掌握度：${avg}%\n当前待复习：${due} 题`); }
  if (command === '/map') return reply(env, message.chat.id, '🧭 三国知识地图\n\n1. 东汉末局\n2. 地缘格局\n3. 关键转折\n4. 政权结构\n5. 三分归晋\n6. 史实与演义');
  if (command === '/help') return reply(env, message.chat.id, '可用命令：\n/practice 开始下一题\n/review 复习到期题目\n/stats 查看学习档案\n/map 查看知识地图');
  const current = await env.DB.prepare('SELECT current_question_id FROM users WHERE telegram_id=?').bind(String(user.id)).first(), question = QUESTIONS.find(q => q.id === current?.current_question_id) || EXPANSION.find(q => q.id === current?.current_question_id);
  if (!question) return reply(env, message.chat.id, '先输入 /practice 获取一道题吧。');
  const result = grade(text, question), saved = await record(env.DB, user.id, question, text, result), missing = question.keywords.filter(k => !result.hits.includes(k));
  return reply(env, message.chat.id, `<b>判定：${result.verdict}</b>（掌握度 ${Math.round(saved.mastery * 100)}%）\n\n<b>参考答案</b>\n${escapeHtml(question.answer)}\n\n<b>得分点</b>\n命中：${escapeHtml(result.hits.join('、') || '暂无')}\n待补：${escapeHtml(missing.join('、') || '无')}\n\n这题将在约 ${saved.hours / 24} 天后再次出现。`);
}
async function api(request, env, url, headers) {
  if (url.pathname === '/api/health') return json({ ok: true, service: 'gugu-api' }, 200, headers);
  if (url.pathname === '/api/session' && request.method === 'POST') { const { initData } = await request.json(); const user = await validateInitData(initData, env); await ensureUser(env.DB, user); try { await ensureTelegramDelivery(env, url.origin); } catch (error) { console.error(`Telegram setup: ${error?.message || 'failed'}`); } return json({ token: await sessionFor(user, env), user: { id: user.id, name: user.first_name || user.username || 'GuGu 学习者' } }, 200, headers); }
  const userId = await requireSession(request, env);
  if (url.pathname === '/api/state' && request.method === 'GET') {
    const row = await env.DB.prepare('SELECT state_json, updated_at FROM mini_app_state WHERE telegram_id=?').bind(userId).first();
    return json({ state: row ? JSON.parse(row.state_json) : null, updatedAt: row?.updated_at || null }, 200, headers);
  }
  if (url.pathname === '/api/state' && request.method === 'POST') {
    const { state } = await request.json();
    const encoded = JSON.stringify(state);
    if (!state || typeof state !== 'object' || encoded.length > 100000) return json({ error: 'invalid_state' }, 400, headers);
    await env.DB.prepare('INSERT INTO mini_app_state (telegram_id,state_json,updated_at) VALUES (?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at').bind(userId, encoded, now()).run();
    return json({ ok: true }, 200, headers);
  }
  if (url.pathname === '/api/progress' && request.method === 'GET') { const rows = await progressRows(env.DB, userId); return json({ seen: rows.length, mastered: rows.filter(r => r.mastery >= .75).length, due: rows.filter(r => r.due_at && r.due_at <= now()).length }, 200, headers); }
  return json({ error: 'not_found' }, 404, headers);
}
export default { async fetch(request, env) { const url = new URL(request.url), headers = cors(request, env); if (request.method === 'OPTIONS') return new Response(null, { headers }); try { if (request.method === 'POST' && url.pathname === '/telegram') { if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 }); await botUpdate(await request.json(), env); return new Response('ok'); } if (url.pathname.startsWith('/api/')) return await api(request, env, url, headers); return json({ error: 'not_found' }, 404, headers); } catch (error) { console.error(error?.message || 'request failed'); return json({ error: 'request_failed' }, 400, headers); } } };
