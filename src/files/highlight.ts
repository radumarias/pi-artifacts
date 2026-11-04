import type { HLJSApi, LanguageFn } from "highlight.js";

type Loader = () => Promise<{ default: LanguageFn }>;

/** The grammars the preview highlights with, each loaded the first time a file needs it, so the app's bundle carries none. */
const GRAMMARS: Record<string, Loader> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  go: () => import("highlight.js/lib/languages/go"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  latex: () => import("highlight.js/lib/languages/latex"),
  less: () => import("highlight.js/lib/languages/less"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  php: () => import("highlight.js/lib/languages/php"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  python: () => import("highlight.js/lib/languages/python"),
  r: () => import("highlight.js/lib/languages/r"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scala: () => import("highlight.js/lib/languages/scala"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

/** File extensions and the names fenced code blocks give (```py), as the grammar each is highlighted with. */
const ALIASES: Record<string, string> = {
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  h: "c",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  patch: "diff",
  gql: "graphql",
  toml: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  jsblock: "javascript",
  ipynb: "json",
  jsonl: "json",
  geojson: "json",
  kt: "kotlin",
  kts: "kotlin",
  tex: "latex",
  mk: "makefile",
  md: "markdown",
  mdx: "markdown",
  ps1: "powershell",
  py: "python",
  pyi: "python",
  rb: "ruby",
  rs: "rust",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  html: "xml",
  htm: "xml",
  htmlpart: "xml",
  svg: "xml",
  rss: "xml",
  plist: "xml",
  vue: "xml",
  svelte: "xml",
  yml: "yaml",
};

/** The grammar a file extension or a code block's language name is highlighted with, if the preview has one. */
export function grammarFor(name: string): string | undefined {
  const lower = name.toLowerCase();
  const grammar = Object.hasOwn(ALIASES, lower) ? ALIASES[lower] : lower;
  return Object.hasOwn(GRAMMARS, grammar) ? grammar : undefined;
}

let core: Promise<HLJSApi> | undefined;
const registered = new Map<string, Promise<void>>();

/** Grammars that colour others' code inside theirs once those are loaded: a web page's scripts and styles. */
const EMBEDDED: Record<string, readonly string[]> = { xml: ["javascript", "css"] };

/** Loads and registers `grammar` once. */
function register(hljs: HLJSApi, grammar: string): Promise<void> {
  let ready = registered.get(grammar);
  if (!ready) {
    ready = GRAMMARS[grammar]().then((module) => hljs.registerLanguage(grammar, module.default));
    registered.set(grammar, ready);
    // A failed load (the network dropped) may be tried again next time.
    ready.catch(() => registered.delete(grammar));
  }
  return ready;
}

/**
 * `code` as highlight.js HTML in `grammar` (from grammarFor): spans with hljs-* classes around the code's own text,
 * which highlight.js escapes, so the HTML holds no markup of the file's.
 */
export async function highlight(code: string, grammar: string): Promise<string> {
  if (!core) {
    core = import("highlight.js/lib/core").then((module) => module.default);
    // As with a grammar, a failed load may be tried again next time.
    core.catch(() => (core = undefined));
  }
  const hljs = await core;
  const embedded = /<(script|style)\b/i.test(code) ? (EMBEDDED[grammar] ?? []) : [];
  await Promise.all([grammar, ...embedded].map((name) => register(hljs, name)));
  return hljs.highlight(code, { language: grammar, ignoreIllegals: true }).value;
}
