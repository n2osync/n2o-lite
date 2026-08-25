/**
 * Image imports resolve to a data URI: esbuild's dataurl loader inlines the file
 * at build time so the plugin ships self-contained, with no runtime fetch (which
 * would break network purity). Mirrors the *.wasm binary loader in vendor-shims.
 */
declare module '*.png' {
  const src: string;
  export default src;
}
