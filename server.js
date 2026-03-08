import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { getAllSettings, updateSettings, upsertSession, saveMessage, getSessionMessages, getHistory, getSessionDetail, updateDailyStats, getStats } from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
let ADMIN_HASH = '';
(async () => { ADMIN_HASH = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'Wang123400', 10); })();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '未授權' });
  try { req.admin = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token 無效或已過期' }); }
}

app.post('/api/opening', async (req, res) => {
  const { session_id, message } = req.body;
  if (!session_id || !message) return res.status(400).json({ error: '缺少參數' });
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '';
  try {
    await upsertSession(session_id, ip);
    await saveMessage(session_id, 'assistant', message);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/config', async (req, res) => {
  try {
    const s = await getAllSettings();
    res.json({ site_name: s.site_name, badge: s.badge, intro_title: s.intro_title, intro_body: s.intro_body, footer_text: s.footer_text, opening_messages: s.opening_messages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chat', async (req, res) => {
  const { message, session_id } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: '訊息不能為空' });
  const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
  const apiKey = CLAUDE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: '伺服器未設定 CLAUDE_API_KEY' });
  let settings;
  try { settings = await getAllSettings(); } catch (e) { return res.status(500).json({ error: e.message }); }
  const sid = session_id || randomUUID();
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '';
  try { await upsertSession(sid, ip); await saveMessage(sid, 'user', message.trim()); await updateDailyStats({ userMessages: 1 }); } catch (e) { console.error(e.message); }
  let history = [];
  try { history = await getSessionMessages(sid, 40); } catch (e) { console.error(e.message); }
  const apiMessages = history.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content }));
  // 確保最後一筆是 user 訊息
while (apiMessages.length > 0 && apiMessages[apiMessages.length - 1].role !== 'user') {
  apiMessages.pop();
}
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Session-Id', sid);
  let fullText = '', inputTokens = 0, outputTokens = 0;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: settings.model || 'claude-opus-4-6', max_tokens: parseInt(settings.max_tokens) || 1024, system: settings.system_prompt, messages: apiMessages, stream: true }),
    });
    if (!claudeRes.ok) { const err = await claudeRes.json(); res.write(`data: ${JSON.stringify({ error: err.error?.message || 'Claude API 錯誤' })}\n\n`); return res.end(); }
    for await (const chunk of claudeRes.body) {
      const lines = Buffer.from(chunk).toString('utf-8').split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const parsed = JSON.parse(raw);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) { fullText += parsed.delta.text; res.write(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`); }
          if (parsed.type === 'message_start') inputTokens = parsed.message?.usage?.input_tokens || 0;
          if (parsed.type === 'message_delta') outputTokens = parsed.usage?.output_tokens || 0;
        } catch {}
      }
    }
    try { await saveMessage(sid, 'assistant', fullText, inputTokens + outputTokens); await updateDailyStats({ aiMessages: 1, tokens: inputTokens + outputTokens }); } catch (e) { console.error(e.message); }
    res.write(`data: ${JSON.stringify({ done: true, session_id: sid })}\n\n`);
    res.end();
  } catch (e) { if (!res.headersSent) return res.status(500).json({ error: e.message }); res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); res.end(); }
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USERNAME) return res.status(401).json({ error: '帳號或密碼錯誤' });
  const valid = await bcrypt.compare(password, ADMIN_HASH);
  if (!valid) return res.status(401).json({ error: '帳號或密碼錯誤' });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, expiresIn: 28800 });
});

app.get('/api/admin/settings', auth, async (req, res) => { try { res.json(await getAllSettings()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/admin/settings', auth, async (req, res) => { try { await updateSettings(req.body); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/admin/history', auth, async (req, res) => { try { res.json(await getHistory({ page: parseInt(req.query.page) || 1, pageSize: 20 })); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/admin/history/:sessionId', auth, async (req, res) => { try { res.json(await getSessionDetail(req.params.sessionId)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/download-log', async (req, res) => {
  try {
    await updateDailyStats({ downloads: 1 });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/stats', auth, async (req, res) => { try { res.json(await getStats()); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
createServer(app).listen(PORT, '0.0.0.0', () => { console.log(`\n✦ AI Portal 啟動：http://localhost:${PORT}\n`); });