/**
 * NotionHttpClient - injectable HTTP fetch contract for the Notion adapter.
 *
 * The Notion adapter must stay decoupled from Obsidian's requestUrl
 * (Notion and Obsidian adapters are fully independent). This
 * type captures the minimal request/response surface NotionClient
 * needs; main.ts wires the real Obsidian requestUrl and tests inject
 * a stub.
 *
 * The contract intentionally mirrors Obsidian's requestUrl semantics:
 *   - Non-2xx responses THROW an error object that carries the
 *     response status/headers/json/text. The throw shape matches
 *     RequestUrlError in client.ts. Callers use isRequestUrlError() +
 *     extractRateLimitError() / throwApiError() exactly as before.
 *
 * Keeping the throw contract means we can swap out the implementation
 * (real requestUrl, test stub, future Node fetch wrapper) without
 * touching every call site.
 */

interface NotionHttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
  /**
   * When false, the impl must NOT throw on non-2xx; it returns the response
   * with status + json + text so the caller can read the real error body.
   * Defaults to true (throw) to preserve the original contract. request()
   * sets this false so Notion 400 bodies are surfaced instead of lost.
   */
  throwOnError?: boolean;
}

export interface NotionHttpResponse {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  arrayBuffer?: ArrayBuffer;
}

export type NotionHttpFetch = (req: NotionHttpRequest) => Promise<NotionHttpResponse>;
