// Interface do clone. Textos e estrutura seguem o que o REA observou no
// chatgpt.com (docs/ANALISE-REA.md); o restante é decisão de projeto.
import { Marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { icon, hydrateIcons } from '/icons.js';
import { highlight } from '/highlight.js';

const MAX_ATTACHMENTS = 10;
const MAX_TEXT_FILE = 512 * 1024;
const MAX_IMAGE_SIDE = 2048;
const DEFAULT_TITLE = 'Novo chat';
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

const $ = (sel) => document.querySelector(sel);
const els = {
  app: $('#app'),
  main: $('#main'),
  historyList: $('#history-list'),
  historyEmpty: $('#history-empty'),
  backdrop: $('.backdrop'),
  scroller: $('#scroller'),
  thread: $('#thread'),
  homeTitle: $('#home-title'),
  homeSub: $('#home-sub'),
  dock: $('#dock'),
  composer: $('#composer'),
  prompt: $('#prompt'),
  sendBtn: $('#send-btn'),
  dictateBtn: $('#dictate-btn'),
  plusBtn: $('#plus-btn'),
  plusMenu: $('#plus-menu'),
  fileInput: $('#file-input'),
  attachments: $('#attachments'),
  dropOverlay: $('#drop-overlay'),
  modelBtn: $('#model-btn'),
  modelMenu: $('#model-menu'),
  modelList: $('#model-list'),
  modelName: $('#model-name'),
  tempBtn: $('#temp-btn'),
  scrollDown: $('#scroll-down'),
  chatMenu: $('#chat-menu'),
  searchModal: $('#search-modal'),
  searchInput: $('#search-input'),
  searchResults: $('#search-results'),
  settingsModal: $('#settings-modal'),
  themeSelect: $('#theme-select'),
  instructions: $('#instructions'),
  providerInfo: $('#provider-info'),
  importInput: $('#import-input'),
  confirmModal: $('#confirm-modal'),
  confirmTitle: $('#confirm-title'),
  confirmText: $('#confirm-text'),
  confirmOk: $('#confirm-ok'),
  toasts: $('#toasts'),
  voiceBanner: $('#voice-banner'),
  voiceStatus: $('#voice-status'),
};

const settings = { theme: 'system', instructions: '', ...readStorage('settings', {}) };

const state = {
  appName: 'ChatGPT',
  config: null,
  models: [],
  model: readStorage('model', null),
  list: [],
  conv: null, // conversa aberta; null = tela inicial
  temporary: false,
  stream: null, // resposta sendo gerada
  error: null, // { conv, parentId, message }
  attachments: [],
  editing: null, // id da mensagem do usuário em edição
  renaming: null, // id da conversa sendo renomeada na barra lateral
  menuConvId: null,
  speakingId: null,
};

let pinned = true;
let dictation = null;
const voice = { active: false, rec: null };

// ---------- Markdown ----------
const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    code({ text, lang }) {
      return codeBlockHtml(text, (lang || '').trim().split(/\s+/)[0].toLowerCase());
    },
    // Como no ChatGPT, HTML escrito pelo modelo aparece como texto.
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

function codeBlockHtml(code, lang) {
  const body = highlight(code, lang);
  return `<div class="code-block"><div class="code-head"><span>${escapeHtml(lang || 'código')}</span><button type="button" data-action="copy-code">${icon('copy', 15)}<span>Copiar código</span></button></div><pre><code class="hljs">${body}</code></pre></div>`;
}

function renderMarkdownInto(el, text) {
  const frag = DOMPurify.sanitize(marked.parse(text || ''), { RETURN_DOM_FRAGMENT: true });
  for (const table of frag.querySelectorAll('table')) {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.append(table);
  }
  for (const a of frag.querySelectorAll('a[href]')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  el.replaceChildren(frag);
}

// ---------- Utilitários ----------
function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function iconButton(name, label, action, extra = '') {
  const b = h('button', `icon-btn ${extra}`.trim());
  b.type = 'button';
  b.dataset.action = action;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.innerHTML = icon(name);
  return b;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function messageText(msg) {
  const parts = msg?.content?.parts;
  return Array.isArray(parts) ? parts.filter((p) => typeof p === 'string').join('\n') : '';
}

function toast(message, type = '') {
  const t = h('div', `toast ${type}`.trim(), message);
  els.toasts.append(t);
  setTimeout(() => t.remove(), 2600);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

async function copyText(text, message = 'Copiado') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast('Não foi possível copiar. Tente novamente.', 'error');
  }
}

// Lê eventos SSE de um corpo de resposta do fetch.
async function* readEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue;
      try {
        yield { event, data: JSON.parse(data.join('\n')) };
      } catch {}
    }
  }
}

// ---------- Tema e nome do app ----------
function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'dark' || settings.theme === 'light') root.dataset.theme = settings.theme;
  else delete root.dataset.theme;
}

function applyAppName(name) {
  state.appName = name;
  for (const el of document.querySelectorAll('.app-name')) el.textContent = name;
  els.prompt.placeholder = `Pergunte ao ${name}`;
  els.prompt.setAttribute('aria-label', `Chat com o ${name}`);
  document.querySelector('label[for="prompt"]').textContent = `Chat com o ${name}`;
  document.querySelector('.disclaimer').textContent = `O ${name} pode cometer erros. Confira informações importantes.`;
}

// ---------- Navegação ----------
function convIdFromPath() {
  return location.pathname.match(/^\/c\/([\w-]+)/)?.[1] || null;
}

async function route() {
  const id = convIdFromPath();
  if (!id) return showHome({ push: false });
  if (state.conv?.id === id) return;
  await openConversation(id, { push: false });
}

