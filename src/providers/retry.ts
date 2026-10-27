import { ProviderError } from "./types";

export interface RetryOptions {
  signal: AbortSignal;
  maxAttempts?: number; // total attempts, including the first
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (info: { attempt: number; delayMs: number; error: ProviderError }) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>; // injectable for tests
  random?: () => number;
}

/**
 * The only retry policy in the extension: SDK clients run with maxRetries 0,
 * so Stop can cut a backoff wait short.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const { signal, maxAttempts = 4, baseDelayMs = 1000, maxDelayMs = 30_000 } = opts;
  const sleep = opts.sleep ?? abortableSleep;
  const random = opts.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    if (signal.aborted) throw new ProviderError("aborted", "stopped");
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ProviderError) || !e.retryable || attempt >= maxAttempts) throw e;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      // Server hint wins; otherwise full jitter on the exponential backoff.
      const delayMs = e.retryAfterMs ?? Math.round(backoff * (0.5 + random() / 2));
      opts.onRetry?.({ attempt, delayMs, error: e });
      await sleep(delayMs, signal);
    }
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError("aborted", "stopped"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError("aborted", "stopped"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
