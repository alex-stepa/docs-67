import { describe, expect, it, vi } from "vitest";
import { abortableSleep, withRetry } from "../../src/providers/retry";
import { parseRetryAfter, ProviderError } from "../../src/providers/types";

const noSleep = vi.fn(async () => {});

describe("withRetry", () => {
  it("retries retryable errors, honouring retry-after", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError("rate_limit", "429", 429, 7000))
      .mockRejectedValueOnce(new ProviderError("overloaded", "529", 529))
      .mockResolvedValue("ok");
    const delays: number[] = [];
    const out = await withRetry(fn, {
      signal: new AbortController().signal,
      sleep: noSleep,
      random: () => 1,
      onRetry: ({ delayMs }) => delays.push(delayMs),
    });
    expect(out).toBe("ok");
    expect(delays).toEqual([7000, 2000]); // server hint, then base * 2^1
  });

  it("does not retry non-retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue(new ProviderError("auth", "bad key", 401));
    await expect(withRetry(fn, { signal: new AbortController().signal, sleep: noSleep })).rejects.toMatchObject({ code: "auth" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts", async () => {
    const fn = vi.fn().mockRejectedValue(new ProviderError("server", "500", 500));
    await expect(withRetry(fn, { signal: new AbortController().signal, sleep: noSleep, maxAttempts: 3 })).rejects.toMatchObject({
      code: "server",
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("Stop interrupts a backoff wait", async () => {
    const ctrl = new AbortController();
    const fn = vi.fn().mockRejectedValue(new ProviderError("rate_limit", "429", 429, 60_000));
    const p = withRetry(fn, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    await expect(p).rejects.toMatchObject({ code: "aborted" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("abortableSleep rejects immediately when already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(abortableSleep(10, ctrl.signal)).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("parseRetryAfter", () => {
  it("reads ms, seconds and HTTP dates", () => {
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "250" }))).toBe(250);
    expect(parseRetryAfter(new Headers({ "retry-after": "3" }))).toBe(3000);
    const now = Date.parse("2026-10-27T12:00:00Z");
    expect(parseRetryAfter(new Headers({ "retry-after": "Tue, 27 Oct 2026 12:00:05 GMT" }), now)).toBe(5000);
    expect(parseRetryAfter(new Headers())).toBeUndefined();
  });
});