function leaveCurrent() {
  if (state.stream) state.stream.controller.abort();
  stopSpeaking();
  state.error = null;
  state.editing = null;
}

function showHome({ push = true } = {}) {
  leaveCurrent();
  state.conv = null;
  if (push && location.pathname !== '/') history.pushState({}, '', '/');
  render();
  els.prompt.focus();
}

async function openConversation(id, { push = true } = {}) {
  leaveCurrent();
  closeSidebarOnMobile();
  try {
    const conv = await api(`/api/conversations/${id}`);
    state.conv = conv;
    state.temporary = Boolean(conv.temporary);
    if (push) history.pushState({}, '', `/c/${id}`);
    render();
    scrollToBottom();
  } catch (err) {
    toast(err.message || 'Conversa não encontrada', 'error');
    history.replaceState({}, '', '/');
    state.conv = null;
    render();
  }
}

function newChat() {
  closeSidebarOnMobile();
  showHome({ push: true });
}

// ---------- Renderização ----------
function render() {
  const home = !state.conv;
  els.main.classList.toggle('is-home', home);
  els.homeTitle.textContent = state.temporary ? 'Chat temporário' : 'Por onde começamos?';
  els.homeSub.hidden = !state.temporary;
  els.tempBtn.setAttribute('aria-pressed', String(state.temporary));
  els.tempBtn.title = state.temporary ? 'Desativar chat temporário' : 'Ativar chat temporário';
  const title = state.conv?.title;
  document.title = title && title !== DEFAULT_TITLE ? title : state.appName;
  renderHistory();
  renderThread();
  updateComposer();
}

function visibleNodes(conv) {
  const out = [];
  let node = conv.mapping[conv.current_node];
  while (node) {
    const msg = node.message;
    const role = msg?.author?.role;
    const type = msg?.content?.content_type;
    const hidden = msg?.metadata?.is_visually_hidden_from_conversation;
    if (!hidden && (role === 'user' || role === 'assistant') && (!type || type === 'text' || type === 'multimodal_text')) {
      if (role === 'user' || messageText(msg).trim() || msg.metadata?.reasoning) out.push(node);
    }
    node = node.parent ? conv.mapping[node.parent] : null;
  }
  return out.reverse();
}

function renderThread() {
  const conv = state.conv;
  els.thread.textContent = '';
  if (!conv) return;
  const nodes = visibleNodes(conv);
  const streaming = state.stream?.conv === conv;
  const lastAssistant = streaming ? null : [...nodes].reverse().find((n) => n.message.author.role === 'assistant');
  for (const node of nodes) {
    els.thread.append(node.message.author.role === 'user' ? userTurn(node) : assistantTurn(node, node === lastAssistant));
  }
  if (streaming) els.thread.append(state.stream.el);
  if (state.error?.conv === conv) els.thread.append(errorTurn(state.error));
  updateScrollButton();
}

function userTurn(node) {
  const msg = node.message;
  const el = h('div', 'turn user');
  el.dataset.id = node.id;
  if (state.editing === node.id) {
    el.append(editBox(node));
    return el;
  }
  const atts = msg.metadata?.attachments || [];
  if (atts.length) {
    const wrap = h('div', 'user-attachments');
    for (const a of atts) wrap.append(attachmentView(a, false));
    el.append(wrap);
  }
  const text = messageText(msg);
  if (text) el.append(h('div', 'bubble', text));
  const actions = h('div', 'actions');
  const nav = branchNav(node);
  actions.append(iconButton('copy', 'Copiar', 'copy-msg'));
  if (!state.stream) actions.append(iconButton('edit', 'Editar mensagem', 'edit-msg'));
  if (nav) actions.append(nav);
  el.append(actions);
  return el;
}

