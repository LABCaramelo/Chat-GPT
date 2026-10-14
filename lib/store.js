// Conversas guardadas no mesmo formato do export do ChatGPT (conversations.json):
// cada conversa tem um `mapping` de nós { id, message, parent, children } e um
// `current_node`. Editar uma mensagem ou gerar a resposta de novo cria um ramo.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_TITLE = 'Novo chat';

const now = () => Date.now() / 1000;

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'conversations.json');
    this.convs = new Map();
    this.temp = new Map(); // chats temporários: só em memória, nunca vão para o disco
    this.writing = Promise.resolve();
    this.saveTimer = null;
  }

  async load() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      for (const c of raw) this.convs.set(c.id, c);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  list() {
    return [...this.convs.values()]
      .filter((c) => hasMessages(c))
      .map(({ id, title, create_time, update_time }) => ({ id, title, create_time, update_time }))
      .sort((a, b) => b.update_time - a.update_time);
  }

  get(id) {
    return this.convs.get(id) || this.temp.get(id) || null;
  }

  create({ temporary = false } = {}) {
    const rootId = randomUUID();
    const conv = {
      id: randomUUID(),
      title: DEFAULT_TITLE,
      create_time: now(),
      update_time: now(),
      temporary: Boolean(temporary),
      current_node: rootId,
      mapping: { [rootId]: { id: rootId, message: null, parent: null, children: [] } },
    };
    (conv.temporary ? this.temp : this.convs).set(conv.id, conv);
    return conv;
  }

  rootId(conv) {
    return Object.values(conv.mapping).find((n) => !n.parent)?.id;
  }

  addMessage(conv, parentId, message) {
    const parent = conv.mapping[parentId];
    if (!parent) throw new Error('Mensagem pai não encontrada');
    conv.mapping[message.id] = { id: message.id, message, parent: parentId, children: [] };
    parent.children.push(message.id);
    conv.current_node = message.id;
    this.touch(conv);
  }

  // Mensagens da raiz até `nodeId`, na ordem da conversa.
  path(conv, nodeId) {
    const out = [];
    let node = conv.mapping[nodeId];
    while (node) {
      if (node.message) out.push(node.message);
      node = node.parent ? conv.mapping[node.parent] : null;
    }
    return out.reverse();
  }

  setCurrent(conv, nodeId) {
    if (!conv.mapping[nodeId]) return false;
    conv.current_node = nodeId;
    this.save(conv);
    return true;
  }

  rename(conv, title) {
    conv.title = String(title).trim().slice(0, 200) || DEFAULT_TITLE;
    this.touch(conv);
  }

  setFeedback(conv, messageId, rating) {
    const msg = conv.mapping[messageId]?.message;
    if (!msg) return false;
    msg.metadata = { ...msg.metadata, feedback: rating || undefined };
    this.save(conv);
    return true;
  }

  delete(id) {
    const existed = this.convs.delete(id) || this.temp.delete(id);
    if (existed) this.save();
    return existed;
  }

  deleteAll() {
    this.convs.clear();
    this.save();
  }

  search(query, limit = 30) {
    const q = query.trim().toLowerCase();
    if (!q) return this.list().slice(0, limit);
    const results = [];
    for (const conv of this.convs.values()) {
      if (!hasMessages(conv)) continue;
      let snippet = '';
      const inTitle = conv.title.toLowerCase().includes(q);
      for (const node of Object.values(conv.mapping)) {
        const text = messageText(node.message);
        const at = text.toLowerCase().indexOf(q);
        if (at >= 0) {
          snippet = (at > 40 ? '…' : '') + text.slice(Math.max(0, at - 40), at + 80).replace(/\s+/g, ' ');
          break;
        }
      }
      if (inTitle || snippet) {
        results.push({ id: conv.id, title: conv.title, update_time: conv.update_time, snippet });
      }
    }
    return results.sort((a, b) => b.update_time - a.update_time).slice(0, limit);
  }

  // Aceita o conversations.json do export de dados do ChatGPT.
  import(list) {
    if (!Array.isArray(list)) throw new Error('O arquivo deve conter uma lista de conversas');
    let imported = 0;
    for (const item of list) {
      if (!item || typeof item.mapping !== 'object' || !item.mapping) continue;
      const id = String(item.id || item.conversation_id || randomUUID());
      if (this.convs.has(id)) continue;
      const mapping = {};
      for (const [key, node] of Object.entries(item.mapping)) {
        mapping[key] = {
          id: node.id || key,
          message: node.message || null,
          parent: node.parent || null,
          children: Array.isArray(node.children) ? node.children : [],
        };
      }
      const current = item.current_node && mapping[item.current_node] ? item.current_node : null;
      const conv = {
        id,
        title: item.title || DEFAULT_TITLE,
        create_time: item.create_time || now(),
        update_time: item.update_time || item.create_time || now(),
        temporary: false,
        current_node: current || deepestLeaf(mapping),
        mapping,
      };
      this.convs.set(id, conv);
      imported += 1;
    }
    this.save();
    return imported;
  }

  exportAll() {
    return [...this.convs.values()];
  }

  touch(conv) {
    conv.update_time = now();
    this.save(conv);
  }

  // Grava com atraso curto e em série, para não escrever o arquivo a cada token.
  save(conv) {
    if (conv?.temporary) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.writing = this.writing.then(() => this.flush()).catch((err) => {
        console.error('Falha ao salvar conversas:', err);
      });
    }, 150);
  }

  async flush() {
    await fsp.mkdir(this.dir, { recursive: true });
    const data = JSON.stringify([...this.convs.values()].filter(hasMessages));
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, data, 'utf8');
    try {
      await fsp.rename(tmp, this.file);
    } catch {
      // No Windows a troca pode falhar se outro processo estiver lendo o arquivo.
      await fsp.writeFile(this.file, data, 'utf8');
      await fsp.rm(tmp, { force: true });
    }
  }
}

export function messageText(message) {
  const parts = message?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.filter((p) => typeof p === 'string').join('\n');
}

function hasMessages(conv) {
  return Object.values(conv.mapping).some((n) => n.message && n.message.author?.role !== 'system');
}

function deepestLeaf(mapping) {
  const root = Object.values(mapping).find((n) => !n.parent);
  let node = root;
  while (node && node.children.length) node = mapping[node.children[node.children.length - 1]];
  return node?.id || root?.id;
}
