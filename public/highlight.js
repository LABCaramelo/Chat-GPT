// Realce de sintaxe leve, sem dependências. Cobre as linguagens mais comuns
// nas respostas (comentários, strings, números, palavras-chave, tags e chaves)
// e devolve HTML escapado com as classes .hljs-* usadas em styles.css.

const C_COMMENT = String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`;
const HASH_COMMENT = String.raw`#[^\n]*`;
const DQ = String.raw`"(?:[^"\\\n]|\\.)*"?`;
const SQ = String.raw`'(?:[^'\\\n]|\\.)*'?`;
const BT = String.raw`\x60(?:[^\x60\\]|\\.)*\x60?`;
const TRIPLE = String.raw`"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)`;
const NUMBER = String.raw`\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)[a-zA-Z]*\b`;
const WORD = String.raw`[A-Za-z_$][\w$]*`;

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

const LITERALS = words('true false null undefined nil None True False NaN Infinity self this');

const FAMILIES = {
  js: {
    comment: C_COMMENT,
    strings: [BT, DQ, SQ],
    keywords: words(`break case catch class const continue debugger default delete do else export extends finally for from
      function if import in instanceof let new of return static super switch throw try typeof var void while with yield
      async await get set interface type enum implements declare readonly public private protected abstract as satisfies
      namespace keyof infer is`),
  },
  py: {
    comment: HASH_COMMENT,
    strings: [TRIPLE, DQ, SQ],
    keywords: words(`and as assert async await break class continue def del elif else except finally for from global if
      import in is lambda nonlocal not or pass raise return try while with yield match case print len range self`),
    extra: [['meta', String.raw`@[\w.]+`]],
  },
  c: {
    comment: C_COMMENT,
    strings: [BT, DQ, SQ],
    keywords: words(`auto break case catch char class const continue default delete do double else enum explicit extern
      final float for friend goto if inline int long namespace new operator override private protected public register
      return short signed sizeof static struct switch template throw try typedef typename union unsigned using virtual
      void volatile while bool string var let fn func fun impl mut pub use mod crate trait where match loop move ref
      package import interface extends implements abstract synchronized throws instanceof go defer chan select map range
      type struct val when object data sealed companion lateinit suspend guard protocol extension init deinit echo
      function foreach elseif endif require include namespace readonly async await`),
  },
  sh: {
    comment: HASH_COMMENT,
    strings: [DQ, SQ],
    keywords: words(`if then else elif fi for while until do done case esac in function return local export source alias
      echo cd ls cat grep sed awk curl wget sudo apt npm npx node git pip python docker set unset exit read printf
      param foreach Write-Host Get-ChildItem Set-Location New-Item Remove-Item`),
    extra: [['variable', String.raw`\$\{[^}\n]*\}|\$[\w@#?*!-]+`]],
  },
  sql: {
    comment: String.raw`--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`,
    strings: [SQ, DQ],
    keywords: words(`select from where and or not insert into values update set delete create table drop alter add
      column primary key foreign references index join left right inner outer full on as group by order having limit
      offset distinct union all case when then else end null is in like between exists count sum avg min max default
      unique constraint view returning with asc desc`),
    caseInsensitive: true,
  },
  json: {
    strings: [DQ],
    keywords: words(''),
    keyPattern: String.raw`"(?:[^"\\\n]|\\.)*"(?=\s*:)`,
  },
  yaml: {
    comment: HASH_COMMENT,
    strings: [DQ, SQ],
    keywords: words(''),
    keyPattern: String.raw`^[ \t-]*[\w.\-"']+(?=\s*[:=])`,
  },
  css: {
    comment: String.raw`\/\*[\s\S]*?(?:\*\/|$)`,
    strings: [DQ, SQ],
    keywords: words('important'),
    keyPattern: String.raw`[\w-]+(?=\s*:[^:{]*[;}\n])`,
    extra: [
      ['keyword', String.raw`@[\w-]+`],
      ['number', String.raw`#[\da-fA-F]{3,8}\b`],
    ],
  },
  html: {
    comment: String.raw`<!--[\s\S]*?(?:-->|$)`,
    strings: [DQ, SQ],
    keywords: words(''),
    markup: true,
  },
};

const ALIASES = {
  js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', typescript: 'js', tsx: 'js', node: 'js',
  py: 'py', python: 'py', python3: 'py', ruby: 'py', rb: 'py', r: 'py',
  c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', hpp: 'c', cs: 'c', csharp: 'c', java: 'c', go: 'c', golang: 'c',
  rust: 'c', rs: 'c', kotlin: 'c', kt: 'c', swift: 'c', php: 'c', dart: 'c', scala: 'c', zig: 'c', solidity: 'c',
  sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', terminal: 'sh', powershell: 'sh', ps1: 'sh', ps: 'sh',
  bat: 'sh', cmd: 'sh', dockerfile: 'sh', docker: 'sh', makefile: 'sh', make: 'sh',
  sql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql', plsql: 'sql',
  json: 'json', jsonc: 'json', json5: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml', env: 'yaml', dotenv: 'yaml', properties: 'yaml',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  html: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html', xhtml: 'html',
};

const cache = new Map();

function compile(name) {
  if (cache.has(name)) return cache.get(name);
  const def = FAMILIES[name];
  const rules = [];
  if (def.comment) rules.push(['comment', def.comment]);
  if (def.markup) {
    rules.push(['tag', String.raw`<\/?[A-Za-z][\w:-]*|\/?>`]);
    rules.push(['attr', String.raw`[A-Za-z_:][\w:.-]*(?=\s*=)`]);
  }
  if (def.keyPattern) rules.push(['attr', def.keyPattern]);
  for (const s of def.strings) rules.push(['string', s]);
  for (const [cls, re] of def.extra || []) rules.push([cls, re]);
  if (!def.markup) {
    rules.push(['number', NUMBER]);
    rules.push(['word', WORD]);
  }
  const regex = new RegExp(rules.map(([, re]) => `(${re})`).join('|'), 'gm');
  const compiled = { def, regex, classes: rules.map(([cls]) => cls) };
  cache.set(name, compiled);
  return compiled;
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const span = (cls, text) => `<span class="hljs-${cls}">${escapeHtml(text)}</span>`;

export function supports(lang) {
  return Boolean(ALIASES[(lang || '').toLowerCase()]);
}

export function highlight(code, lang) {
  const name = ALIASES[(lang || '').toLowerCase()];
  if (!name) return escapeHtml(code);
  const { def, regex, classes } = compile(name);
  let out = '';
  let last = 0;
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(code))) {
    if (!m[0]) {
      regex.lastIndex += 1;
      continue;
    }
    out += escapeHtml(code.slice(last, m.index));
    const group = m.findIndex((g, i) => i > 0 && g !== undefined) - 1;
    const cls = classes[group];
    const text = m[0];
    if (cls === 'word') {
      const key = def.caseInsensitive ? text.toLowerCase() : text;
      const next = code.slice(regex.lastIndex).match(/^\s*(.)/)?.[1];
      if (def.keywords.has(key)) out += span('keyword', text);
      else if (LITERALS.has(text)) out += span('literal', text);
      else if (next === '(') out += span('title function_', text);
      else if (name !== 'sql' && /^[A-Z][a-z]/.test(text)) out += span('title class_', text);
      else out += escapeHtml(text);
    } else {
      out += span(cls === 'tag' ? 'tag' : cls, text);
    }
    last = regex.lastIndex;
  }
  return out + escapeHtml(code.slice(last));
}