function editBox(node) {
  const box = h('div', 'edit-box');
  const ta = h('textarea');
  ta.value = messageText(node.message);
  ta.setAttribute('aria-label', 'Editar mensagem');
  const fit = () => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  };
  ta.addEventListener('input', fit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      state.editing = null;
      renderThread();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch()) {
      e.preventDefault();
      submitEdit(node.id, ta.value);
    }
  });
  const actions = h('div', 'edit-actions');
  const cancel = h('button', 'btn', 'Cancelar');
  cancel.type = 'button';
  cancel.dataset.action = 'edit-cancel';
  const send = h('button', 'btn primary', 'Enviar');
  send.type = 'button';
  send.dataset.action = 'edit-send';
  actions.append(cancel, send);
  box.append(ta, actions);
  requestAnimationFrame(() => {
    fit();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
  return box;
}

function assistantTurn(node, latest) {
  const msg = node.message;
  const meta = msg.metadata || {};
  const el = h('div', `turn assistant${latest ? ' latest' : ''}`);
  el.dataset.id = node.id;
  if (meta.reasoning) el.append(reasoningBlock(meta.reasoning, meta.reasoning_ms));
  const md = h('div', 'markdown');
  renderMarkdownInto(md, messageText(msg));
  el.append(md);
  if (meta.finish_details?.type === 'interrupted') el.append(h('div', 'interrupted', 'Resposta interrompida'));
  if (meta.requested_model_slug && meta.requested_model_slug !== meta.model_slug) {
    el.append(h('div', 'model-note', `Respondido por ${meta.model_slug}: ${meta.requested_model_slug} não estava disponível.`));
  }

  const actions = h('div', 'actions');
  const nav = branchNav(node);
  if (nav) actions.append(nav);
  actions.append(iconButton('copy', 'Copiar', 'copy-msg'));
  const up = iconButton('thumbUp', 'Boa resposta', 'feedback-up', meta.feedback === 'up' ? 'on' : '');
  const down = iconButton('thumbDown', 'Resposta ruim', 'feedback-down', meta.feedback === 'down' ? 'on' : '');
  if (meta.feedback !== 'down') actions.append(up);
  if (meta.feedback !== 'up') actions.append(down);
  if ('speechSynthesis' in window) {
    const speaking = state.speakingId === node.id;
    actions.append(iconButton(speaking ? 'stop' : 'speaker', speaking ? 'Parar' : 'Ler em voz alta', 'read-aloud', speaking ? 'on' : ''));
  }
  if (!state.stream) actions.append(iconButton('retry', 'Tentar novamente', 'regenerate'));
  el.append(actions);
  return el;
}

function reasoningBlock(text, ms) {
  const wrap = h('div', 'reasoning');
  const btn = h('button', 'reasoning-toggle');
  btn.type = 'button';
  btn.dataset.action = 'toggle-reasoning';
  btn.append(h('span', 'reasoning-label', ms ? `Pensou por ${Math.max(1, Math.round(ms / 1000))}s` : 'Raciocínio'));
  btn.insertAdjacentHTML('beforeend', icon('chevronDown', 16));
  wrap.append(btn, h('div', 'reasoning-body', text));
  return wrap;
}

function errorTurn(error) {
  const el = h('div', 'turn assistant');
  const box = h('div', 'error-box');
  box.append(h('span', null, error.message || 'Chat interrompido inesperadamente'));
  const retry = h('button', 'btn', 'Tentar novamente');
  retry.type = 'button';
  retry.dataset.action = 'retry-error';
  box.append(retry);
  el.append(box);
  return el;
}

function branchNav(node) {
  const conv = state.conv;
  const role = node.message.author.role;
  const parent = conv.mapping[node.parent];
  const siblings = (parent?.children || []).filter((id) => conv.mapping[id]?.message?.author?.role === role);
  if (siblings.length < 2) return null;
  const i = siblings.indexOf(node.id);
  const nav = h('div', 'branch-nav');
  const prev = iconButton('chevronLeft', 'Anterior', 'branch-prev');
  const next = iconButton('chevronRight', 'Próxima', 'branch-next');
  prev.disabled = i <= 0 || Boolean(state.stream);
  next.disabled = i >= siblings.length - 1 || Boolean(state.stream);
  nav.append(prev, h('span', null, `${i + 1}/${siblings.length}`), next);
  return nav;
}

function attachmentView(a, removable) {
  if (a.kind === 'image') {
    if (removable) {
      const chip = h('div', 'chip image');
      const img = h('img');
      img.src = a.dataUrl;
      img.alt = a.name;
      chip.append(img, removeButton(a.id));
      return chip;
    }
    const img = h('img');
    img.src = a.dataUrl;
    img.alt = a.name;
    img.dataset.action = 'open-image';
    return img;
  }
  const chip = h('div', 'chip');
  const badge = h('span', 'file-badge');
  badge.innerHTML = icon('file');
  chip.append(badge, h('span', 'file-name', a.name));
  if (removable) chip.append(removeButton(a.id));
  return chip;
}

function removeButton(id) {
  const b = h('button', 'chip-remove');
  b.type = 'button';
  b.dataset.action = 'remove-attachment';
  b.dataset.id = id;
  b.setAttribute('aria-label', 'Remover arquivo');
  b.innerHTML = icon('close');
  return b;
}

function renderHistory() {
  els.historyList.textContent = '';
  for (const item of state.list) {
    const li = h('li', 'history-item');
    li.dataset.id = item.id;
    if (state.conv?.id === item.id) li.classList.add('active');
    if (state.renaming === item.id) {
      const input = h('input');
      input.value = item.title;
      input.setAttribute('aria-label', 'Novo nome do chat');
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') {
          input.dataset.cancel = '1';
          input.blur();
        }
      });
      input.addEventListener('blur', () => finishRename(item, input.dataset.cancel ? null : input.value));
      li.append(input);
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    } else {
      const a = h('a', null, item.title || DEFAULT_TITLE);
      a.href = `/c/${item.id}`;
      a.dataset.action = 'open-conv';
      a.title = item.title;
      li.append(a, iconButton('more', 'Abrir opções da conversa', 'chat-more', 'item-more'));
    }
    els.historyList.append(li);
  }
  els.historyEmpty.hidden = state.list.length > 0;
}

function upsertListItem(conv) {
  if (!conv.id || conv.temporary) return;
  const existing = state.list.find((c) => c.id === conv.id);
  const item = existing || { id: conv.id, title: conv.title, create_time: conv.create_time };
  item.title = conv.title;
  item.update_time = Date.now() / 1000;
  state.list = [item, ...state.list.filter((c) => c.id !== conv.id)];
}

// ---------- Rolagem ----------
function nearBottom() {
  const s = els.scroller;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 80;
}

