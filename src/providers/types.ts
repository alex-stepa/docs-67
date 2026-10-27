import type { ProviderId } from "../shared/settings";

export interface LLMRequest {
  system: string;
  user: string; // exactly what "Zobrazit payload" shows
  schema: Record<string, unknown>; // JSON schema of the expected output
  schemaName: string;
}

export interface CompleteOptions {
  signal: AbortSignal;
  onProgress?: (textDelta: string) => void;
}

export interface LLMProvider {
  id: ProviderId;
  model: string;
  /** Endpoint origin the request goes to; background checks the host permission for it. */
  origin: string;
  /** Returns parsed JSON; shape is validated by the caller. */
  complete(req: LLMRequest, opts: CompleteOptions): Promise<unknown>;
  testConnection(signal?: AbortSignal): Promise<{ ok: true; model: string } | { ok: false; error: string }>;
}

export type ProviderErrorCode =
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "server"
  | "network"
  | "bad_request"
  | "not_found"
  | "refusal"
  | "truncated"
  | "bad_output"
  | "aborted";

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(["rate_limit", "overloaded", "server", "network"]);

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

export function codeForStatus(status: number | undefined): ProviderErrorCode {
  if (status === undefined) return "network";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 408) return "network";
  if (status === 429) return "rate_limit";
  if (status === 529 || status === 503) return "overloaded";
  if (status >= 500) return "server";
  return "bad_request";
}

/** Reads retry-after-ms / retry-after (seconds or HTTP date). */
export function parseRetryAfter(headers: Headers | undefined | null, now = Date.now()): number | undefined {
  if (!headers) return undefined;
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.get("retry-after-ms") && Number.isFinite(ms)) return Math.max(0, ms);
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export function isAbort(e: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (e instanceof Error && (e.name === "AbortError" || e.name === "APIUserAbortError"));
}

/** Joins streamed text and parses it as JSON, tolerating a ```json fence from looser servers. */
export function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new ProviderError("bad_output", `model output is not valid JSON: ${(e as Error).message}`);
  }
}
