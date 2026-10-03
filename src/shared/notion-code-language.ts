/**
 * Normalize a code-fence language to a value Notion's API will accept.
 *
 * Notion's `code` block `language` field is a strict enum. Pushing any other value
 * (a bare ```` ```txt ````, ```` ```text ````, ```` ```sh ````, or any unlisted
 * token) returns a 400 "body.children[N].code.language should be ..." and, because
 * the block-differ treats a failed insert as a failed operation, the WHOLE file's
 * push fails and the block never lands. ```` ```txt ```` is one of the most common
 * fences in Markdown/Obsidian, so this hit real users pushing code blocks.
 *
 * The pull side never needs this (Notion only ever returns valid values); it is a
 * push-only sanitizer. Unknown languages degrade to "plain text" rather than
 * failing the push - a plain code block is the correct, lossless fallback.
 */

/** The exact set Notion's API accepts for `code.language` (Notion API 2025-09-03). */
const NOTION_CODE_LANGUAGES = new Set<string>([
  'abap',
  'abc',
  'agda',
  'arduino',
  'ascii art',
  'assembly',
  'bash',
  'basic',
  'bnf',
  'c',
  'c#',
  'c++',
  'clojure',
  'coffeescript',
  'coq',
  'css',
  'dart',
  'dhall',
  'diff',
  'docker',
  'ebnf',
  'elixir',
  'elm',
  'erlang',
  'f#',
  'flow',
  'fortran',
  'gherkin',
  'glsl',
  'go',
  'graphql',
  'groovy',
  'haskell',
  'hcl',
  'html',
  'idris',
  'java',
  'javascript',
  'json',
  'julia',
  'kotlin',
  'latex',
  'less',
  'lisp',
  'livescript',
  'llvm ir',
  'lua',
  'makefile',
  'markdown',
  'markup',
  'matlab',
  'mathematica',
  'mermaid',
  'nix',
  'notion formula',
  'objective-c',
  'ocaml',
  'pascal',
  'perl',
  'php',
  'plain text',
  'powershell',
  'prolog',
  'protobuf',
  'purescript',
  'python',
  'r',
  'racket',
  'reason',
  'ruby',
  'rust',
  'sass',
  'scala',
  'scheme',
  'scss',
  'shell',
  'smalltalk',
  'solidity',
  'sql',
  'swift',
  'toml',
  'typescript',
  'vb.net',
  'verilog',
  'vhdl',
  'visual basic',
  'webassembly',
  'xml',
  'yaml',
  'java/c/c++/c#',
]);

/** Common fence tokens that are not Notion's spelling, mapped to the value it accepts. */
const CODE_LANGUAGE_ALIASES: Record<string, string> = {
  txt: 'plain text',
  text: 'plain text',
  plain: 'plain text',
  plaintext: 'plain text',
  none: 'plain text',
  sh: 'shell',
  zsh: 'shell',
  console: 'shell',
  shellscript: 'shell',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  py3: 'python',
  python3: 'python',
  rb: 'ruby',
  yml: 'yaml',
  md: 'markdown',
  tex: 'latex',
  golang: 'go',
  rs: 'rust',
  kt: 'kotlin',
  cs: 'c#',
  cpp: 'c++',
  objc: 'objective-c',
  'obj-c': 'objective-c',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  dockerfile: 'docker',
  htm: 'html',
  vb: 'visual basic',
  vbnet: 'vb.net',
  wasm: 'webassembly',
  proto: 'protobuf',
  gql: 'graphql',
};

/**
 * Map a code-fence language token to a Notion-accepted `code.language` value.
 * Unknown tokens fall back to "plain text" so a push never fails on the language.
 */
export function normalizeNotionCodeLanguage(language: string | undefined | null): string {
  const raw = (language ?? '').trim().toLowerCase();
  if (!raw) return 'plain text';
  if (NOTION_CODE_LANGUAGES.has(raw)) return raw;
  return CODE_LANGUAGE_ALIASES[raw] ?? 'plain text';
}

/** True if `language` is a value Notion's API accepts for `code.language` verbatim. */
export function isNotionCodeLanguage(language: string | undefined | null): boolean {
  return !!language && NOTION_CODE_LANGUAGES.has(language);
}
