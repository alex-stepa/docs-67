# Backend architecture (DRAFT, awaiting approval)

Scope: service worker, provider layer, shared contract, state, keys, permissions.
Parser, filler, and UI are out of scope here; they only consume the contract in `src/shared/`.

## Layout

```
src/
  shared/              # contract between all parts, zod schemas + inferred types
    form.ts            # Form, Page, Question
    answer.ts          # Answer, PageAnswers (LLM output)
    profile.ts         # Profile, ProfileField
    settings.ts        # ProviderSettings
    messages.ts        # runtime messages between ui/content/background
    state.ts           # RunState (chrome.storage.session)
  providers/
    types.ts           # LLMProvider interface, ProviderError
    anthropic.ts       # @anthropic-ai/sdk
    openai.ts          # openai SDK, also used for "OpenAI-compatible" (custom baseURL)
    gemini.ts          # @google/genai
    registry.ts        # providerId -> factory
    retry.ts           # backoff for 429 / 5xx / overloaded, honours retry-after
    prompt.ts          # system prompt + user payload builder (pure)
    fill-page.ts       # call provider, zod-validate, 1x repair retry
  background/
    state.ts           # RunState read/write in chrome.storage.session
    keys.ts            # API key in chrome.storage.local, only read here
    permissions.ts     # optional host permission for the chosen endpoint
    router.ts          # message handlers
  entrypoints/
    background.ts      # WXT entry, wires router; thin
tests/
  providers/           # mock fetch, recorded SSE fixtures in tests/fixtures/llm/
  shared/              # schema tests
```

WXT requires entrypoints under `entrypoints/`, so the spec's `background.ts` lives at `src/entrypoints/background.ts` and stays thin.

## Data models (`src/shared/`)

```ts
type QuestionType =
  | "short_text" | "paragraph" | "radio" | "checkbox" | "dropdown"
  | "scale" | "radio_grid" | "checkbox_grid" | "date" | "time" | "file_upload";

interface Question {
  id: string;                 // entry id from FB_PUBLIC_LOAD_DATA_ (e.g. "entry.123"), stable across reloads
  text: string;
  description?: string;
  type: QuestionType;
  required: boolean;
  options?: { label: string; goToPage?: number | "submit" }[]; // radio/dropdown branching lives here
  hasOther?: boolean;         // "Other:" free-text option
  scale?: { min: number; max: number; minLabel?: string; maxLabel?: string };
  grid?: { rows: { id: string; label: string }[]; columns: string[] };
  date?: { includeTime: boolean; includeYear: boolean };
  validation?: {
    kind: "number" | "text" | "length" | "regex" | "checkbox_count";
    op: string;               // exact ops to be confirmed against a real form by the parser side
    value?: string | number;
    value2?: string | number;
    message?: string;
  };
  needsHuman: boolean;        // true for file_upload, set by the parser
}

interface Page {
  index: number;
  title?: string;
  description?: string;
  questions: Question[];
  next?: number | "submit";   // section-level "after section go to"
}

interface Form {
  formId: string;             // from URL /forms/d/e/<id>/
  title: string;
  description?: string;
  pages: Page[];
  source: "fb_public_load_data" | "dom";
}
```

LLM output, one object per page:

```ts
type AnswerValue =
  | { kind: "text"; text: string }                       // short_text, paragraph, "Other"
  | { kind: "choice"; option: string; otherText?: string } // radio, dropdown
  | { kind: "choices"; options: string[]; otherText?: string } // checkbox
  | { kind: "scale"; value: number }
  | { kind: "grid"; rows: { rowId: string; columns: string[] }[] }
  | { kind: "date"; date: string }                       // YYYY-MM-DD
  | { kind: "time"; time: string };                      // HH:MM

interface Answer {
  questionId: string;
  value: AnswerValue | null;  // null = model will not answer
  confidence: number;         // 0..1
  reasoning: string;          // short, max ~200 chars
  needsUser?: string;         // why the user must answer (missing personal data etc.)
}

interface PageAnswers { pageIndex: number; answers: Answer[] }
```