function scrollToBottom(smooth = false) {
  requestAnimationFrame(() => {
    els.scroller.scrollTo({ top: els.scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    pinned = true;
    updateScrollButton();
  });
}

function updateScrollButton() {
  const show = Boolean(state.conv) && !nearBottom();
  els.scrollDown.hidden = !show;
  if (show) els.scrollDown.style.bottom = `${els.dock.offsetHeight + 12}px`;
}

// ---------- Envio e streaming ----------
async function submitPrompt() {
  if (state.stream) return;
  const text = els.prompt.value;
  if (!text.trim() && !state.attachments.length) return;
  const attachments = state.attachments;
  state.attachments = [];
  els.prompt.value = '';
  renderAttachments();
  autosize();
  await sendMessage({ text: text.trim() ? text : '', attachments, parentId: state.conv?.current_node ?? null });
}

function submitEdit(nodeId, text) {
  const node = state.conv.mapping[nodeId];
  const attachments = node.message.metadata?.attachments || [];
  if (!text.trim() && !attachments.length) return;
  state.editing = null;
  sendMessage({ text, attachments, parentId: node.parent });
}

async function sendMessage({ text, attachments, parentId }) {
  const msg = {
    id: uuid(),
    author: { role: 'user' },
    content: { content_type: 'text', parts: [text] },
    create_time: Date.now() / 1000,
    metadata: attachments.length ? { attachments } : {},
  };
  if (!state.conv) {
    // Conversa local provisória; o servidor devolve a definitiva no evento `meta`.
    const rootId = 'local-root';
    state.conv = {
      id: null,
      title: DEFAULT_TITLE,
      temporary: state.temporary,
      current_node: msg.id,
      mapping: {
        [rootId]: { id: rootId, message: null, parent: null, children: [msg.id] },
        [msg.id]: { id: msg.id, message: msg, parent: rootId, children: [] },
      },
    };
    parentId = null;
  } else {
    const parent = state.conv.mapping[parentId];
    state.conv.mapping[msg.id] = { id: msg.id, message: msg, parent: parentId, children: [] };
    parent.children.push(msg.id);
    state.conv.current_node = msg.id;
  }
  await runStream({ action: 'next', parentId, message: msg });
}

function regenerate(userMessageId) {
  if (state.stream) return;
  state.conv.current_node = userMessageId;
  runStream({ action: 'variant', parentId: userMessageId });
}

function createStreamView() {
  const el = h('div', 'turn assistant');
  const thinking = h('span', 'thinking', 'Pensando');
  const md = h('div', 'markdown streaming');
  el.append(thinking, md);
  return { el, thinking, md, reasoningEl: null };
}

async function runStream({ action, parentId, message }) {
  const conv = state.conv;
  state.error = null;
  const stream = {
    conv,
    controller: new AbortController(),
    parentId: message ? message.id : parentId,
    assistantId: null,
    text: '',
    reasoning: '',
    started: Date.now(),
    reasoningMs: null,
    frame: 0,
    ...createStreamView(),
  };
  state.stream = stream;
  render();
  scrollToBottom();

  const body = {
    action,
    conversation_id: conv.id,
    parent_message_id: parentId,
    model: state.model,
    temporary: state.temporary,
    system_prompt: settings.instructions || undefined,
    messages: message ? [message] : [],
  };

  try {
    const res = await fetch('/api/conversation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: stream.controller.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Erro ${res.status}`);
    }
    for await (const { event, data } of readEvents(res.body)) {
      if (event === 'meta') onMeta(stream, data);
      else if (event === 'reasoning') onReasoning(stream, data.v);
      else if (event === 'delta') onDelta(stream, data.v);
      else if (event === 'done') finishStream(stream, data.message);
      else if (event === 'error') finishStream(stream, data.assistant_message, data.message);
      else if (event === 'title') onTitle(data);
    }
    if (state.stream === stream) finishStream(stream, null, 'A conexão com o servidor foi interrompida.');
  } catch (err) {
    if (err.name === 'AbortError') finishStream(stream, partialMessage(stream));
    else finishStream(stream, null, err.message);
  }
}

function onMeta(stream, data) {
  const server = data.conversation;
  const isNew = !stream.conv.id;
  Object.assign(stream.conv, server); // mantém a mesma referência em state.conv
  stream.assistantId = data.assistant_message_id;
  if (isNew && !server.temporary && state.conv === stream.conv) {
    history.pushState({}, '', `/c/${server.id}`);
  }
  upsertListItem(stream.conv);
  renderHistory();
}

function onReasoning(stream, v) {
  stream.reasoning += v;
  if (!stream.reasoningEl) {
    stream.reasoningEl = reasoningBlock('', 0);
    stream.reasoningEl.querySelector('.reasoning-label').textContent = 'Pensando';
    stream.thinking.hidden = true;
    stream.el.prepend(stream.reasoningEl);
  }
  stream.reasoningEl.querySelector('.reasoning-body').textContent = stream.reasoning;
  followBottom();
}

function onDelta(stream, v) {
  if (!stream.text) {
    stream.thinking.hidden = true;
    if (stream.reasoningEl) {
      stream.reasoningMs = Date.now() - stream.started;
      stream.reasoningEl.querySelector('.reasoning-label').textContent = `Pensou por ${Math.max(1, Math.round(stream.reasoningMs / 1000))}s`;
    }
  }
  stream.text += v;
  if (!stream.frame) {
    stream.frame = requestAnimationFrame(() => {
      stream.frame = 0;
      renderMarkdownInto(stream.md, stream.text);
      followBottom();
    });
  }
}

function followBottom() {
  if (pinned) els.scroller.scrollTop = els.scroller.scrollHeight;
  updateScrollButton();
}

function partialMessage(stream) {
  if (!stream.text && !stream.reasoning) return null;
  return {
    id: stream.assistantId || uuid(),
    author: { role: 'assistant' },
    content: { content_type: 'text', parts: [stream.text] },
    create_time: Date.now() / 1000,
    metadata: {
      model_slug: state.model,
      finish_details: { type: 'interrupted' },
      ...(stream.reasoning ? { reasoning: stream.reasoning, reasoning_ms: stream.reasoningMs || Date.now() - stream.started } : {}),
    },
  };
}

function finishStream(stream, assistant, errorMessage) {
  if (state.stream !== stream) return;
  cancelAnimationFrame(stream.frame);
  state.stream = null;
  const conv = stream.conv;
  if (assistant && !conv.mapping[assistant.id]) {
    conv.mapping[assistant.id] = { id: assistant.id, message: assistant, parent: stream.parentId, children: [] };
    conv.mapping[stream.parentId]?.children.push(assistant.id);
    conv.current_node = assistant.id;
  }
  if (errorMessage) state.error = { conv, parentId: stream.parentId, message: errorMessage };
  upsertListItem(conv);
  if (state.conv === conv) {
    render();
    if (pinned) scrollToBottom();
  } else {
    renderHistory();
  }
  if (voice.active) {
    if (assistant && !errorMessage) speak(assistant.id, messageText(assistant), () => listenForVoice());
    else listenForVoice();
  }
}

function onTitle({ conversation_id, title }) {
  const item = state.list.find((c) => c.id === conversation_id);
  if (item) item.title = title;
  if (state.conv?.id === conversation_id) {
    state.conv.title = title;
    document.title = title;
  }
  renderHistory();
}

function stopStream() {
  state.stream?.controller.abort();
}

// ---------- Ações nas mensagens ----------
function switchBranch(nodeId, dir) {
  const conv = state.conv;
  const node = conv.mapping[nodeId];
  const role = node.message.author.role;
  const siblings = conv.mapping[node.parent].children.filter((id) => conv.mapping[id]?.message?.author?.role === role);
  const target = siblings[siblings.indexOf(nodeId) + dir];
  if (!target) return;
  let leaf = conv.mapping[target];
  while (leaf.children.length && conv.mapping[leaf.children[leaf.children.length - 1]]) {
    leaf = conv.mapping[leaf.children[leaf.children.length - 1]];
  }
  conv.current_node = leaf.id;
  state.error = null;
  renderThread();
  if (conv.id) api(`/api/conversations/${conv.id}`, { method: 'PATCH', body: { current_node: leaf.id } }).catch(() => {});
}

async function setFeedback(nodeId, rating) {
  const conv = state.conv;
  const msg = conv.mapping[nodeId].message;
  const next = msg.metadata?.feedback === rating ? null : rating;
  msg.metadata = { ...msg.metadata, feedback: next || undefined };
  renderThread();
  toast(next ? 'Obrigado pelo seu feedback' : 'Feedback removido');
  try {
    await api(`/api/conversations/${conv.id}/messages/${nodeId}/feedback`, { method: 'POST', body: { rating: next } });
  } catch {
    toast('Não foi possível salvar seu feedback. Tente novamente.', 'error');
  }
}

function speak(id, text, onEnd) {
  stopSpeaking();
  const plain = h('div');
  renderMarkdownInto(plain, text);
  for (const code of plain.querySelectorAll('.code-head')) code.remove();
  const utter = new SpeechSynthesisUtterance(plain.textContent.replace(/\s+/g, ' ').trim());
  utter.lang = document.documentElement.lang || 'pt-BR';
  const done = () => {
    if (state.speakingId !== id) return;
    state.speakingId = null;
    if (state.conv) renderThread();
    onEnd?.();
  };
  utter.onend = done;
  utter.onerror = done;
  state.speakingId = id;
  speechSynthesis.speak(utter);
  if (state.conv) renderThread();
}

function stopSpeaking() {
  if (!('speechSynthesis' in window)) return;
  const was = state.speakingId;
  state.speakingId = null;
  speechSynthesis.cancel();
  if (was && state.conv) renderThread();
}

// ---------- Compositor ----------
function isTouch() {
  return matchMedia('(pointer: coarse)').matches;
}

function autosize() {
  const ta = els.prompt;
  ta.style.height = 'auto';
  let expanded = els.composer.classList.contains('expanded');
  if (!ta.value) expanded = false;
  else if (!expanded && (ta.value.includes('\n') || ta.scrollHeight > 40)) expanded = true;
  els.composer.classList.toggle('expanded', expanded);
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.4)}px`;
  updateScrollButton();
}

function updateComposer() {
  const hasContent = Boolean(els.prompt.value.trim() || state.attachments.length);
  let mode;
  if (state.stream) mode = 'stop';
  else if (hasContent) mode = 'send';
  else if (SpeechRec) mode = 'voice';
  else mode = 'empty';
  const btn = els.sendBtn;
  btn.classList.toggle('active', mode === 'voice' && voice.active);
  if (btn.dataset.state === mode) return;
  btn.dataset.state = mode;
  btn.disabled = mode === 'empty';
  const config = {
    stop: ['stop', 'Parar'],
    send: ['arrowUp', 'Enviar mensagem'],
    voice: ['wave', 'Iniciar modo de voz'],
    empty: ['arrowUp', 'Enviar mensagem'],
  }[mode];
  btn.innerHTML = icon(config[0]);
  btn.setAttribute('aria-label', config[1]);
  btn.title = config[1];
}

function renderAttachments() {
  els.attachments.textContent = '';
  for (const a of state.attachments) els.attachments.append(attachmentView(a, true));
  updateComposer();
  updateScrollButton();
}

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|php|html?|css|scss|less|sql|sh|bash|ps1|bat|ya?ml|toml|ini|cfg|conf|xml|log|env|vue|svelte|swift|dart|lua|r|tex)$/i;

async function addFiles(files) {
  for (const file of files) {
    if (state.attachments.length >= MAX_ATTACHMENTS) {
      toast(`Você pode anexar até ${MAX_ATTACHMENTS} arquivos.`, 'error');
      break;
    }
    try {
      if (file.type.startsWith('image/')) {
        state.attachments.push({ id: uuid(), kind: 'image', name: file.name || 'imagem', size: file.size, dataUrl: await imageToDataUrl(file) });
      } else if ((file.type.startsWith('text/') || /json|xml|javascript|csv|yaml|sql/.test(file.type) || TEXT_EXT.test(file.name)) && file.size <= MAX_TEXT_FILE) {
        const text = await file.text();
        if (text.includes('\u0000')) throw new Error('binário');
        state.attachments.push({ id: uuid(), kind: 'file', name: file.name, size: file.size, text });
      } else {
        toast('Esse tipo ou tamanho de arquivo não é aceito aqui.', 'error');
      }
    } catch {
      toast(file.type.startsWith('image/') ? 'A imagem selecionada é inválida.' : 'Falha ao carregar arquivo.', 'error');
    }
  }
  renderAttachments();
  els.prompt.focus();
}

async function imageToDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return file.type === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.9);
}

// ---------- Voz ----------
function toggleDictation() {
  if (!SpeechRec) return;
  if (dictation) {
    dictation.stop();
    return;
  }
  const rec = new SpeechRec();
  rec.lang = navigator.language || 'pt-BR';
  rec.interimResults = true;
  rec.continuous = true;
  const base = els.prompt.value ? `${els.prompt.value.replace(/\s*$/, '')} ` : '';
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    els.prompt.value = base + finalText + interim;
    autosize();
    updateComposer();
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed') toast('Permita o acesso ao microfone para ditar. Verifique as configurações do navegador ou do dispositivo.', 'error');
    else if (e.error !== 'aborted' && e.error !== 'no-speech') toast('Não foi possível iniciar o ditado. Tente novamente.', 'error');
  };
  rec.onend = () => {
    dictation = null;
    els.dictateBtn.classList.remove('listening');
    els.dictateBtn.setAttribute('aria-label', 'Iniciar ditado');
    els.dictateBtn.title = 'Ditar';
  };
  rec.start();
  dictation = rec;
  els.dictateBtn.classList.add('listening');
  els.dictateBtn.setAttribute('aria-label', 'Concluir ditado');
  els.dictateBtn.title = 'Concluir ditado';
}

// Modo de voz: ouve, envia, lê a resposta em voz alta e volta a ouvir.
function startVoice() {
  if (!SpeechRec || voice.active) return;
  voice.active = true;
  els.voiceBanner.hidden = false;
  updateComposer();
  listenForVoice();
}

function stopVoice() {
  voice.active = false;
  voice.rec?.abort();
  voice.rec = null;
  stopSpeaking();
  els.voiceBanner.hidden = true;
  updateComposer();
}

function listenForVoice() {
  if (!voice.active || state.stream) return;
  const rec = new SpeechRec();
  rec.lang = navigator.language || 'pt-BR';
  rec.interimResults = false;
  rec.continuous = false;
  let heard = false;
  els.voiceStatus.textContent = 'Ouvindo…';
  rec.onresult = (e) => {
    const text = e.results[0]?.[0]?.transcript?.trim();
    if (!text) return;
    heard = true;
    els.voiceStatus.textContent = 'Respondendo…';
    sendMessage({ text, attachments: [], parentId: state.conv?.current_node ?? null });
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed') {
      toast('Permita o acesso ao microfone para usar o modo de voz.', 'error');
      stopVoice();
    }
  };
  rec.onend = () => {
    if (voice.rec === rec) voice.rec = null;
    if (voice.active && !heard && !state.stream) setTimeout(listenForVoice, 200);
  };
  voice.rec = rec;
  rec.start();
}

// ---------- Barra lateral, menus e modais ----------
function toggleSidebar() {
  if (matchMedia('(max-width: 767px)').matches) {
    const open = !els.app.classList.contains('sidebar-open');
    els.app.classList.toggle('sidebar-open', open);
    els.backdrop.hidden = !open;
  } else {
    const collapsed = !els.app.classList.contains('collapsed');
    els.app.classList.toggle('collapsed', collapsed);
    writeStorage('sidebarCollapsed', collapsed);
  }
}

function closeSidebarOnMobile() {
  els.app.classList.remove('sidebar-open');
  els.backdrop.hidden = true;
}

function closeMenus() {
  els.modelMenu.hidden = true;
  els.modelBtn.setAttribute('aria-expanded', 'false');
  els.plusMenu.hidden = true;
  els.plusBtn.setAttribute('aria-expanded', 'false');
  els.chatMenu.hidden = true;
  state.menuConvId = null;
  for (const li of document.querySelectorAll('.history-item.menu-open')) li.classList.remove('menu-open');
}

function renderModels() {
  els.modelList.textContent = '';
  if (!state.models.length) {
    els.modelList.append(h('div', 'menu-label', 'Nenhum modelo encontrado'));
  }
  for (const id of state.models) {
    const item = h('button', 'menu-item');
    item.type = 'button';
    item.dataset.action = 'pick-model';
    item.dataset.model = id;
    item.append(h('span', null, id));
    if (id === state.model) item.insertAdjacentHTML('beforeend', `<span class="check">${icon('check', 18)}</span>`);
    els.modelList.append(item);
  }
  els.modelName.textContent = state.model || '';
}

function openChatMenu(button, id) {
  closeMenus();
  const menu = els.chatMenu;
  menu.hidden = false;
  const r = button.getBoundingClientRect();
  const top = r.bottom + 4 + menu.offsetHeight > innerHeight ? r.top - menu.offsetHeight - 4 : r.bottom + 4;
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.min(r.left, innerWidth - menu.offsetWidth - 8)}px`;
  state.menuConvId = id;
  button.closest('.history-item')?.classList.add('menu-open');
}

