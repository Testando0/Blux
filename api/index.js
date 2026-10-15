import express from 'express';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS para permitir que o frontend chame a API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const MODEL = 'pixtral-12b-2409';

const FREE_MSGS = 15;
const DAY = 864e5;

const tmpDir = '/tmp';
const usersPath = path.join(tmpDir, 'users.json');
const codigosPath = path.join(tmpDir, 'codigos.json');

function loadCodes() {
  if (!fs.existsSync(codigosPath)) {
    try {
      const originalPath = path.join(process.cwd(), 'codigos.json');
      if (fs.existsSync(originalPath)) {
        const data = fs.readFileSync(originalPath, 'utf8');
        fs.writeFileSync(codigosPath, data, 'utf8');
        return JSON.parse(data);
      }
    } catch (e) {}
    fs.writeFileSync(codigosPath, '{}', 'utf8');
    return {};
  }
  try { return JSON.parse(fs.readFileSync(codigosPath, 'utf8')); } 
  catch { return {}; }
}

function saveCodes(db) { fs.writeFileSync(codigosPath, JSON.stringify(db, null, 2), 'utf8'); }
function loadUsers() {
  if (!fs.existsSync(usersPath)) fs.writeFileSync(usersPath, '{}', 'utf8');
  try { return JSON.parse(fs.readFileSync(usersPath, 'utf8')); } 
  catch { return {}; }
}
function saveUsers(db) { fs.writeFileSync(usersPath, JSON.stringify(db, null, 2), 'utf8'); }

app.post('/api/chat', async (req, res) => {
  const { messages, gender } = req.body || {};
  const userId = String(req.body?.userId || '').trim();

  if (!KEY) return res.status(500).json({ error: 'MISTRAL_API_KEY ausente' });
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages inválido' });
  if (!userId) return res.status(400).json({ error: 'userId obrigatório' });

  const db = loadUsers();
  let u = db[userId] || { free: FREE_MSGS, reset: Date.now(), premium: 0 };

  if (Date.now() - u.reset > DAY) { u.free = FREE_MSGS; u.reset = Date.now(); }
  const premium = Date.now() < u.premium;

  if (!premium && u.free <= 0) return res.status(402).json({ error: 'Limite atingido' });

  if (!premium) {
    u.free--;
    db[userId] = u;
    saveUsers(db);
  }

  const systemFile = gender === 'M' ? 'system2.txt' : 'system.txt';
  let system = '';
  try { system = fs.readFileSync(path.join(process.cwd(), systemFile), 'utf8').trim(); } catch {}

  const full = system ? [{ role: 'system', content: system }, ...messages] : messages;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();

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
      res.write(`data: ${JSON.stringify({ error: 'Erro na IA' })}\n\n`);
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
    res.write(`data: ${JSON.stringify({ error: 'Erro de conexão' })}\n\n`);
    res.end();
  }
});

app.get('/api/status', (req, res) => {
  const userId = String(req.query.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId obrigatório' });
  const db = loadUsers();
  let u = db[userId] || { free: FREE_MSGS, reset: Date.now(), premium: 0 };
  if (Date.now() - u.reset > DAY) { u.free = FREE_MSGS; u.reset = Date.now(); db[userId] = u; saveUsers(db); }
  res.json({ free: u.free, premium: Date.now() < u.premium });
});

app.post('/api/activate', (req, res) => {
  const { userId, code } = req.body || {};
  const uid = String(userId || '').trim();
  const cod = String(code || '').trim().toUpperCase();
  if (!uid || !cod) return res.status(400).json({ error: 'Dados inválidos' });

  let codes = loadCodes();
  const cfg = codes[cod];
  if (!cfg || cfg.usado) return res.status(400).json({ error: 'Código inválido ou usado' });

  const dias = Number(cfg.dias) || 30;
  const db = loadUsers();
  let u = db[uid] || { free: FREE_MSGS, reset: Date.now(), premium: 0 };
  u.premium = Math.max(u.premium, Date.now()) + (dias * DAY);
  db[uid] = u;
  saveUsers(db);

  codes[cod].usado = true;
  saveCodes(codes);

  res.json({ ok: true, premiumUntil: u.premium });
});

export default app;
