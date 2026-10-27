import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiProvider } from "../../src/providers/gemini";
import { buildPageRequest } from "../../src/providers/prompt";
import { form, json, mockFetch, page, signal, sse } from "../helpers";

afterEach(() => vi.unstubAllGlobals());

const req = buildPageRequest({ form, page, profileFields: [], instructions: "" });

const chunk = (text: string, finishReason?: string) => ({
  data: { candidates: [{ content: { role: "model", parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }] },
});

describe("Gemini provider", () => {
  it("streams JSON with responseJsonSchema", async () => {
    const calls = mockFetch(sse([chunk('{"answers":'), chunk("[]}", "STOP")]));
    const deltas: string[] = [];
    const p = createGeminiProvider({ apiKey: "g-key", model: "gemini-2.5-pro" });

    expect(await p.complete(req, { signal: signal(), onProgress: (d) => deltas.push(d) })).toEqual({ answers: [] });
    expect(deltas).toEqual(['{"answers":', "[]}"]);
    const [call] = calls;
    expect(call!.url).toContain("https://generativelanguage.googleapis.com/");
    expect(call!.url).toContain("gemini-2.5-pro:streamGenerateContent");
    expect(call!.headers.get("x-goog-api-key")).toBe("g-key");
    expect(call!.body).toMatchObject({
      systemInstruction: { parts: [{ text: req.system }] },
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: req.schema },
    });
  });

  it("maps SAFETY to refusal and MAX_TOKENS to truncated", async () => {
    mockFetch(sse([chunk("", "SAFETY")]), sse([chunk('{"a', "MAX_TOKENS")]));
    const p = createGeminiProvider({ apiKey: "k", model: "gemini-2.5-pro" });
    await expect(p.complete(req, { signal: signal() })).rejects.toMatchObject({ code: "refusal" });
    await expect(p.complete(req, { signal: signal() })).rejects.toMatchObject({ code: "truncated" });
  });

  it("maps 429 to a retryable error", async () => {
    mockFetch(json({ error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } }, 429));
    const err = await createGeminiProvider({ apiKey: "k", model: "gemini-2.5-pro" })
      .complete(req, { signal: signal() })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "rate_limit", retryable: true });
  });
});
