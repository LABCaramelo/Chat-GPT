// Servidor do clone: arquivos estáticos, API de conversas e stream SSE das respostas.
// O corpo de POST /api/conversation segue o formato observado no chatgpt.com
// (action, conversation_id, parent_message_id, model, messages[]); veja docs/ANALISE-REA.md.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store, DEFAULT_TITLE, messageText } from './lib/store.js';
import { createProvider } from './lib/llm.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const APP_NAME = process.env.APP_NAME || 'ChatGPT';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || '';
const MAX_BODY = 30 * 1024 * 1024; // imagens anexadas chegam como data URLs

const provider = createProvider(process.env);
const store = new Store(path.join(ROOT, 'data'));
await store.load();

const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await routeApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Método não permitido' });
    return await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.expose ? err.message : 'Erro interno' });
    else res.end();
  }
});

async function routeApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // sem o "api"
  const [resource, id, sub, subId, action] = parts;
  const method = req.method;

  if (resource === 'config' && method === 'GET') {
    return sendJson(res, 200, {
      appName: APP_NAME,
      mode: provider.mode,
      baseUrl: provider.baseUrl,
      defaultModel: await provider.getDefaultModel(),
    });
  }

  if (resource === 'models' && method === 'GET') {
    return sendJson(res, 200, { models: await provider.listModels() });
  }

  if (resource === 'conversation' && method === 'POST') return handleConversation(req, res);

  if (resource === 'search' && method === 'GET') {
    return sendJson(res, 200, { items: store.search(url.searchParams.get('q') || '') });
  }

  if (resource === 'export' && method === 'GET') {
    res.setHeader('Content-Disposition', 'attachment; filename="conversations.json"');
    return sendJson(res, 200, store.exportAll());
  }

  if (resource === 'import' && method === 'POST') {
    const body = await readJson(req);
    const imported = store.import(Array.isArray(body) ? body : body?.conversations);
    return sendJson(res, 200, { imported });
  }

  if (resource === 'conversations') {
    if (!id) {
      if (method === 'GET') return sendJson(res, 200, { items: store.list() });
      if (method === 'DELETE') {
        store.deleteAll();
        return sendJson(res, 200, { ok: true });
      }
    } else {
      const conv = store.get(id);
      if (!conv) return sendJson(res, 404, { error: 'Conversa não encontrada' });
      if (!sub) {
        if (method === 'GET') return sendJson(res, 200, conv);
        if (method === 'DELETE') {
          store.delete(id);
          return sendJson(res, 200, { ok: true });
        }
        if (method === 'PATCH') {
          const body = await readJson(req);
          if (typeof body.title === 'string') store.rename(conv, body.title);
          if (typeof body.current_node === 'string' && !store.setCurrent(conv, body.current_node)) {
            return sendJson(res, 400, { error: 'Mensagem não encontrada' });
          }
          return sendJson(res, 200, { id: conv.id, title: conv.title, current_node: conv.current_node });
        }
      } else if (sub === 'messages' && subId && action === 'feedback' && method === 'POST') {
        const body = await readJson(req);
        const rating = body.rating === 'up' || body.rating === 'down' ? body.rating : null;
        if (!store.setFeedback(conv, subId, rating)) return sendJson(res, 404, { error: 'Mensagem não encontrada' });
        return sendJson(res, 200, { ok: true, rating });
      }
    }
  }

  return sendJson(res, 404, { error: 'Rota não encontrada' });
}

async function handleConversation(req, res) {
  const body = await readJson(req);
  const action = body.action === 'variant' ? 'variant' : 'next';

  let conv;
  if (body.conversation_id) {
    conv = store.get(body.conversation_id);
    if (!conv) return sendJson(res, 404, { error: 'Conversa não encontrada' });
  } else {
    conv = store.create({ temporary: body.temporary });
  }

  const model = String(body.model || (await provider.getDefaultModel()) || '');
  if (!model) return sendJson(res, 400, { error: 'Nenhum modelo disponível. Configure OPENAI_MODEL no .env.' });

  // `parent` é a mensagem do usuário que a resposta vai seguir.
  let parent;
  if (action === 'next') {
    const parentId = body.parent_message_id && conv.mapping[body.parent_message_id]
      ? body.parent_message_id
      : store.rootId(conv);
    const user = sanitizeUserMessage(body.messages?.[0], conv);
    if (!user) return sendJson(res, 400, { error: 'Mensagem vazia' });
    store.addMessage(conv, parentId, user);
    parent = user;
  } else {
    parent = conv.mapping[body.parent_message_id]?.message;
    if (parent?.author?.role !== 'user') return sendJson(res, 400, { error: 'Mensagem a regenerar não encontrada' });
    conv.current_node = parent.id;
  }

  const emit = openSSE(res);
  const assistantId = randomUUID();
  emit('meta', { conversation: conv, user_message_id: parent.id, assistant_message_id: assistantId });

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  let text = '';
  let reasoning = '';
  let finish = 'stop';
  let failure = null;
  let answeredBy = model; // muda se o provedor cair num modelo de reserva
  const started = Date.now();
  try {
    const history = buildHistory(conv, parent.id, body.system_prompt);
    const result = await provider.stream({
      model,
      messages: history,
      signal: controller.signal,
      onDelta: (v) => {
        text += v;
        emit('delta', { v });
      },
      onReasoning: (v) => {
        reasoning += v;
        emit('reasoning', { v });
      },
    });
    finish = result.finish;
    if (result.model) answeredBy = result.model;
  } catch (err) {
    if (controller.signal.aborted) finish = 'interrupted';
    else failure = err;
  }

  let assistant = null;
  if (text || reasoning) {
    assistant = {
      id: assistantId,
      author: { role: 'assistant' },
      content: { content_type: 'text', parts: [text] },
      create_time: Date.now() / 1000,
      metadata: {
        model_slug: answeredBy,
        ...(answeredBy !== model ? { requested_model_slug: model } : {}),
        finish_details: { type: finish },
        ...(reasoning ? { reasoning, reasoning_ms: Date.now() - started } : {}),
      },
    };
    store.addMessage(conv, parent.id, assistant);
  }

  if (controller.signal.aborted) return; // o cliente já foi embora

  if (failure) {
    console.error('Falha ao gerar resposta:', failure.message);
    emit('error', { message: failure.message, assistant_message: assistant });
    return res.end();
  }

  emit('done', { message: assistant });

  if (conv.title === DEFAULT_TITLE && assistant) {
    const title = await generateTitle(answeredBy, messageText(parent), text);
    store.rename(conv, title);
    emit('title', { conversation_id: conv.id, title: conv.title });
  }
  res.end();
}

