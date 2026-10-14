# Análise REA do ChatGPT (chatgpt.com)

Data: 2026-10-14 · Ferramenta: REA (`rea-agents` 6.4.0) · Alvo: `https://chatgpt.com/` aberto
sem login num Chrome isolado (perfil temporário, CDP só em `127.0.0.1:9222`).

Não há app desktop do ChatGPT instalado nesta máquina (só o OpenAI Codex), então o alvo
foi a versão web. Nada foi enviado ao ChatGPT: a análise é passiva (DOM, acessibilidade,
screenshot e leitura estática dos scripts que a página já tinha carregado).

## Evidências

| Evidence ID | Operação | O que contém |
|---|---|---|
| `ev_b384d7dc…8168` | `list_browser_targets` | Página `https://chatgpt.com/`, título "ChatGPT: Chat, Work, Create & Code with AI" |
| `ev_206a0eaf…3233` | `inspect_web_page` | DOM (2386 nós), árvore de acessibilidade (241 nós), 222 scripts, storage vazio |
| `ev_b62857e5…8835` | `capture_web_screenshot` | Viewport 1424×805 da tela inicial (modo escuro) |
| `ev_8c036a7d…ec0fab` | `analyze_web_bundle` | 218 scripts, grafo de chunks (651 arestas), runtime inferido: **Vite** (confiança média) |
| `ev_38ad4776…3483` | `inspect_web_page` (com fontes) | Bytes dos scripts para exportação |
| `ev_75207f9c…8729` | `export_web_scripts` | 218 scripts exportados e verificados por SHA-256 |

## Observado (fatos)

**Layout da tela inicial** (acessibilidade + screenshot):

- `main "ChatGPT"` com três partes: barra lateral (`complementary "Barra lateral"`),
  cabeçalho e área da conversa.
- Barra lateral, 260 px de largura, borda direita `#262626`:
  logotipo/nome "ChatGPT", botão "Fechar barra lateral", link "Novo chat",
  navegação com "Imagens", "Plugins", "Investigação", "Confira planos e preços",
  "Ajuda", "Configurações"; no rodapé, um cartão "Receba respostas personalizadas
  para você" com botão "Entrar".
- Cabeçalho: botão "ChatGPT ▾" (`hasPopup: dialog`, seletor de modelo) à esquerda;
  "Entrar" (fundo branco) e "Cadastre-se grátis" (fundo `#212121`) à direita.
- Centro: título `h1` "Por onde começamos?" e um `form` com o compositor:
  botão "Adicionar arquivos e mais" (+), `textbox` "Chat com o ChatGPT"
  (placeholder "Pergunte ao ChatGPT"), "Iniciar ditado" (microfone) e
  "Iniciar modo de voz".
- Compositor: pílula de 768 px × ~52 px, fundo `#212121`, centrada.
- Rodapé: aviso de termos/privacidade em texto pequeno.
- Cores (amostradas do screenshot): fundo `#000000`, superfície `#212121`,
  bordas `#262626`, botão desativado `#414141`, texto `#ffffff`.
- Itens da barra lateral espaçados a cada 36 px.

**Formato da mensagem enviada** (script exportado, função de envio):

```js
{ action: "next", conversation_id, parent_message_id, model,
  history_and_training_disabled /* chat temporário */,
  messages: [{ id, author: { role: "user" },
               content: { content_type: "text", parts: [texto] },
               create_time, metadata: {} }] }
```

As mensagens formam uma árvore (`parent_message_id`), o que permite editar e
gerar a resposta de novo criando ramos. Rotas vistas no bundle: `/conversation`,
`/conversation/prepare`, `/conversation/resume`, `/stop_conversation`,
`/conversations`, `/f/steer_turn`. A resposta chega em streaming
(`ReadableStream.getReader()`).

**Textos da interface** (catálogo `pt-BR-*.js`, 866 entradas). Os mais usados aqui:
"Novo chat", "Pergunte ao ChatGPT", "Enviar mensagem", "Pensando", "Copiar",
"Copiar código", "Copiado", "Boa resposta", "Resposta ruim", "Ler em voz alta",
"Parar", "Tentar novamente", "Gerar resposta novamente", "Resposta interrompida",
"Compartilhar", "Hoje", "Ontem", "Idioma", e o aviso
"O ChatGPT pode cometer erros. Confira informações importantes.".

## Inferido

- O frontend é um SPA servido por Vite (`unauth-mweb/assets/*.js`), com textos
  carregados por idioma.
- A tela vista é a versão sem login ("lightweight web"); a versão com login tem
  histórico de chats na barra lateral.

## Verificação do clone

| Evidence ID | Operação | Resultado |
|---|---|---|
| `ev_124e5d79…bde1` | `capture_web_screenshot` | Tela inicial do clone, mesma viewport 1424×805 |

Comparando pixel a pixel com o screenshot original (`ev_b62857e5…8835`):

- compositor no mesmo lugar: x 459–1224 (original 460–1223), topo em y = 417 nos dois;
- título "Por onde começamos?" na mesma faixa vertical (y 345–368, original 345–367);
- 3,8% dos pixels diferentes, quase todos nos elementos de conta que o clone não tem
  ("Entrar", "Cadastre-se grátis", cartão de login, links de planos e ajuda).

Um teste ponta a ponta (CDP no mesmo Chrome) passou nos 17 casos: envio com streaming,
markdown, tabela e código, título automático, gerar de novo (2/2), voltar ao ramo 1/2,
editar mensagem (ramo do usuário), persistência ao recarregar, feedback, parar no meio,
renomear, buscar pelo conteúdo, chat temporário fora do histórico e excluir.

## Não observado (decisões de projeto no clone)

- **A tela de uma conversa com mensagens não foi capturada.** Isso exigiria enviar
  uma mensagem ao ChatGPT, e eu não fiz isso. O visual das mensagens (balão do
  usuário à direita, resposta em markdown, ações embaixo) segue o padrão conhecido
  do ChatGPT e os rótulos acima, mas é uma escolha de projeto.
- O formato exato do stream SSE da OpenAI não foi lido: o clone usa um protocolo
  SSE próprio e mais simples.
- O tema claro não foi observado (o Chrome abriu no escuro); as cores claras são
  escolha de projeto.
- O modelo de IA em si não pode ser copiado: o clone conversa com qualquer API
  compatível com a da OpenAI (OpenAI, Google Gemini, Ollama, LM Studio, OpenRouter…).
