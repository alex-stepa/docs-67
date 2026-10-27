import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/providers/anthropic";
import { buildPageRequest } from "../../src/providers/prompt";
import { form, json, mockFetch, page, signal, sse, validAnswers } from "../helpers";

afterEach(() => vi.unstubAllGlobals());

const req = buildPageRequest({ form, page, profileFields: [], instructions: "" });

function messageStream(text: string[], stopReason = "end_turn", stopDetails: unknown = null) {
  return sse([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
      },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    ...text.map((t) => ({ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } } })),
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails }, usage: { output_tokens: 20 } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
}

describe("Anthropic provider", () => {
  it("streams structured JSON with the expected request shape", async () => {
    const out = JSON.stringify({ answers: validAnswers });
    const calls = mockFetch(messageStream([out.slice(0, 40), out.slice(40)]));
    const deltas: string[] = [];
    const p = createAnthropicProvider({ apiKey: "sk-ant-test", model: "claude-opus-5-5", effort: "medium" });

    const result = await p.complete(req, { signal: signal(), onProgress: (d) => deltas.push(d) });

    expect(result).toEqual({ answers: validAnswers });
    expect(deltas.join("")).toBe(out);
    const [call] = calls;
    expect(call!.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    // SDK 1.x sends the API key as a bearer token.
    expect(call!.headers.get("authorization")).toBe("Bearer sk-ant-test");
    expect(call!.headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(call!.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(call!.body).toMatchObject({
      model: "claude-opus-5-5",
      stream: true,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: req.schema } },
      fallbacks: "default",
    });
    expect(call!.body).not.toHaveProperty("temperature");
    expect(call!.body).not.toHaveProperty("tool_choice");
  });

  it("skips the fallback parameter on models without server-side fallback", async () => {
    const calls = mockFetch(messageStream(['{"answers":[]}']));
    await createAnthropicProvider({ apiKey: "k", model: "claude-haiku-5-5" }).complete(req, { signal: signal() });
    expect(calls[0]!.body).not.toHaveProperty("fallbacks");
    expect(calls[0]!.headers.get("anthropic-beta")).toBeNull();
  });

  it("maps a refusal to a ProviderError", async () => {
    mockFetch(messageStream([], "refusal", { type: "refusal", category: "cyber", explanation: "declined" }));
    await expect(createAnthropicProvider({ apiKey: "k", model: "claude-opus-5-5" }).complete(req, { signal: signal() })).rejects.toMatchObject({
      code: "refusal",
    });
  });

  it("maps max_tokens to truncated", async () => {
    mockFetch(messageStream(['{"answers":['], "max_tokens"));
    await expect(createAnthropicProvider({ apiKey: "k", model: "claude-opus-5-5" }).complete(req, { signal: signal() })).rejects.toMatchObject({
      code: "truncated",
    });
  });

  it("maps 429 with retry-after to a retryable rate_limit error", async () => {
    mockFetch(json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429, { "retry-after": "12" }));
    const err = await createAnthropicProvider({ apiKey: "k", model: "claude-opus-5-5" })
      .complete(req, { signal: signal() })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "rate_limit", status: 429, retryAfterMs: 12_000, retryable: true });
  });

  it("testConnection retrieves the model", async () => {
    const calls = mockFetch(json({ id: "claude-opus-5-5", type: "model", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z" }));
    expect(await createAnthropicProvider({ apiKey: "k", model: "claude-opus-5-5" }).testConnection()).toEqual({ ok: true, model: "claude-opus-5-5" });
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models/claude-opus-5-5");
  });

  it("testConnection reports a bad key", async () => {
    mockFetch(json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401));
    const res = await createAnthropicProvider({ apiKey: "bad", model: "claude-opus-5-5" }).testConnection();
    expect(res.ok).toBe(false);
  });
});
