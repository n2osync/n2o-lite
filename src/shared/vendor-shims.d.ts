/**
 * .wasm imports resolve to the raw bytes: esbuild's binary loader (and the
 * mirroring vitest plugin) turn the file into a default-exported Uint8Array.
 */
declare module '*.wasm' {
  const bytes: Uint8Array;
  export default bytes;
}

declare module 'sql.js' {
  export interface Statement {
    bind(values?: unknown[]): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    run(values?: unknown[]): void;
    reset(): void;
    free(): void;
  }

  export interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  export interface Database {
    exec(sql: string, params?: unknown[]): QueryExecResult[];
    prepare(sql: string): Statement;
    run(sql: string, params?: unknown[]): void;
    export(): Uint8Array;
    getRowsModified(): number;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }

  export default function initSqlJs(config: {
    wasmBinary?: ArrayBuffer | Uint8Array;
    locateFile?: (file: string) => string;
  }): Promise<SqlJsStatic>;
}
