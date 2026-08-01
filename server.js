import express from 'express';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// carrega o .env que fica AO LADO do server.js (não importa de onde você roda o npm start)
const envPath = path.join(__dirname, '.env');
dotenv.config({ path: envPath });

// limpa aspas/espaços caso tenham escapado na hora de editar
const KEY = (process.env.MISTRAL_API_KEY || '').trim().replace(/^['"]+|['"]+$/g, '');

const app = express();
const MODEL = 'ministral-8b-latest';
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// código de recarga
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

// chat
app.post('/api/chat', async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'MISTRAL_API_KEY não configurada no .env' });
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
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
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
  if (KEY) {
    console.log('  ✓ Chave da Mistral carregada (' + KEY.slice(0, 6) + '...)\n');
    return;
  }
  console.warn('\n  ⚠ MISTRAL_API_KEY NÃO foi carregada!');
  if (!fs.existsSync(envPath)) {
    console.warn('  → O arquivo .env NÃO existe aqui: ' + envPath);
    console.warn('    Ele precisa ficar na MESMA pasta do server.js (não dentro de public/).');
    console.warn('    Nome exato: .env  (começa com ponto — "env" ou ".env.txt" não servem)');
  } else {
    const raw = fs.readFileSync(envPath, 'utf8');
    const temBom = raw.charCodeAt(0) === 0xFEFF;
    const linhas = raw.replace(/^\uFEFF/, '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const chaves = linhas.map(l => l.split('=')[0].trim());
    console.warn('  → O .env existe aqui: ' + envPath);
    console.warn('    Chaves lidas nele: ' + (chaves.join(', ') || '(nenhuma)'));
    if (temBom) console.warn('    → Arquivo com BOM (salvo pelo Notepad). Recrie o arquivo ou salve como "UTF-8 sem BOM".');
    if (!chaves.includes('MISTRAL_API_KEY')) console.warn('    → Falta a linha: MISTRAL_API_KEY=sua_chave');
  }
  console.warn('    Formato correto: MISTRAL_API_KEY=xxxx  (sem espaços, sem aspas). Reinicie o servidor depois.\n');
});