async function finishRename(item, value) {
  if (state.renaming !== item.id) return;
  state.renaming = null;
  const title = value?.trim();
  if (title && title !== item.title) {
    item.title = title;
    if (state.conv?.id === item.id) state.conv.title = title;
    try {
      await api(`/api/conversations/${item.id}`, { method: 'PATCH', body: { title } });
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  render();
}

function confirmDialog(title, text, okLabel = 'Excluir') {
  return new Promise((resolve) => {
    els.confirmTitle.textContent = title;
    els.confirmText.textContent = text;
    els.confirmOk.textContent = okLabel;
    els.confirmOk.onclick = () => {
      resolve(true);
      els.confirmModal.close();
    };
    els.confirmModal.onclose = () => resolve(false);
    els.confirmModal.showModal();
  });
}

async function deleteConversation(id) {
  const item = state.list.find((c) => c.id === id);
  const ok = await confirmDialog('Excluir chat?', `Isso vai excluir “${item?.title || DEFAULT_TITLE}”.`);
  if (!ok) return;
  try {
    await api(`/api/conversations/${id}`, { method: 'DELETE' });
    state.list = state.list.filter((c) => c.id !== id);
    if (state.conv?.id === id) showHome();
    else renderHistory();
  } catch (err) {
    toast(err.message, 'error');
  }
}

let searchTimer = 0;
let searchSelected = 0;

function openSearch() {
  closeMenus();
  closeSidebarOnMobile();
  els.searchInput.value = '';
  els.searchModal.showModal();
  runSearch();
}

async function runSearch() {
  const q = els.searchInput.value;
  let items = [];
  try {
    items = (await api(`/api/search?q=${encodeURIComponent(q)}`)).items;
  } catch {}
  if (q !== els.searchInput.value) return;
  els.searchResults.textContent = '';
  searchSelected = 0;
  if (!q.trim()) els.searchResults.append(searchResult({ newChat: true }));
  if (items.length) els.searchResults.append(h('div', 'search-section', q.trim() ? 'Resultados' : 'Recentes'));
  for (const item of items) els.searchResults.append(searchResult(item));
  if (!items.length && q.trim()) els.searchResults.append(h('div', 'search-section', 'Nenhum resultado'));
  highlightSearch();
}

function searchResult(item) {
  const b = h('button', 'search-result');
  b.type = 'button';
  b.dataset.action = item.newChat ? 'search-new' : 'search-open';
  if (!item.newChat) b.dataset.id = item.id;
  b.innerHTML = icon(item.newChat ? 'newChat' : 'temporary');
  const text = h('span');
  text.append(document.createTextNode(item.newChat ? 'Novo chat' : item.title));
  if (item.snippet) text.append(h('small', null, item.snippet));
  b.append(text);
  return b;
}

function highlightSearch() {
  const items = [...els.searchResults.querySelectorAll('.search-result')];
  items.forEach((el, i) => el.classList.toggle('selected', i === searchSelected));
  items[searchSelected]?.scrollIntoView({ block: 'nearest' });
}

function openSettings() {
  closeMenus();
  closeSidebarOnMobile();
  els.themeSelect.value = settings.theme;
  els.instructions.value = settings.instructions;
  const cfg = state.config;
  els.providerInfo.textContent = cfg?.mode === 'demo'
    ? 'Modo demonstração: nenhum modelo configurado. Veja o README para ligar a OpenAI, o Gemini, o Ollama ou outro provedor.'
    : `Conectado a ${cfg?.baseUrl || '?'} · modelo atual: ${state.model || '—'}`;
  els.settingsModal.showModal();
}

// ---------- Eventos ----------
document.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) {
    if (!e.target.closest('.menu')) closeMenus();
    if (e.target === els.composer || e.target.classList?.contains('composer-row')) els.prompt.focus();
    return;
  }
  const action = target.dataset.action;
  const turnId = target.closest('.turn')?.dataset.id;
  const menuConvId = state.menuConvId; // chat cujo menu "⋯" estava aberto
  if (action !== 'chat-more') closeMenus();

  switch (action) {
    case 'toggle-sidebar':
      toggleSidebar();
      break;
    case 'new-chat':
      e.preventDefault();
      newChat();
      break;
    case 'open-search':
      openSearch();
      break;
    case 'open-settings':
      openSettings();
      break;
    case 'toggle-temporary':
      state.temporary = !state.temporary;
      if (state.conv) showHome();
      else render();
      break;
    case 'open-conv':
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      openConversation(target.closest('.history-item').dataset.id);
      break;
    case 'chat-more': {
      const id = target.closest('.history-item').dataset.id;
      if (state.menuConvId === id) closeMenus();
      else openChatMenu(target, id);
      break;
    }
    case 'rename-chat':
      state.renaming = menuConvId;
      renderHistory();
      break;
    case 'delete-chat':
      if (menuConvId) deleteConversation(menuConvId);
      break;
    case 'pick-model':
      state.model = target.dataset.model;
      writeStorage('model', state.model);
      renderModels();
      break;
    case 'attach':
      els.fileInput.click();
      break;
    case 'remove-attachment':
      state.attachments = state.attachments.filter((a) => a.id !== target.dataset.id);
      renderAttachments();
      break;
    case 'copy-code': {
      const code = target.closest('.code-block').querySelector('code').textContent;
      try {
        await navigator.clipboard.writeText(code);
        const label = target.querySelector('span');
        target.querySelector('svg').outerHTML = icon('check', 15);
        label.textContent = 'Copiado';
        setTimeout(() => {
          if (!target.isConnected) return;
          target.querySelector('svg').outerHTML = icon('copy', 15);
          label.textContent = 'Copiar código';
        }, 2000);
      } catch {
        toast('Não foi possível copiar o código. Tente novamente.', 'error');
      }
      break;
    }
    case 'copy-msg': {
      const msg = state.conv.mapping[turnId].message;
      copyText(messageText(msg), msg.author.role === 'user' ? 'Mensagem copiada' : 'Resposta copiada');
      break;
    }
    case 'edit-msg':
      state.editing = turnId;
      renderThread();
      break;
    case 'edit-cancel':
      state.editing = null;
      renderThread();
      break;
    case 'edit-send':
      submitEdit(turnId, target.closest('.edit-box').querySelector('textarea').value);
      break;
    case 'branch-prev':
    case 'branch-next':
      switchBranch(turnId, action === 'branch-prev' ? -1 : 1);
      break;
    case 'feedback-up':
    case 'feedback-down':
      setFeedback(turnId, action === 'feedback-up' ? 'up' : 'down');
      break;
    case 'read-aloud':
      if (state.speakingId === turnId) stopSpeaking();
      else speak(turnId, messageText(state.conv.mapping[turnId].message));
      break;
    case 'regenerate':
      regenerate(state.conv.mapping[turnId].parent);
      break;
    case 'retry-error':
      if (state.error) regenerate(state.error.parentId);
      break;
    case 'toggle-reasoning':
      target.closest('.reasoning').classList.toggle('open');
      break;
    case 'open-image': {
      const blob = await (await fetch(target.src)).blob();
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
      break;
    }
    case 'close-modal':
      target.closest('dialog')?.close();
      break;
    case 'search-new':
      els.searchModal.close();
      newChat();
      break;
    case 'search-open':
      els.searchModal.close();
      openConversation(target.dataset.id);
      break;
    case 'save-instructions':
      settings.instructions = els.instructions.value.trim();
      writeStorage('settings', settings);
      toast('Instruções salvas');
      break;
    case 'import':
      els.importInput.click();
      break;
    case 'delete-all': {
      els.settingsModal.close();
      const ok = await confirmDialog('Excluir todos os chats?', 'Isso vai excluir todas as conversas salvas neste computador.', 'Excluir tudo');
      if (!ok) break;
      await api('/api/conversations', { method: 'DELETE' });
      state.list = [];
      showHome();
      break;
    }
    case 'stop-voice':
      stopVoice();
      break;
  }
});

