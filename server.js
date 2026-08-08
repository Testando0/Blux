import express from 'express';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// carrega o .env que fica AO LADO do server.js
const envPath = path.join(__dirname, '.env');
dotenv.config({ path: envPath });

const KEY = (process.env.MISTRAL_API_KEY || '').trim().replace(/^['"]+|['"]+$/g, '');

const app = express();
const MODEL = 'ministral-8b-latest';
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';

const codigosPath = path.join(__dirname, 'codigos.json');
const systemPath  = path.join(__dirname, 'system.txt');
const system2Path = path.join(__dirname, 'system2.txt');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────
// ATIVAR CÓDIGO (uso único — marca como "usado")
// ──────────────────────────────────────────────
app.post('/api/ativar', (req, res) => {
  const { codigo } = req.body || {};
  let db;
  try {
    db = JSON.parse(fs.readFileSync(codigosPath, 'utf8'));
  } catch {
    return res.status(500).json({ error: 'codigos.json inválido ou ausente' });
  }

  const lista = Array.isArray(db.codigos) ? db.codigos : (Array.isArray(db) ? db : null);
  if (!lista) return res.status(500).json({ error: 'codigos.json sem estrutura válida' });

  const idx = lista.findIndex(x => String(x.codigo) === String(codigo ?? '').trim());
  if (idx === -1) return res.status(404).json({ error: 'Código inválido.' });

  const c = lista[idx];

  // código já foi utilizado?
  if (c.usado) {
    return res.status(410).json({ error: 'Código já utilizado. Cada código é de uso único.' });
  }

  // marca como usado (persistência atômica simples)
  lista[idx] = { ...c, usado: true, usadoEm: Date.now() };
  try {
    const novo = Array.isArray(db.codigos) ? { ...db, codigos: lista } : lista;
    fs.writeFileSync(codigosPath, JSON.stringify(novo, null, 2), 'utf8');
  } catch (e) {
    console.error('Erro ao salvar codigos.json:', e.message);
    return res.status(500).json({ error: 'Erro ao registrar o código.' });
  }

  res.json({
    dias: Math.max(1, +c.dias || 1),
    nome: c.nome || ''
  });
});

// ──────────────────────────────────────────────
// CHAT — escolhe o system prompt pelo gênero
// ──────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'MISTRAL_API_KEY não configurada no .env' });

  const { messages, gender } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages inválido' });
  }

  // escolhe o system prompt conforme o gênero
  const isFemale = String(gender || '').toUpperCase() === 'F';
  const promptFile = isFemale ? system2Path : systemPath;
  let system = '';
  try {
    system = fs.readFileSync(promptFile, 'utf8').trim();
  } catch (e) {
    // fallback: se o system2.txt não existe ainda, usa o system.txt
    try { system = fs.readFileSync(systemPath, 'utf8').trim(); } catch {}
    if (!system) console.warn('⚠ Nenhum system prompt encontrado (system.txt / system2.txt)');
  }

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
    console.log('  ✓ Chave da Mistral carregada (' + KEY.slice(0, 6) + '...)');
  } else {
    console.warn('\n  ⚠ MISTRAL_API_KEY NÃO foi carregada!');
    if (!fs.existsSync(envPath)) {
      console.warn('  → O arquivo .env NÃO existe aqui: ' + envPath);
      console.warn('    Precisa ficar na MESMA pasta do server.js.');
    } else {
      const linhas = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '').split('\n')
        .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      const chaves = linhas.map(l => l.split('=')[0].trim());
      console.warn('  → .env lido. Chaves: ' + (chaves.join(', ') || '(nenhuma)'));
      if (!chaves.includes('MISTRAL_API_KEY')) console.warn('    → Falta a linha: MISTRAL_API_KEY=sua_chave');
    }
  }
  console.log('  ✓ Código de uso único habilitado');
  console.log('  ✓ Escolha de gênero (system.txt / system2.txt) habilitada\n');
});
