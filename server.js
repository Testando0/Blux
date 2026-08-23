import express from 'express';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const KEY = (process.env.MISTRAL_API_KEY || '').trim();
const MP_TOKEN = (process.env.MP_ACCESS_TOKEN || '').trim();
const MODEL = 'pixtral-12b-2409';
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const FREE_MSGS = 15;
const DAY = 864e5;
const INACTIVITY_MS = 30000;

const systemPath = path.join(__dirname, 'system.txt');
const system2Path = path.join(__dirname, 'system2.txt');
const usersPath = path.join(__dirname, 'users.json');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function loadUsers() {
  try {
    if (!fs.existsSync(usersPath)) fs.writeFileSync(usersPath, '{}', 'utf8');
    return JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  } catch { return {}; }
}
function saveUsers(d) {
  try { fs.writeFileSync(usersPath, JSON.stringify(d, null, 2), 'utf8'); }
  catch (e) { console.error('[saveUsers]', e.message); }
}

app.get('/api/status', (req, res) => {
  const userId = String(req.query.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId' });
  const db = loadUsers();
  let u = db[userId] || { free: FREE_MSGS, reset: Date.now(), premium: 0 };
  if (Date.now() - u.reset > DAY) {
    u.free = FREE_MSGS; u.reset = Date.now();
    db[userId] = u; saveUsers(db);
  }
  res.json({ free: u.free, premium: Date.now() < u.premium });
});

app.post('/api/pay', async (req, res) => {
  const userId = String(req.body?.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId' });
  try {
    const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ title: 'Blux Premium 30 dias', quantity: 1, unit_price: 9.9, currency_id: 'BRL' }],
        external_reference: userId,
        back_urls: {
          success: `${req.protocol}://${req.get('host')}/`,
          failure: `${req.protocol}://${req.get('host')}/`,
          pending: `${req.protocol}://${req.get('host')}/`
        },
        auto_return: 'approved'
      })
    });
    const d = await r.json();
    if (!r.ok) return res.status(500).json({ error: d.message || 'Erro MP' });
    res.json({ url: d.init_point });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/webhook', async (req, res) => {
  const id = req.query.id || req.body?.data?.id;
  if (id) {
    try {
      const r = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
        headers: { Authorization: `Bearer ${MP_TOKEN}` }
      });
      const p = await r.json();
      if (p.status === 'approved' && p.external_reference) {
        const db = loadUsers();
        const u = db[p.external_reference] || { free: FREE_MSGS, reset: Date.now(), premium: 0 };
        u.premium = Date.now() + 30 * DAY;
        db[p.external_reference] = u;
        saveUsers(db);
        console.log('[MP] Premium ativado:', p.external_reference);
      }
    } catch (e) { console.error('[MP]', e.message); }
  }
  res.sendStatus(200);
});

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

  if (!premium && u.free <= 0) {
    return res.status(402).json({ error: 'Suas mensagens gratuitas de hoje acabaram.' });
  }
  if (!premium) {
    u.free--;
    db[userId] = u;
    saveUsers(db);
  }

  const isF = String(gender || '').toUpperCase() === 'F';
  let system = '';
  try { system = fs.readFileSync(isF ? system2Path : systemPath, 'utf8').trim(); } catch {
    try { system = fs.readFileSync(systemPath, 'utf8').trim(); } catch {}
  }
  const full = system ? [{ role: 'system', content: system }, ...messages] : messages;

  const ctrl = new AbortController();
  let lastActivity = Date.now();

  const inactivityWatch = setInterval(() => {
    if (Date.now() - lastActivity > INACTIVITY_MS) {
      console.log('[CHAT] Inatividade detectada, abortando stream');
      ctrl.abort();
      clearInterval(inactivityWatch);
    }
  }, 3000);

  const connectTimer = setTimeout(() => ctrl.abort(), 15000);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  req.on('close', () => {
    clearInterval(inactivityWatch);
    clearTimeout(connectTimer);
    ctrl.abort();
  });

  try {
    const r = await fetch(MISTRAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: MODEL, messages: full, temperature: 0.95, max_tokens: 1400, stream: true }),
      signal: ctrl.signal
    });
    clearTimeout(connectTimer);

    if (!r.ok) {
      clearInterval(inactivityWatch);
      const t = await r.text();
      res.write(`data: ${JSON.stringify({ error: 'Mistral: ' + t.slice(0, 200) })}\n\n`);
      return res.end();
    }

    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastActivity = Date.now();
      res.write(Buffer.from(value));
    }
    clearInterval(inactivityWatch);
    res.end();
  } catch (e) {
    clearInterval(inactivityWatch);
    clearTimeout(connectTimer);
    const msg = e.name === 'AbortError' ? 'A IA demorou demais. Tenta de novo.' : e.message;
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
      res.end();
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n  BLUX +18 → http://localhost:' + PORT);
  console.log('  ✓ Mistral:', KEY ? 'OK' : 'AUSENTE');
  console.log('  ✓ Mercado Pago:', MP_TOKEN ? 'OK' : 'AUSENTE');
  console.log('  ✓ Mensagens grátis/dia:', FREE_MSGS, '\n');
});