els.modelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = els.modelMenu.hidden;
  closeMenus();
  els.modelMenu.hidden = !open;
  els.modelBtn.setAttribute('aria-expanded', String(open));
});

els.plusBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = els.plusMenu.hidden;
  closeMenus();
  els.plusMenu.hidden = !open;
  els.plusBtn.setAttribute('aria-expanded', String(open));
});

els.dictateBtn.addEventListener('click', toggleDictation);
if (!SpeechRec) els.dictateBtn.hidden = true;

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const mode = els.sendBtn.dataset.state;
  if (mode === 'stop') stopStream();
  else if (mode === 'send') submitPrompt();
  else if (mode === 'voice') (voice.active ? stopVoice() : startVoice());
});

els.prompt.addEventListener('input', () => {
  autosize();
  updateComposer();
});

els.prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch()) {
    e.preventDefault();
    if (!state.stream) submitPrompt();
  }
});

els.prompt.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

els.fileInput.addEventListener('change', () => {
  addFiles([...els.fileInput.files]);
  els.fileInput.value = '';
});

let dragDepth = 0;
const content = $('#content');
content.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth += 1;
  els.dropOverlay.hidden = false;
});
content.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.dropOverlay.hidden = true;
});
content.addEventListener('dragover', (e) => {
  if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
});
content.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
});