Validation is two-pass: the zod schema checks shape, then `validateAgainstPage(page, answers)` checks semantics (option exists in `options`, scale in range, grid rows match, required answered or flagged, regex/length/number rules). Either failure triggers the single repair retry with the error list; a second failure returns the partial result with failing questions marked `needsUser`.

"Low confidence" threshold is a setting (default 0.7). Rule enforced in the prompt and re-checked in code: personal data not present in the approved profile must come back as `value: null` + `needsUser`.

Profile and settings:

```ts
interface ProfileField { key: string; label: string; value: string }
interface Profile { id: string; name: string; fields: ProfileField[] }

interface ProviderSettings {
  provider: "anthropic" | "openai" | "gemini" | "openai_compatible";
  model: string;
  baseUrl?: string;           // openai_compatible only
  temperature?: number;       // ignored by Anthropic (current models reject sampling params)
  effort?: "low" | "medium" | "high"; // Anthropic only
  confidenceThreshold: number;
}
// API key stored separately under its own storage key, never inside ProviderSettings,
// so settings can be read/displayed without touching the key.
```

## Provider layer

```ts
interface LLMRequest {
  system: string;
  user: string;               // exact text shown by "Zobrazit payload"
  schema: JSONSchema;         // generated once from zod via z.toJSONSchema
  schemaName: string;
}

interface LLMProvider {
  id: ProviderSettings["provider"];
  complete(req: LLMRequest, opts: {
    signal: AbortSignal;      // Stop button
    onProgress?: (chars: number, textDelta: string) => void;
  }): Promise<unknown>;       // parsed JSON, not yet validated
  testConnection(): Promise<{ ok: true; model: string } | { ok: false; error: string }>;
}
```

Structured output per provider:

- **Anthropic** (`@anthropic-ai/sdk`, `dangerouslyAllowBrowser: true`, which sends `anthropic-dangerous-direct-browser-access`): `messages.stream` with `output_config.format` JSON schema. Forced `tool_choice` is rejected by current models (Opus 5.5 / Sonnet 5.5), so tool use is not the mechanism. Default model `claude-opus-5-5`, `thinking: adaptive`, `effort` explicit (default `medium`). Handle `stop_reason: "refusal"` and `max_tokens` as errors shown to the user. No `temperature` (now rejected by the API). Server-side refusal fallback (`fallbacks: "default"`) on by default; can be dropped if you prefer.
- **OpenAI**: `openai` SDK, streamed chat completion with `response_format: { type: "json_schema", strict: true }`.
- **OpenAI-compatible**: same class, custom `baseURL`; if the server rejects `json_schema` (some Ollama/OpenRouter models), fall back to `json_object` + schema in the prompt. zod validation catches the rest.
- **Gemini**: `@google/genai`, `generateContentStream` with `responseMimeType: "application/json"` + `responseSchema`.

All SDKs accept an injected `fetch`, so tests run in Node/Vitest against recorded responses with no network.

Retry (`retry.ts`): 429, 408, 5xx, Anthropic 529 overloaded. Waits `retry-after` when present, else exponential 1s/2s/4s/8s with jitter, max 4 attempts, aborts immediately on `signal`. SDK built-in retries off (`maxRetries: 0`) so there's one retry policy and Stop works mid-wait.

Streaming: deltas forwarded to the side panel as `{ type: "llm.progress", chars }` over a long-lived `runtime.Port`. The JSON is parsed only at the end; partial JSON is not shown as answers.

## Keys and permissions

