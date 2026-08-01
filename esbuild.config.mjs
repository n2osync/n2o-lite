import esbuild from "esbuild";
import process from "process";
import { builtinModules as builtins } from "node:module";
import { copyFileSync, writeFileSync, readFileSync, readdirSync, statSync } from "fs";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Renderer fingerprint (#1628): a hash of every source file that can shape
 * pull output, injected as __N2O_RENDERER_VERSION__. Sync records store the
 * fingerprint that produced each note; a mismatch on the next sync re-renders
 * the note, so renderer fixes reach already-synced vaults instead of waiting
 * for the Notion page to change.
 *
 * DELIBERATELY over-broad (whole directories, not a curated file list): a
 * curated list is an exclusion list that the next renderer file silently
 * escapes (avoiding-drift #2). A false positive only costs one re-render
 * sweep after an update; a false negative re-creates #1628.
 *
 * Computed once per build process - in watch mode, restart to refresh it
 * (records are only stamped by real deployed builds anyway).
 */
function computeRendererVersion() {
  const dirs = ["src/domain", "src/infrastructure/notion", "src/infrastructure/obsidian"];
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  for (const d of dirs) walk(resolve(__dirname, d));
  files.sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f.replace(/\\/g, "/"));
    // Normalize line endings: git's CRLF/LF conversion must not change the
    // fingerprint, or every checkout flavor would trigger a spurious vault-wide
    // re-render sweep. Hash the text, not the bytes.
    h.update(readFileSync(f, "utf8").replace(/\r\n/g, "\n"));
  }
  return h.digest("hex").slice(0, 12);
}
const rendererVersion = computeRendererVersion();
console.log(`Renderer fingerprint: ${rendererVersion}`);

/**
 * styles.css is GENERATED (#1625): the source of truth is styles/*.css,
 * concatenated in numeric-prefix order. Keeping one build-time concat (not
 * an @import chain, not a CSS bundler) preserves the exact cascade order,
 * which is load-bearing - reordering rules can flip specificity ties.
 * See styles/README.md for the slice map and the section-migration protocol.
 */
function buildStyles() {
  const dir = resolve(__dirname, "styles");
  const files = readdirSync(dir).filter((f) => f.endsWith(".css")).sort();
  const header = Buffer.from(
    "/* GENERATED FILE - do not edit. Source: styles/*.css, concatenated in numeric-prefix order by esbuild.config.mjs (#1625). */\n",
  );
  const out = Buffer.concat([header, ...files.map((f) => readFileSync(join(dir, f)))]);
  writeFileSync(resolve(__dirname, "styles.css"), out);
  console.log(`Built styles.css from ${files.length} slices (${out.length} bytes)`);
}
buildStyles();

const banner = `/*
N2O Sync Lite - Notion to Obsidian import
Free edition of N2O Sync. One-way Notion -> Obsidian sync.
*/`;

const prod = process.argv[2] === "production";
const VAULT_PLUGIN_DIR = `${process.env.N2O_TEST_VAULT ?? "D:/DEV/n2o-lite-vault"}/.obsidian/plugins/n2o-lite`;

// Watch mode: after every successful rebuild, copy to vault + hot-reload via Obsidian CLI
const hotReloadPlugin = {
  name: "hot-reload",
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length > 0) return;
      try {
        // Re-concat so a styles/*.css edit reaches the vault on the next
        // rebuild (esbuild only watches the TS graph, so a pure CSS edit
        // still needs any rebuild trigger - touch a .ts file or rerun).
        buildStyles();
        copyFileSync("main.js", `${VAULT_PLUGIN_DIR}/main.js`);
        copyFileSync("styles.css", `${VAULT_PLUGIN_DIR}/styles.css`);
        execSync("obsidian plugin:reload id=n2o-lite", { stdio: "ignore", timeout: 5000 });
        console.log(`[${new Date().toLocaleTimeString()}] Hot-reloaded n2o-lite`);
        // Wait for plugin to finish initializing before reading console/errors
        execSync("sleep 2", { stdio: "ignore" });
        // Print startup logs + errors straight to terminal — no need to open Obsidian devtools
        try { execSync("obsidian dev:debug on", { stdio: "ignore", timeout: 3000 }); } catch { /* skip */ }
        try {
          const logs = execSync("obsidian dev:console limit=1000", { timeout: 3000 }).toString().trim();
          if (logs) console.log(logs);
        } catch { /* skip */ }
        try {
          const errors = execSync("obsidian dev:errors", { timeout: 3000 }).toString().trim();
          if (errors && errors !== "No errors captured.") console.error(`[errors] ${errors}`);
        } catch { /* skip */ }
      } catch {
        // CLI not installed or Obsidian not running — skip silently
      }
    });
  },
};

const context = await esbuild.context({
  plugins: prod ? [] : [hotReloadPlugin],
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  metafile: prod,
  // sql-wasm.wasm is embedded straight into main.js (the community store
  // ships only main.js/manifest.json/styles.css, so the plugin must not
  // depend on a wasm file on disk or a CDN).
  loader: { ".wasm": "binary", ".png": "dataurl" },
  define: {
    "process.env.NODE_ENV": prod ? '"production"' : '"development"',
    "__N2O_RENDERER_VERSION__": JSON.stringify(rendererVersion),
  },
});

if (prod) {
  const result = await context.rebuild();
  if (result.metafile) {
    writeFileSync("meta.json", JSON.stringify(result.metafile));
    console.log("Wrote bundle metafile to meta.json");
  }
  process.exit(0);
} else {
  await context.watch();
}
