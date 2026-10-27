import { z } from "zod";
import { Answer } from "./answer";
import { Form } from "./form";
import { ProfileField } from "./profile";

export const RunMode = z.enum(["fill_all", "step_approval", "dry_run"]);
export type RunMode = z.infer<typeof RunMode>;

export const RunStatus = z.enum([
  "idle", // form known, no run started
  "awaiting_approval", // payload for the current page waits for "approve"
  "calling_llm",
  "awaiting_user", // answers ready, some need the user (or mode asks for approval)
  "filling", // content script is writing answers into the page
  "review", // overview before submit, waits for explicit confirmation
  "submitting",
  "blocked", // CAPTCHA or similar; only the user can continue
  "stopped",
  "done",
  "error",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const LLMRequestSchema = z.object({
  system: z.string(),
  user: z.string(),
  schema: z.record(z.string(), z.unknown()),
  schemaName: z.string(),
});

// One per tab, in chrome.storage.session under run:<tabId>. Readable only by
// extension pages and the service worker (not content scripts).
export const RunState = z.object({
  tabId: z.number().int(),
  formId: z.string(),
  form: Form,
  mode: RunMode,
  status: RunStatus,
  /** Pages visited in order; the last one is the current page (branching). */
  pagePath: z.array(z.number().int().nonnegative()),
  /** Data the user approved for this run. Nothing else goes to the LLM. */
  approvedFields: z.array(ProfileField),
  instructions: z.string(),
  answers: z.record(z.string(), Answer), // by questionId, includes user edits
  pending: z.object({ hash: z.string(), pageIndex: z.number().int(), request: LLMRequestSchema }).optional(),
  repairAttempts: z.record(z.string(), z.number().int()), // by pageIndex
  validationErrors: z.array(z.object({ questionId: z.string(), message: z.string() })),
  error: z.string().optional(),
  updatedAt: z.number(),
});
export type RunState = z.infer<typeof RunState>;

export const currentPage = (s: RunState): number => s.pagePath.at(-1) ?? 0;