- API key: `chrome.storage.local["apiKey:<provider>"]`. Written by the options page, read only by the service worker. Never logged, never in RunState, never in payload preview, never in messages back to UI (UI gets `hasKey: boolean`). Note: `storage.local` is not encrypted at rest. The README should say so.
- Manifest: `permissions: ["activeTab", "storage", "scripting", "sidePanel"]`, `host_permissions: ["https://docs.google.com/forms/*"]`, `optional_host_permissions: ["https://api.anthropic.com/*", "https://api.openai.com/*", "https://generativelanguage.googleapis.com/*", "https://*/*", "http://localhost/*", "http://127.0.0.1/*"]`. The options page calls `chrome.permissions.request` for exactly the chosen endpoint's origin on Save (needs a user gesture, so it runs in the UI). `background/permissions.ts` exports the origin helper and refuses to call a provider whose origin isn't granted. Result: only Forms + the chosen endpoint are ever granted, as the spec asks.
- `sidePanel` is needed for the React side panel. It isn't in the spec's list, but the panel can't exist without it.

## Payload approval

`buildPagePrompt(form, page, approvedFields, instructions)` is pure and deterministic. The flow:

1. UI sends `fill.preview { tabId, pageIndex, approvedFieldKeys, instructions }`.
2. Background builds the `LLMRequest`, stores it in RunState with a hash, returns `{ payload, hash }` plus the provider, model, and endpoint (no key).
3. UI shows it ("Zobrazit payload"). On approve it sends `fill.run { hash }`.
4. Background sends exactly the stored request. If anything changed, the hash won't match and it rebuilds and re-asks.

In "Vyplnit vše" mode, the user approves fields and instructions once per run; each page's payload is still recorded and viewable.

## Message contract (`src/shared/messages.ts`)

All messages are zod-validated on receive. Background ← UI:

| type | payload | reply |
|---|---|---|
| `settings.test` | — | `{ ok, model } \| { ok: false, error }` |
| `run.start` | `{ tabId, mode, profileId, approvedFieldKeys, instructions }` | `RunState` |
| `run.stop` | `{ tabId }` | aborts in-flight LLM call + tells content script to stop |
| `fill.preview` | `{ tabId, pageIndex }` | `{ payload, hash, endpoint, model }` |
| `fill.run` | `{ tabId, hash }` | `PageAnswers` (validated) |
| `fill.repair` | `{ tabId, pageIndex, errors: { questionId, message }[] }` | `PageAnswers`; max 2 per page, then the remaining questions are `needsUser` |
| `state.get` | `{ tabId }` | `RunState \| null` |

Background ← content script: `form.parsed { tabId, form }`, `page.changed { pageIndex }`, `captcha.detected` (run goes to `blocked`), `page.validationErrors`. Background → content script: `fill.apply { answers }`, `nav.next`, `stop`. Submit is never sent from background; only the UI review screen can trigger `nav.submit`, after the user confirms.

## Run state (`chrome.storage.session`)

```ts
interface RunState {
  tabId: number;
  formId: string;
  mode: "fill_all" | "step_approval" | "dry_run";
  status: "idle" | "parsing" | "awaiting_approval" | "calling_llm" | "filling"
        | "awaiting_user" | "review" | "blocked" | "stopped" | "done" | "error";
  pagePath: number[];         // pages visited, in order (branching)
  answers: Record<string, Answer>;   // by questionId, includes user edits
  pending?: { hash: string; request: LLMRequest };
  repairAttempts: Record<number, number>;
  error?: string;
  updatedAt: number;
}
```

Keyed `run:<tabId>:<formId>`. Written after every transition, so a page reload or a service worker restart resumes from `pagePath.at(-1)`. A worker restart during an LLM call loses that call; state stays `calling_llm` with a stale `updatedAt`, and resume re-asks for approval instead of resending silently. Stop: one `AbortController` per tab in memory, plus `status = "stopped"` persisted so the content script and UI stop even if the worker restarted.

## Open questions

1. Scope boundary: confirm that parser, filler, options page, and side panel belong to the other contributor and the backend only provides `src/shared/` + the service worker.
2. Default Anthropic model `claude-opus-5-5` (best quality, $4/$20 per MTok). `claude-sonnet-5-5` or `claude-haiku-5-5` are cheaper. The user picks in options; this is only the default.
3. Server-side refusal fallback for Anthropic: keep it on (default) or drop it?
