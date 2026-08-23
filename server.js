import express from 'express';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
dotenv.config({ path: envPath });

const KEY = (process.env.MISTRAL_API_KEY || '').trim().replace(/^['"]+|['"]+$/g, '');
const MP_ACCESS_TOKEN = (process.env.MP_ACCESS_TOKEN || '').trim();

const app = express();
const MODEL = 'pixtral-12b-2409';
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';

const systemPath = path.join(__dirname, 'system.txt');
const system2Path = path.join(__dirname, 'system2.txt');
const usersPath = path.join(__dirname, 'users.json');

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Banco de Dados Local de Usuários ---
const loadUsers = () => {
  if (!fs.existsSync(usersPath)) fs.writeFileSync(usersPath, '{}', 'utf8');
  try { return JSON.parse(fs.readFileSync(usersPath, 'utf8')); }
  catch { return {}; }
};
const saveUsers = (db) => fs.writeFileSync(usersPath, JSON.stringify(db, null, 2), 'utf8');

const FREE_MESSAGES = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

// --- API de Criação de Pagamento (Checkout Pro) ---
app.post('/api/create-payment', async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId obrigatório' });

  try {
    const pref = {
      items: [
        {
          title: 'Blux Premium - Mensagens Ilimitadas (30 dias)',
          quantity: 1,
          unit_price: 9.90,
          currency_id: 'BRL'
        }
      ],
      external_reference: userId,
      back_urls: {
        success: `${req.protocol}://${req.get('host')}/`,
        failure: `${req.protocol}://${req.get('host')}/`,
        pending: `${req.protocol}://${req.get('host')}/`
      },
      auto_return: 'approved'
    };

    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(pref)
    });

    if (!mpRes.ok) return res.status(500).json({ error: 'Erro no MP', details: await mpRes.text() });
    const data = await mpRes.json();
    res.json({ init_point: data.init_point, id: data.id });
  } catch (e) {
    console.error('Erro ao criar pagamento:', e);
    res.status(500).json({ error: e.message });
  }
});

// --- Webhook do Mercado Pago (Ativação Automática) ---
app.post('/api/webhook', async (req, res) => {
  const topic = req.query.topic || req.body.type;
  const id = req.query.id || req.body.data?.id;

  if (topic === 'payment' || req.body.type === 'payment') {
    try {
      const payRes = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
        headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
      });
      const payment = await payRes.json();

      if (payment.status === 'approved') {
        const userId = payment.external_reference;
        if (userId) {
          const db = loadUsers();
          db[userId] = {
            ...db[userId],
            isPremium: true,
            premiumUntil: Date.now() + (30 * DAY_MS),
            freeMsgsLeft: db[userId]?.freeMsgsLeft || FREE_MESSAGES,
            lastReset: db[userId]?.lastReset || Date.now()
          };
          saveUsers(db);
          console.log(`[MP] Usuário ${userId} atualizado para Premium!`);
        }
      }
    } catch (e) { console.error('Erro no webhook:', e); }
  }
  res.sendStatus(200);
});

// --- Checar Status do Usuário ---
app.get('/api/status', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId obrigatório' });

  const db = loadUsers();
  let user = db[userId] || { freeMsgsLeft: FREE_MESSAGES, lastReset: Date.now(), isPremium: false };
  
  if (Date.now() - user.lastReset > DAY_MS) {
    user.freeMsgsLeft = FREE_MESSAGES;
    user.lastReset = Date.now();
    db[userId] = user;
    saveUsers(db);
  }

  res.json({
    freeMsgsLeft: user.freeMsgsLeft,
    isPremium: user.isPremium && Date.now() < user.premiumUntil,
    premiumUntil: user.premiumUntil
  });
});

// --- API do Chat (CORRIGIDA com timeout e headers enviados apenas após confirmação) ---
app.post('/api/chat', async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'MISTRAL_API_KEY não configurada no .env' });

  const { messages, gender, userId } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages inválido' });
  if (!userId) return res.status(400).json({ error: 'userId obrigatório' });

  const db = loadUsers();
  let user = db[userId];
  if (!user) {
    user = { freeMsgsLeft: FREE_MESSAGES, lastReset: Date.now(), isPremium: false };
    db[userId] = user;
  }

  if (Date.now() - user.lastReset > DAY_MS) {
    user.freeMsgsLeft = FREE_MESSAGES;
    user.lastReset = Date.now();
  }

  const isPremium = user.isPremium && Date.now() < user.premiumUntil;

  if (!isPremium && user.freeMsgsLeft <= 0) {
    return res.status(402).json({ error: 'Limite diário atingido', message: 'Suas mensagens gratuitas acabaram por hoje.' });
  }

  if (!isPremium) {
    user.freeMsgsLeft -= 1;
    db[userId] = user;
    saveUsers(db);
  }

  const isFemale = String(gender || '').toUpperCase() === 'F';
  const promptFile = isFemale ? system2Path : systemPath;
  let system = '';
  try { system = fs.readFileSync(promptFile, 'utf8').trim(); } 
  catch (e) { try { system = fs.readFileSync(systemPath, 'utf8').trim(); } catch {} }

  const full = system ? [{ role: 'system', content: system }, ...messages] : messages;

  try {
    // ⏱️ Timeout de 30s para conectar e receber headers da Mistral
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const r = await fetch(MISTRAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: MODEL, messages: full, temperature: 0.95, max_tokens: 1400, stream: true }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!r.ok) {
      const t = await r.text();
      // Retornamos JSON normal, não SSE, pois ainda não enviamos headers
      return res.status(502).json({ error: 'Mistral: ' + t.slice(0, 180) });
    }

    // ✅ AGORA sim enviamos os headers de stream SSE (após confirmar que a Mistral respondeu OK)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const reader = r.body.getReader();
    req.on('close', () => reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    // Se der erro (ex: timeout), e ainda não enviamos headers, retornamos JSON limpo
    if (!res.headersSent) {
      return res.status(500).json({ error: e.name === 'AbortError' ? 'Timeout: A IA demorou muito' : e.message });
    } else {
      // Se já enviamos headers, mandamos erro via SSE e fechamos
      res.write(`data: ${JSON.stringify({ error: e.name === 'AbortError' ? 'Timeout: A IA demorou muito' : e.message })}\n\n`);
      res.end();
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n  BLUX +18 rodando → http://localhost:' + PORT);
  console.log('  ✓ Sistema de mensagens gratuitas (15/dia) e Mercado Pago ativo');
  if (KEY) console.log('  ✓ Chave da Mistral carregada'); else console.warn('  ⚠ MISTRAL_API_KEY NÃO foi carregada!');
});