els.scroller.addEventListener('scroll', () => {
  pinned = nearBottom();
  updateScrollButton();
});
els.scrollDown.addEventListener('click', () => scrollToBottom(true));

els.searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 150);
});
els.searchInput.addEventListener('keydown', (e) => {
  const items = els.searchResults.querySelectorAll('.search-result');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    searchSelected = (searchSelected + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(items.length, 1);
    highlightSearch();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    items[searchSelected]?.click();
  }
});

els.themeSelect.addEventListener('change', () => {
  settings.theme = els.themeSelect.value;
  writeStorage('settings', settings);
  applyTheme();
});

els.importInput.addEventListener('change', async () => {
  const file = els.importInput.files[0];
  els.importInput.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const { imported } = await api('/api/import', { method: 'POST', body: data });
    state.list = (await api('/api/conversations')).items;
    renderHistory();
    toast(imported === 1 ? '1 conversa importada' : `${imported} conversas importadas`);
  } catch (err) {
    toast(`Não foi possível importar: ${err.message}`, 'error');
  }
});

// Clique no fundo escuro fecha o modal.
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
}

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && e.shiftKey && key === 'o') {
    e.preventDefault();
    newChat();
  } else if (mod && !e.shiftKey && key === 'k') {
    e.preventDefault();
    openSearch();
  } else if (mod && e.shiftKey && key === 's') {
    e.preventDefault();
    toggleSidebar();
  } else if (e.shiftKey && e.key === 'Escape') {
    e.preventDefault();
    els.prompt.focus();
  } else if (e.key === 'Escape') {
    closeMenus();
    if (voice.active) stopVoice();
  }
});

window.addEventListener('popstate', route);
window.addEventListener('resize', () => {
  autosize();
  updateScrollButton();
});

// ---------- Início ----------
async function init() {
  hydrateIcons();
  for (const el of document.querySelectorAll('[data-tip]')) el.title = el.dataset.tip;
  applyTheme();
  if (readStorage('sidebarCollapsed', false)) els.app.classList.add('collapsed');
  updateComposer();

  try {
    const [config, models, list] = await Promise.all([
      api('/api/config'),
      api('/api/models').catch(() => ({ models: [] })),
      api('/api/conversations'),
    ]);
    state.config = config;
    state.models = models.models || [];
    if (!state.model || !state.models.includes(state.model)) state.model = config.defaultModel || state.models[0] || null;
    state.list = list.items;
    applyAppName(config.appName || 'ChatGPT');
  } catch (err) {
    toast(`Não foi possível falar com o servidor: ${err.message}`, 'error');
  }
  renderModels();
  await route();
  els.prompt.focus();
}

init();
