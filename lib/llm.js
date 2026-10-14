// Cliente de chat para qualquer API compatível com a da OpenAI
// (OpenAI, Gemini, Ollama, LM Studio, OpenRouter, Groq…). Sem chave nem URL
// configuradas, cai no modo demonstração, que responde sem rede.
const OPENAI_URL = 'https://api.openai.com/v1';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const MODEL_CACHE_MS = 5 * 60 * 1000;
// Modelos que não servem para chat de texto (voz, imagem, embeddings…).
const NON_CHAT = /(audio|realtime|tts|transcribe|image|embedding|whisper|moderation|instruct|search|live|robotics|computer-use|customtools|nano-banana|translate)/;
// Erros em que vale tentar o próximo modelo da lista de reserva.
const RETRYABLE = new Set([404, 429, 500, 502, 503, 504, 529]);
// Apelidos que o Google mantém apontando para o Flash mais novo. O /models do
// Gemini ainda lista modelos antigos que dão 404 para chaves novas, então o
// padrão e a reserva usam estes em vez do primeiro da lista.
const GEMINI_DEFAULTS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];

const csv = (s) => (s || '').split(',').map((m) => m.trim()).filter(Boolean);

export function createProvider(env) {
  const gemini = Boolean(env.GEMINI_API_KEY) && !env.OPENAI_BASE_URL;
  const baseUrl = (env.OPENAI_BASE_URL || (gemini ? GEMINI_URL : OPENAI_URL)).replace(/\/+$/, '');
  const apiKey = gemini ? env.GEMINI_API_KEY : env.OPENAI_API_KEY || '';
  if (!apiKey && baseUrl === OPENAI_URL) return demoProvider();
  return openAIProvider({
    baseUrl,
    apiKey,
    defaultModel: env.OPENAI_MODEL || '',
    fixedModels: csv(env.OPENAI_MODELS),
    fallbackModels: csv(env.OPENAI_FALLBACK_MODELS),
  });
}

class ApiError extends Error {
  constructor(status, detail) {
    super(friendlyMessage(status, detail));
    this.status = status;
  }
}

function friendlyMessage(status, detail) {
  if (status === 401 || status === 403) return 'A chave da API foi recusada. Confira a chave no arquivo .env.';
  if (status === 429) return 'A cota da API acabou para este modelo. Escolha outro modelo ou tente mais tarde.';
  if (status === 503 || status === 529) return 'O modelo está sobrecarregado agora. Tente de novo em instantes ou escolha outro modelo.';
  return `A API respondeu ${status}${detail ? `: ${detail}` : ''}`;
}

function openAIProvider({ baseUrl, apiKey, defaultModel, fixedModels, fallbackModels }) {
  const isOpenAI = baseUrl === OPENAI_URL;
  const isGemini = baseUrl === GEMINI_URL;
  if (isGemini && !fallbackModels.length) fallbackModels = GEMINI_DEFAULTS;
  let cache = null;
  // Modelos que a API disse não existirem (404); somem do seletor até reiniciar.
  const unavailable = new Set();

  const headers = () => ({
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  });

  async function request(pathname, init) {
    const res = await fetch(`${baseUrl}${pathname}`, { ...init, headers: headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let detail = body.slice(0, 300);
      try {
        const json = JSON.parse(body);
        detail = (Array.isArray(json) ? json[0] : json)?.error?.message || detail; // o Gemini devolve uma lista
      } catch {}
      throw new ApiError(res.status, detail);
    }
    return res;
  }

  // Tenta o modelo pedido e, se ele estiver sobrecarregado ou sem cota antes de
  // gerar qualquer texto, os modelos de OPENAI_FALLBACK_MODELS, em ordem.
  async function withFallback(model, run) {
    const all = [model, ...fallbackModels.filter((m) => m !== model)];
    const usable = all.filter((m) => !unavailable.has(m));
    const chain = usable.length ? usable : [model];
    let lastError;
    for (const candidate of chain) {
      try {
        return { ...(await run(candidate)), model: candidate };
      } catch (err) {
        if (!RETRYABLE.has(err.status)) throw err;
        // Só conta como "modelo inexistente" se a mensagem fala do modelo; um 404
        // genérico costuma ser URL errada e não deve esvaziar a lista.
        if (err.status === 404 && /model/i.test(err.message)) unavailable.add(candidate);
        lastError = err;
        if (candidate !== chain[chain.length - 1]) console.warn(`Modelo ${candidate} falhou (${err.status}); tentando o próximo.`);
      }
    }
    throw lastError;
  }

  async function listModels() {
    if (fixedModels.length) return withDefault(fixedModels);
    if (!cache || Date.now() - cache.at >= MODEL_CACHE_MS) cache = { at: Date.now(), ids: await fetchModels() };
    return withDefault(cache.ids.filter((id) => !unavailable.has(id)));
  }

  async function fetchModels() {
    let ids = [];
    try {
      const res = await request('/models', { method: 'GET' });
      ids = ((await res.json()).data || []).map((m) => m.id).filter(Boolean);
    } catch (err) {
      console.warn('Não consegui listar os modelos:', err.message);
    }
    if (isOpenAI) {
      ids = ids.filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !NON_CHAT.test(id));
      return ids.sort((a, b) => a.localeCompare(b));
    }
    if (isGemini) {
      ids = ids.map((id) => id.replace(/^models\//, '')).filter((id) => /^gemini/.test(id) && !NON_CHAT.test(id));
      // Apelidos "-latest" primeiro (flash, flash-lite, pro), depois do mais novo para o mais antigo.
      const alias = (id) => (/-latest$/.test(id) ? 0 : 1);
      return ids.sort((a, b) => alias(a) - alias(b)
        || (alias(a) === 0 ? a.localeCompare(b) : b.localeCompare(a, undefined, { numeric: true })));
    }
    return ids.sort((a, b) => a.localeCompare(b));
  }

  function withDefault(ids) {
    if (defaultModel && !ids.includes(defaultModel)) return [defaultModel, ...ids];
    return ids;
  }

  async function getDefaultModel() {
    if (defaultModel) return defaultModel;
    const models = await listModels();
    if (isGemini) return GEMINI_DEFAULTS.find((m) => models.includes(m)) || models[0] || '';
    return models[0] || '';
  }

  // Devolve { finish, model }, com o modelo que de fato respondeu.
  async function stream({ model, messages, signal, onDelta, onReasoning }) {
    return withFallback(model, async (candidate) => {
      const res = await request('/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: candidate, messages, stream: true }),
        signal,
      });
      let finish = null;
      for await (const event of readSSE(res.body)) {
        if (event === '[DONE]') break;
        let json;
        try {
          json = JSON.parse(event);
        } catch {
          continue;
        }
        if (json.error) throw new Error(json.error.message || 'Erro no stream da API');
        const choice = json.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning) onReasoning?.(reasoning);
        if (typeof delta.content === 'string' && delta.content) onDelta(delta.content);
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      return { finish: finish || 'stop' };
    });
  }

  async function complete({ model, messages, signal }) {
    const { text } = await withFallback(model, async (candidate) => {
      const res = await request('/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: candidate, messages }),
        signal,
      });
      const json = await res.json();
      return { text: json.choices?.[0]?.message?.content || '' };
    });
    return text;
  }

  return { mode: 'live', baseUrl, listModels, getDefaultModel, stream, complete };
}