function sanitizeUserMessage(raw, conv) {
  const text = typeof raw?.content?.parts?.[0] === 'string' ? raw.content.parts[0] : '';
  const attachments = Array.isArray(raw?.metadata?.attachments)
    ? raw.metadata.attachments
        .filter((a) => (a.kind === 'image' && /^data:image\//.test(a.dataUrl || '')) || (a.kind === 'file' && typeof a.text === 'string'))
        .slice(0, 10)
        .map((a) => ({
          id: String(a.id || randomUUID()),
          kind: a.kind,
          name: String(a.name || 'arquivo').slice(0, 200),
          size: Number(a.size) || 0,
          ...(a.kind === 'image' ? { dataUrl: a.dataUrl } : { text: a.text }),
        }))
    : [];
  if (!text.trim() && !attachments.length) return null;
  const id = typeof raw?.id === 'string' && /^[\w-]{8,64}$/.test(raw.id) && !conv.mapping[raw.id] ? raw.id : randomUUID();
  return {
    id,
    author: { role: 'user' },
    content: { content_type: 'text', parts: [text] },
    create_time: Date.now() / 1000,
    metadata: attachments.length ? { attachments } : {},
  };
}

// Converte o caminho da conversa no formato `messages` de /chat/completions.
function buildHistory(conv, leafId, customInstructions) {
  const today = new Date().toISOString().slice(0, 10);
  const system = [
    `Você é ${APP_NAME}, um assistente de IA útil. Responda no idioma do usuário e use markdown quando ajudar. Data atual: ${today}.`,
    SYSTEM_PROMPT,
    typeof customInstructions === 'string' && customInstructions.trim()
      ? `Instruções personalizadas do usuário:\n${customInstructions.trim().slice(0, 4000)}`
      : '',
  ].filter(Boolean).join('\n\n');

  const out = [{ role: 'system', content: system }];
  for (const msg of store.path(conv, leafId)) {
    const role = msg.author?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = messageText(msg);
    const attachments = msg.metadata?.attachments || [];
    const files = attachments.filter((a) => a.kind === 'file');
    const images = attachments.filter((a) => a.kind === 'image');
    const fullText = [
      text,
      ...files.map((f) => `Arquivo anexado: ${f.name}\n\`\`\`\n${f.text}\n\`\`\``),
    ].filter(Boolean).join('\n\n');
    if (role === 'user' && images.length) {
      out.push({
        role,
        content: [
          ...(fullText ? [{ type: 'text', text: fullText }] : []),
          ...images.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
        ],
      });
    } else if (fullText) {
      out.push({ role, content: fullText });
    }
  }
  return out;
}

async function generateTitle(model, userText, replyText) {
  const fallback = userText.replace(/\s+/g, ' ').trim().slice(0, 50) || 'Novo chat';
  try {
    const raw = await provider.complete({
      model,
      signal: AbortSignal.timeout(20000),
      messages: [
        {
          role: 'system',
          content: 'Crie um título curto (no máximo 6 palavras) para esta conversa, no idioma dela. Responda só com o título, sem aspas e sem ponto final.',
        },
        { role: 'user', content: `Usuário: ${userText.slice(0, 1500)}\n\nAssistente: ${replyText.slice(0, 1500)}` },
      ],
    });
    const title = raw.replace(/<think>[\s\S]*?<\/think>/g, '').split('\n').map((l) => l.trim()).find(Boolean) || '';
    return title.replace(/^["'“”*#\s]+|["'“”*.\s]+$/g, '').slice(0, 80) || fallback;
  } catch {
    return fallback;
  }
}

function openSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  return (event, data) => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, 'Conteúdo grande demais');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'JSON inválido');
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  // Rotas do app (/, /c/<id>) devolvem o index.html; o roteamento é no cliente.
  if (rel === '/' || rel.startsWith('/c/')) rel = '/index.html';
  const file = safeJoin(PUBLIC_DIR, rel);
  if (!file) return sendJson(res, 404, { error: 'Não encontrado' });
  return sendFile(res, file, rel.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache');
}

function safeJoin(base, rel) {
  const file = path.resolve(base, `.${path.posix.normalize(`/${rel}`)}`);
  return file.startsWith(base + path.sep) ? file : null;
}

async function sendFile(res, file, cacheControl) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    stat = null;
  }
  if (!stat?.isFile()) return sendJson(res, 404, { error: 'Não encontrado' });
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
  });
  fs.createReadStream(file).pipe(res);
}

server.listen(PORT, HOST, () => {
  const where = provider.mode === 'demo' ? 'modo demonstração (sem modelo configurado)' : `API em ${provider.baseUrl}`;
  console.log(`${APP_NAME} clone rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} — ${where}`);
});
