# Clone do ChatGPT

Recriação do ChatGPT web feita a partir de uma análise com o **REA** (reverse engineering
agent) da página real do chatgpt.com. O que foi observado, o que foi inferido e o que é
escolha de projeto está em [docs/ANALISE-REA.md](docs/ANALISE-REA.md).

Não precisa de `npm install`: só Node.js 20.12 ou mais novo.

```bash
node server.js
```

Abra http://localhost:3000.

## Ligar um modelo de IA

Sem configuração, o clone roda em **modo demonstração** (respostas fixas, para testar a
interface). Para respostas de verdade, copie `.env.example` para `.env`, escolha um
provedor e reinicie o servidor:

| Provedor | `.env` |
|---|---|
| OpenAI | `OPENAI_API_KEY=sk-...` |
| Google Gemini (tem cota grátis) | `GEMINI_API_KEY=...` (chave do [Google AI Studio](https://aistudio.google.com/apikey)) |
| Ollama (local, grátis) | `OPENAI_BASE_URL=http://localhost:11434/v1` |
| LM Studio (local) | `OPENAI_BASE_URL=http://localhost:1234/v1` |
| OpenRouter / Groq / outros | `OPENAI_BASE_URL=...` e `OPENAI_API_KEY=...` |

Qualquer API compatível com `/v1/chat/completions` da OpenAI funciona. Os modelos
aparecem no seletor "ChatGPT ▾" no topo; use `OPENAI_MODEL` para escolher o padrão e
`OPENAI_MODELS=a,b,c` para limitar a lista.

Se o modelo escolhido estiver sobrecarregado, sem cota ou não existir mais, o servidor
tenta os modelos de `OPENAI_FALLBACK_MODELS=a,b`, em ordem, e a resposta mostra qual
modelo respondeu. Modelos que a API diz não existirem somem do seletor até reiniciar o
servidor.

No Gemini, o padrão e a reserva são `gemini-flash-latest` e `gemini-flash-lite-latest`,
apelidos que o Google mantém apontando para os modelos mais novos. A lista de modelos
do Gemini ainda traz versões antigas (como `gemini-2.5-flash`) que dão erro para chaves
novas, e os modelos Pro não têm cota grátis.

## O que tem

- Tela inicial "Por onde começamos?" com o mesmo layout e cores do chatgpt.com (escuro)
  e um tema claro.
- Respostas em streaming, com markdown, tabelas, blocos de código com realce de sintaxe
  e botão "Copiar código".
- Ações em cada resposta: copiar, boa/ruim, ler em voz alta e tentar novamente.
- Editar uma mensagem ou gerar a resposta de novo cria um **ramo** da conversa; as setas
  ‹ 1/2 › alternam entre as versões, como no ChatGPT.
- Parar a resposta no meio; o texto parcial fica salvo.
- Histórico na barra lateral, com título gerado automaticamente, renomear e excluir.
- Busca nos chats (Ctrl+K), pelo título e pelo conteúdo.
- Chat temporário (não vai para o histórico).
- Anexos: imagens (para modelos com visão) e arquivos de texto/código, por botão, colar
  ou arrastar.
- Ditado pelo microfone e um modo de voz simples (ouve, responde e lê em voz alta),
  onde o navegador oferece reconhecimento de fala (Chrome, Edge).
- Raciocínio "Pensou por Xs" para modelos que enviam o raciocínio no stream.
- Instruções personalizadas, tema, exportar chats e **importar o `conversations.json`
  do export de dados do ChatGPT** (Configurações).
- Atalhos: Ctrl+Shift+O (novo chat), Ctrl+K (buscar), Ctrl+Shift+S (barra lateral),
  Shift+Esc (focar a caixa de texto).
- Layout de celular com barra lateral deslizante.

As conversas ficam em `data/conversations.json`, no mesmo formato do export do ChatGPT
(`mapping` com nós `parent`/`children` e `current_node`).

## Estrutura

```
server.js          servidor HTTP, API de conversas e stream SSE
lib/llm.js         cliente para APIs compatíveis com a da OpenAI (e Gemini) + modo demonstração
lib/store.js       armazenamento das conversas (árvore de mensagens)
public/            interface (HTML, CSS e JavaScript sem build)
public/vendor/     marked (markdown) e DOMPurify (sanitização), copiados dos pacotes npm
docs/ANALISE-REA.md  evidências do REA e decisões de projeto
```

O servidor escuta só em `127.0.0.1` por padrão. Não há login: não exponha na internet
sem colocar autenticação na frente.