// Lê um corpo `text/event-stream` e devolve o conteúdo de cada linha `data:`.
async function* readSSE(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  if (buffer.startsWith('data:')) yield buffer.slice(5).trim();
}

function demoProvider() {
  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });

  async function stream({ messages, signal, onDelta }) {
    const last = messages[messages.length - 1];
    const asked = typeof last?.content === 'string'
      ? last.content
      : (last?.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    const text = demoReply(asked);
    await sleep(500, signal);
    for (const piece of text.match(/\S+\s*|\s+/g) || []) {
      onDelta(piece);
      await sleep(12, signal);
    }
    return { finish: 'stop' };
  }

  async function complete({ messages }) {
    // O pedido de título traz "Usuário: <texto>\n\nAssistente: ..."; usamos só o texto do usuário.
    const first = messages.find((m) => m.role === 'user');
    const text = typeof first?.content === 'string' ? first.content : '';
    const asked = text.replace(/^Usuário:\s*/, '').split('\n')[0];
    return asked.split(/\s+/).slice(0, 5).join(' ') || 'Chat de demonstração';
  }

  return {
    mode: 'demo',
    baseUrl: null,
    listModels: async () => ['demo'],
    getDefaultModel: async () => 'demo',
    stream,
    complete,
  };
}

function demoReply(asked) {
  const quoted = (asked || '(mensagem vazia)').trim().split('\n').slice(0, 6).map((l) => `> ${l}`).join('\n');
  return `**Modo demonstração.** Ainda não há um modelo de IA ligado a este clone, então esta resposta é fixa.

Você escreveu:

${quoted}

Para respostas de verdade, crie um arquivo \`.env\` na pasta do projeto com **uma** destas opções e reinicie o servidor:

| Provedor | O que colocar no \`.env\` |
|---|---|
| OpenAI | \`OPENAI_API_KEY=sk-...\` |
| Gemini (tem cota grátis) | \`GEMINI_API_KEY=...\` |
| Ollama (local) | \`OPENAI_BASE_URL=http://localhost:11434/v1\` |
| LM Studio (local) | \`OPENAI_BASE_URL=http://localhost:1234/v1\` |
| OpenRouter | \`OPENAI_BASE_URL=https://openrouter.ai/api/v1\` e \`OPENAI_API_KEY=...\` |

Enquanto isso, dá para testar a interface: markdown, listas, tabelas e blocos de código.

\`\`\`js
// Um bloco de código com destaque de sintaxe e botão de copiar
function saudacao(nome) {
  return \`Olá, \${nome}!\`;
}
\`\`\`

1. Use **Tentar novamente** para gerar outra versão desta resposta.
2. Edite a sua mensagem para criar um ramo novo da conversa.
3. Alterne entre as versões com as setas ‹ 1/2 ›.`;
}
