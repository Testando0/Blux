const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const MODEL = 'pixtral-12b-2409';

const FREE_MSGS = 15;
const DAY = 864e5;
const usersPath = path.join(__dirname, 'users.json');

function loadUsers() {
  if (!fs.existsSync(usersPath)) {
    fs.writeFileSync(usersPath, '{}', 'utf8');
  }
  try {
    return JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  } catch {
    fs.writeFileSync(usersPath, '{}', 'utf8');
    return {};
  }
}

function saveUsers(db) {
  const json = JSON.stringify(db, null, 2);
  fs.writeFileSync(usersPath, json, 'utf8');
}

app.post('/api/chat', async (req, res) => {
  const { messages, gender } = req.body || {};
  const userId = String(req.body?.userId || '').trim();

  if (!KEY) return res.status(500).json({ error: 'MISTRAL_API_KEY ausente' });
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages inválido' });
  if (!userId) return res.status(400).json({ error: 'userId obrigatório' });

  const db = loadUsers();
  let u = db[userId] || { free: FREE_MSGS, reset: Date.now(), premium: 0 };

  if (Date.now() - u.reset > DAY) {
    u.free = FREE_MSGS;
    u.reset = Date.now();
  }

  const premium = Date.now() < u.premium;

  if (!premium && u.free <= 0) {
    return res.status(402).json({ error: 'Suas mensagens gratuitas de hoje acabaram.' });
  }

  if (!premium) {
    u.free--;
    db[userId] = u;
    saveUsers(db);
    console.log(`[CHAT] user=${userId} restante=${u.free}`);
  }

  const systemFile = gender === 'M' ? 'system2.txt' : 'system.txt';
  let system = '';
  try {
    system = fs.readFileSync(path.join(__dirname, systemFile), 'utf8').trim();
  } catch {}

  const full = system ? [{ role: 'system', content: system }, ...messages] : messages;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 90000);

  try {
    const r = await fetch(MISTRAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: MODEL, messages: full, temperature: 0.95, max_tokens: 1400, stream: true }),
      signal: ctrl.signal
    });

    clearTimeout(timeout);

    if (!r.ok) {
      const t = await r.text();
      console.error('[MISTRAL] Erro:', r.status, t.slice(0, 300));
      res.write(`data: ${JSON.stringify({ error: 'Erro na IA (' + r.status + ')' })}\n\n`);
      return res.end();
    }

    const reader = r.body.getReader();
    req.on('close', () => reader.cancel().catch(() => {}));

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    clearTimeout(timeout);
    console.error('[MISTRAL] Falha:', e.name === 'AbortError' ? 'TIMEOUT 90s' : e.message);
    res.write(`data: ${JSON.stringify({ error: e.name === 'AbortError' ? 'A IA demorou demais, tenta de novo' : e.message })}\n\n`);
    res.end();
  }
});

app.get('/api/status', (req, res) => {
  const userId = String(req.query.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId obrigatório' });
  const db = loadUsers();
  let u = db[userId] || { free: FREE_MSGS, reset: Date.now(), premium: 0 };
  if (Date.now() - u.reset > DAY) {
    u.free = FREE_MSGS;
    u.reset = Date.now();
    db[userId] = u;
    saveUsers(db);
  }
  res.json({ free: u.free, premium: Date.now() < u.premium });
});

app.post('/api/activate', (req, res) => {
  const { userId, code } = req.body || {};
  const uid = String(userId || '').trim();
  const cod = String(code || '').trim().toUpperCase();
  if (!uid || !cod) return res.status(400).json({ error: 'userId e code obrigatórios' });

  let codes = {};
  try { codes = JSON.parse(fs.readFileSync(path.join(__dirname, 'codigos.json'), 'utf8')); } catch {}

  const cfg = codes[cod];
  if (!cfg) return res.status(404).json({ error: 'Código inválido' });
  if (cfg.usado) return res.status(400).json({ error: 'Código já utilizado' });

  const dias = Number(cfg.dias) || 30;
  const db = loadUsers();
  let u = db[uid] || { free: FREE_MSGS, reset: Date.now(), premium: 0 };
  const base = Math.max(u.premium, Date.now());
  u.premium = base + dias * DAY;
  db[uid] = u;
  saveUsers(db);

  codes[cod].usado = true;
  fs.writeFileSync(path.join(__dirname, 'codigos.json'), JSON.stringify(codes, null, 2), 'utf8');

  console.log(`[PREMIUM] user=${uid} código=${cod} dias=${dias}`);
  res.json({ ok: true, premiumUntil: u.premium });
});

app.listen(PORT, () => {
  console.log(`Blux online na porta ${PORT}`);
});
