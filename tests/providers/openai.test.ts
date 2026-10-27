import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIProvider } from "../../src/providers/openai";
import { buildPageRequest } from "../../src/providers/prompt";
import { form, json, mockFetch, page, signal, sse } from "../helpers";

afterEach(() => vi.unstubAllGlobals());

const req = buildPageRequest({ form, page, profileFields: [], instructions: "" });

function chunks(parts: string[], finish = "stop") {
  const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m" };
  return sse([
    ...parts.map((content) => ({ data: { ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] } })),
    { data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] } },
    { data: "[DONE]" },
  ]);
}

describe("OpenAI provider", () => {
  it("streams with strict json_schema response_format", async () => {
    const calls = mockFetch(chunks(['{"answers"', ":[]}"]));
    const p = createOpenAIProvider({ apiKey: "sk-test", model: "gpt-5", temperature: 0.2 });

    expect(await p.complete(req, { signal: signal() })).toEqual({ answers: [] });
    expect(p.origin).toBe("https://api.openai.com");
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer sk-test");
    expect(calls[0]!.body).toMatchObject({
      model: "gpt-5",
      stream: true,
      temperature: 0.2,
      response_format: { type: "json_schema", json_schema: { name: "page_answers", strict: true, schema: req.schema } },
    });
  });

  it("maps finish_reason length to truncated", async () => {
    mockFetch(chunks(['{"answers":['], "length"));
    await expect(createOpenAIProvider({ apiKey: "k", model: "gpt-5" }).complete(req, { signal: signal() })).rejects.toMatchObject({
      code: "truncated",
    });
  });

  it("compatible server: falls back to json_object after a 400 and remembers it", async () => {
    const calls = mockFetch(
      json({ error: { message: "response_format json_schema not supported" } }, 400),
      chunks(['```json\n{"answers":[]}\n```']),
      chunks(['{"answers":[]}']),
    );
    const p = createOpenAIProvider({ apiKey: "", model: "llama3", baseUrl: "http://localhost:11434/v1" });

    expect(p.id).toBe("openai_compatible");
    expect(p.origin).toBe("http://localhost:11434");
    expect(await p.complete(req, { signal: signal() })).toEqual({ answers: [] });
    expect(await p.complete(req, { signal: signal() })).toEqual({ answers: [] });
    expect(calls.map((c) => c.body.response_format.type)).toEqual(["json_schema", "json_object", "json_object"]);
    expect(calls[1]!.body.messages[0].content).toContain("matching this JSON schema");
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("official OpenAI: a 400 is not retried as json_object", async () => {
    const calls = mockFetch(json({ error: { message: "bad" } }, 400));
    await expect(createOpenAIProvider({ apiKey: "k", model: "gpt-5" }).complete(req, { signal: signal() })).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(calls).toHaveLength(1);
  });

  it("maps 429 with retry-after-ms", async () => {
    mockFetch(json({ error: { message: "rate" } }, 429, { "retry-after-ms": "1500" }));
    const err = await createOpenAIProvider({ apiKey: "k", model: "gpt-5" })
      .complete(req, { signal: signal() })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "rate_limit", retryAfterMs: 1500 });
  });
});
