import express from 'express';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const MODEL = 'ministral-3b-2512'; // único modelo permitido
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// código de recarga — confere no codigos.json (edição a quente)
app.post('/api/ativar', (req, res) => {
  const { codigo } = req.body || {};
  let lista;
  try {
    const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'codigos.json'), 'utf8'));
    lista = db.codigos || db;
    if (!Array.isArray(lista)) throw 0;
  } catch { return res.status(500).json({ error: 'codigos.json inválido ou ausente' }); }
  const c = lista.find(x => String(x.codigo) === String(codigo ?? '').trim());
  if (!c) return res.status(404).json({ error: 'Código inválido.' });
  res.json({ dias: Math.max(1, +c.dias || 1), nome: c.nome || '' });
});

// chat — system prompt vem do system.txt; chave e modelo ficam só aqui
app.post('/api/chat', async (req, res) => {
  if (!process.env.MISTRAL_API_KEY) return res.status(500).json({ error: 'MISTRAL_API_KEY não configurada no .env' });
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages inválido' });

  let system = '';
  try { system = fs.readFileSync(path.join(__dirname, 'system.txt'), 'utf8').trim(); } catch {}
  const full = system ? [{ role: 'system', content: system }, ...messages] : messages;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  try {
    const r = await fetch(MISTRAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.MISTRAL_API_KEY },
      body: JSON.stringify({ model: MODEL, messages: full, temperature: 0.95, max_tokens: 1400, stream: true })
    });
    if (!r.ok) {
      const t = await r.text();
      res.write(`data: ${JSON.stringify({ error: 'Mistral: ' + t.slice(0, 180) })}\n\n`);
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
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n  BLUX +18 rodando → http://localhost:' + PORT + '  (modelo: ' + MODEL + ')');
  if (!process.env.MISTRAL_API_KEY) console.warn('  ⚠ Defina MISTRAL_API_KEY no .env');
});
