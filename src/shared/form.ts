import { z } from "zod";

// Contract between parser (producer) and backend/filler/UI (consumers).
// Changes need agreement from both contributors, see docs/backend-architecture.md.

export const QuestionType = z.enum([
  "short_text",
  "paragraph",
  "radio",
  "checkbox",
  "dropdown",
  "scale",
  "radio_grid",
  "checkbox_grid",
  "date",
  "time",
  "file_upload",
]);
export type QuestionType = z.infer<typeof QuestionType>;

const PageTarget = z.union([z.number().int().nonnegative(), z.literal("submit")]);

// The parser maps Google's own validation codes onto these ops.
export const Validation = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("number"),
    op: z.enum(["gt", "gte", "lt", "lte", "eq", "neq", "between", "not_between", "is_number", "is_integer"]),
    value: z.number().optional(),
    value2: z.number().optional(),
    message: z.string().optional(),
  }),
  z.object({
    kind: z.literal("text"),
    op: z.enum(["contains", "not_contains", "email", "url"]),
    value: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({
    kind: z.literal("length"),
    op: z.enum(["max_chars", "min_chars"]),
    value: z.number().int().nonnegative(),
    message: z.string().optional(),
  }),
  z.object({
    kind: z.literal("regex"),
    op: z.enum(["matches", "not_matches", "contains", "not_contains"]),
    value: z.string(),
    message: z.string().optional(),
  }),
  z.object({
    kind: z.literal("checkbox_count"),
    op: z.enum(["at_least", "at_most", "exactly"]),
    value: z.number().int().nonnegative(),
    message: z.string().optional(),
  }),
]);
export type Validation = z.infer<typeof Validation>;

export const Question = z.object({
  id: z.string().min(1),
  text: z.string(),
  description: z.string().optional(),
  type: QuestionType,
  required: z.boolean(),
  options: z.array(z.object({ label: z.string(), goToPage: PageTarget.optional() })).optional(),
  hasOther: z.boolean().optional(),
  scale: z
    .object({
      min: z.number().int(),
      max: z.number().int(),
      minLabel: z.string().optional(),
      maxLabel: z.string().optional(),
    })
    .optional(),
  grid: z
    .object({
      rows: z.array(z.object({ id: z.string(), label: z.string() })),
      columns: z.array(z.string()),
    })
    .optional(),
  date: z.object({ includeTime: z.boolean(), includeYear: z.boolean() }).optional(),
  validation: Validation.optional(),
  needsHuman: z.boolean(),
});
export type Question = z.infer<typeof Question>;

export const Page = z.object({
  index: z.number().int().nonnegative(),
  title: z.string().optional(),
  description: z.string().optional(),
  questions: z.array(Question),
  next: PageTarget.optional(),
});
export type Page = z.infer<typeof Page>;

export const Form = z.object({
  formId: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  pages: z.array(Page).min(1),
  source: z.enum(["fb_public_load_data", "dom"]),
});
export type Form = z.infer<typeof Form>;
