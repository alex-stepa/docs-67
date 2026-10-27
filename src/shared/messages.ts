import { z } from "zod";
import { Answer } from "./answer";
import { Form } from "./form";
import { ProfileField } from "./profile";
import { ProviderSettings } from "./settings";
import { RunMode } from "./state";

const tabId = z.number().int();
const QuestionError = z.object({ questionId: z.string(), message: z.string() });

/** Side panel / options page -> service worker. Rejected from any other sender. */
export const UiMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("settings.get") }),
  // apiKey: string = set, null = delete, omitted = keep
  z.object({ type: z.literal("settings.save"), settings: ProviderSettings, apiKey: z.string().nullable().optional() }),
  z.object({ type: z.literal("settings.test") }),
  z.object({ type: z.literal("state.get"), tabId }),
  z.object({
    type: z.literal("run.start"),
    tabId,
    mode: RunMode,
    approvedFields: z.array(ProfileField),
    instructions: z.string(),
  }),
  z.object({ type: z.literal("run.stop"), tabId }),
  z.object({ type: z.literal("fill.preview"), tabId }),
  z.object({ type: z.literal("fill.run"), tabId, hash: z.string() }),
  z.object({ type: z.literal("fill.repair"), tabId }),
  z.object({ type: z.literal("answers.update"), tabId, answers: z.array(Answer) }),
  z.object({ type: z.literal("fill.apply"), tabId }),
  z.object({ type: z.literal("nav.next"), tabId }),
  z.object({ type: z.literal("run.review"), tabId }),
  z.object({ type: z.literal("run.submit"), tabId, confirmed: z.literal(true) }),
]);
export type UiMessage = z.infer<typeof UiMessage>;

/** Content script on docs.google.com/forms -> service worker. tabId comes from the sender, never the payload. */
export const ContentMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("form.parsed"), form: Form }),
  z.object({ type: z.literal("page.changed"), pageIndex: z.number().int().nonnegative() }),
  // hasNext: page has a "Next" button (false = last page, the next step is the review)
  z.object({ type: z.literal("fill.applied"), pageIndex: z.number().int(), failed: z.array(QuestionError), hasNext: z.boolean() }),
  z.object({ type: z.literal("page.validationErrors"), errors: z.array(QuestionError) }),
  z.object({ type: z.literal("captcha.detected") }),
  z.object({ type: z.literal("submit.done") }),
]);
export type ContentMessage = z.infer<typeof ContentMessage>;

/** Service worker -> content script (browser.tabs.sendMessage). */
export type ToContentMessage =
  | { type: "fill.apply"; pageIndex: number; answers: Answer[] }
  | { type: "nav.next" }
  | { type: "nav.submit" }
  | { type: "stop" };

/** Service worker -> all extension pages (browser.runtime.sendMessage), fire and forget. */
export type BroadcastMessage =
  | { type: "state.changed"; tabId: number; state: unknown }
  | { type: "llm.progress"; tabId: number; chars: number }
  | { type: "llm.retry"; tabId: number; attempt: number; delayMs: number; reason: string };

export type Reply<T = unknown> = { ok: true; data: T } | { ok: false; error: string };
