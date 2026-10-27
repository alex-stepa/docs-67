import { describe, expect, it, vi } from "vitest";
import { fillPage } from "../../src/providers/fill-page";
import { buildPageRequest, hashRequest } from "../../src/providers/prompt";
import { ProviderError } from "../../src/providers/types";
import type { LLMProvider } from "../../src/providers/types";
import { form, page, signal, validAnswers } from "../helpers";

const req = buildPageRequest({
  form,
  page,
  profileFields: [{ key: "email", label: "E-mail", value: "jan@example.com" }],
  instructions: "  I like green.  ",
});

function fakeProvider(...outputs: unknown[]): LLMProvider & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async () => {
    const next = outputs.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return { id: "anthropic", model: "m", origin: "https://x", complete, testConnection: vi.fn() };
}

const opts = () => ({ signal: signal(), sleep: async () => {} });

describe("fillPage", () => {
  it("returns valid answers in page order on the first try", async () => {
    const p = fakeProvider({ answers: [...validAnswers].reverse() });
    const { result, unresolved, sent } = await fillPage(p, req, page, opts());
    expect(result.answers.map((a) => a.questionId)).toEqual(page.questions.map((q) => q.id));
    expect(unresolved).toEqual([]);
    expect(sent).toEqual([req]);
  });

  it("repairs once with the semantic errors", async () => {
    const bad = validAnswers.map((a) => (a.questionId === "entry.4" ? { ...a, value: { kind: "scale", value: 9 } } : a));
    const p = fakeProvider({ answers: bad }, { answers: validAnswers });
    const { result, unresolved, sent } = await fillPage(p, req, page, opts());
    expect(unresolved).toEqual([]);
    expect(result.answers).toEqual(validAnswers);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.user).toContain("entry.4: scale value must be an integer from 1 to 5");
    expect(sent[1]!.user.startsWith(req.user)).toBe(true);
  });

  it("repairs once after malformed JSON shape", async () => {
    const p = fakeProvider({ answer: [] }, { answers: validAnswers });
    const { sent } = await fillPage(p, req, page, opts());
    expect(sent[1]!.user).toContain("answers");
  });

  it("after the second failure marks only the broken questions for the user", async () => {
    const bad = validAnswers.map((a) => (a.questionId === "entry.4" ? { ...a, value: { kind: "scale", value: 9 } } : a));
    const p = fakeProvider({ answers: bad }, { answers: bad });
    const { result, unresolved } = await fillPage(p, req, page, opts());
    expect(unresolved.map((e) => e.questionId)).toEqual(["entry.4"]);
    const q4 = result.answers.find((a) => a.questionId === "entry.4")!;
    expect(q4).toMatchObject({ value: null, confidence: 0 });
    expect(q4.needsUser).toContain("scale value");
    expect(result.answers.find((a) => a.questionId === "entry.1")).toEqual(validAnswers[0]);
  });

  it("throws bad_output when the shape is wrong twice", async () => {
    const p = fakeProvider("nope", { answers: "nope" });
    await expect(fillPage(p, req, page, opts())).rejects.toMatchObject({ code: "bad_output" });
  });

  it("rate limits are retried without counting as a repair attempt", async () => {
    const p = fakeProvider(new ProviderError("rate_limit", "429", 429, 0), { answers: validAnswers });
    const { sent } = await fillPage(p, req, page, opts());
    expect(p.complete).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
  });
});

describe("buildPageRequest", () => {
  it("includes only the given profile fields and trimmed instructions", () => {
    const payload = JSON.parse(req.user);
    expect(payload.profile).toEqual({ "E-mail": "jan@example.com" });
    expect(payload.instructions).toBe("I like green.");
    expect(payload.page.questions[1].options).toEqual(["Red", "Blue"]);
    expect(payload.page.questions[6].needsHuman).toBe(true);
  });

  it("schema is strict-friendly: no $schema, no oneOf, objects closed", () => {
    const s = JSON.stringify(req.schema);
    expect(req.schema).not.toHaveProperty("$schema");
    expect(s).not.toContain("oneOf");
    expect(s).toContain('"additionalProperties":false');
  });

  it("hash is stable and changes with the payload", async () => {
    const again = buildPageRequest({ form, page, profileFields: [{ key: "email", label: "E-mail", value: "jan@example.com" }], instructions: "I like green." });
    expect(await hashRequest(again)).toBe(await hashRequest(req));
    const other = buildPageRequest({ form, page, profileFields: [], instructions: "I like green." });
    expect(await hashRequest(other)).not.toBe(await hashRequest(req));
  });
});
