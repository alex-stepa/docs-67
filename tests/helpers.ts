import { vi } from "vitest";
import type { Answer } from "../src/shared/answer";
import type { Form, Page } from "../src/shared/form";

// Hand-written page covering every type. Not a real Google Form: the parser side owns
// real fixtures in tests/fixtures/; this one only exercises the backend.
export const page: Page = {
  index: 0,
  title: "About you",
  questions: [
    { id: "entry.1", text: "E-mail", type: "short_text", required: true, needsHuman: false, validation: { kind: "text", op: "email" } },
    { id: "entry.2", text: "Favourite colour", type: "radio", required: true, needsHuman: false, options: [{ label: "Red" }, { label: "Blue" }], hasOther: true },
    { id: "entry.3", text: "Languages", type: "checkbox", required: false, needsHuman: false, options: [{ label: "CZ" }, { label: "EN" }, { label: "DE" }], validation: { kind: "checkbox_count", op: "at_most", value: 2 } },
    { id: "entry.4", text: "Satisfaction", type: "scale", required: true, needsHuman: false, scale: { min: 1, max: 5 } },
    { id: "entry.5", text: "Rate", type: "radio_grid", required: true, needsHuman: false, grid: { rows: [{ id: "entry.5a", label: "Food" }, { id: "entry.5b", label: "Service" }], columns: ["Bad", "Good"] } },
    { id: "entry.6", text: "Birth date", type: "date", required: false, needsHuman: false, date: { includeTime: false, includeYear: true } },
    { id: "entry.7", text: "CV", type: "file_upload", required: false, needsHuman: true },
  ],
};

export const form: Form = { formId: "1FAIpQLSf-test", title: "Test form", pages: [page], source: "fb_public_load_data" };

export const validAnswers: Answer[] = [
  { questionId: "entry.1", value: { kind: "text", text: "jan@example.com" }, confidence: 0.95, reasoning: "From profile.", needsUser: null },
  { questionId: "entry.2", value: { kind: "choice", option: "__other__", otherText: "Green" }, confidence: 0.8, reasoning: "Instructions.", needsUser: null },
  { questionId: "entry.3", value: { kind: "choices", options: ["CZ", "EN"], otherText: null }, confidence: 0.9, reasoning: "Profile.", needsUser: null },
  { questionId: "entry.4", value: { kind: "scale", value: 4 }, confidence: 0.6, reasoning: "Guess.", needsUser: null },
  { questionId: "entry.5", value: { kind: "grid", rows: [{ rowId: "entry.5a", columns: ["Good"] }, { rowId: "entry.5b", columns: ["Bad"] }] }, confidence: 0.5, reasoning: "Guess.", needsUser: null },
  { questionId: "entry.6", value: null, confidence: 0, reasoning: "Not in profile.", needsUser: "Birth date is not in the profile." },
  { questionId: "entry.7", value: null, confidence: 0, reasoning: "File upload.", needsUser: "Upload the CV yourself." },
];

export function sse(events: { event?: string; data: unknown }[], init: ResponseInit = {}): Response {
  const body = events
    .map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`)
    .join("");
  return new Response(body, { status: 200, ...init, headers: { "content-type": "text/event-stream", ...init.headers } });
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Replaces global fetch with queued responses and records every request. */
export function mockFetch(...responses: (Response | (() => Response))[]) {
  const calls: { url: string; init: RequestInit; body: any; headers: Headers }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    const raw = init.body ?? (input instanceof Request ? await input.text() : undefined);
    calls.push({ url, init, headers, body: typeof raw === "string" && raw ? JSON.parse(raw) : raw });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return typeof next === "function" ? next() : next;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

export const signal = () => new AbortController().signal;
