import { z } from "zod";
import type { Page, Question } from "./form";

// Option value the model uses to pick the "Other:" choice; the text goes in otherText.
export const OTHER_OPTION = "__other__";

// Every field is required and nullable instead of optional, so the same JSON schema
// works for strict structured output on Anthropic, OpenAI and Gemini.
// Ranges (confidence 0..1, scale bounds) are checked in validateAgainstPage, not in
// the schema, because not every provider accepts numeric constraints.
// z.union (anyOf), not discriminatedUnion (oneOf): OpenAI strict mode rejects oneOf.
export const AnswerValue = z.union([
  z.strictObject({ kind: z.literal("text"), text: z.string() }),
  z.strictObject({ kind: z.literal("choice"), option: z.string(), otherText: z.string().nullable() }),
  z.strictObject({ kind: z.literal("choices"), options: z.array(z.string()), otherText: z.string().nullable() }),
  z.strictObject({ kind: z.literal("scale"), value: z.number() }),
  z.strictObject({
    kind: z.literal("grid"),
    rows: z.array(z.strictObject({ rowId: z.string(), columns: z.array(z.string()) })),
  }),
  z.strictObject({ kind: z.literal("date"), date: z.string() }),
  z.strictObject({ kind: z.literal("time"), time: z.string() }),
]);
export type AnswerValue = z.infer<typeof AnswerValue>;

export const Answer = z.strictObject({
  questionId: z.string(),
  value: AnswerValue.nullable(),
  confidence: z.number(),
  reasoning: z.string(),
  needsUser: z.string().nullable(),
});
export type Answer = z.infer<typeof Answer>;

// What the model returns for one page.
export const LlmPageAnswers = z.strictObject({ answers: z.array(Answer) });
export type LlmPageAnswers = z.infer<typeof LlmPageAnswers>;

export interface PageAnswers {
  pageIndex: number;
  answers: Answer[];
}

export interface AnswerError {
  questionId: string;
  message: string;
}

const expectedKind: Record<Question["type"], AnswerValue["kind"] | null> = {
  short_text: "text",
  paragraph: "text",
  radio: "choice",
  dropdown: "choice",
  checkbox: "choices",
  scale: "scale",
  radio_grid: "grid",
  checkbox_grid: "grid",
  date: "date",
  time: "time",
  file_upload: null,
};

// Semantic checks the JSON schema can't express. Empty array = page is valid.
export function validateAgainstPage(page: Page, answers: Answer[]): AnswerError[] {
  const errors: AnswerError[] = [];
  const byId = new Map<string, Answer>();
  for (const a of answers) {
    if (byId.has(a.questionId)) errors.push({ questionId: a.questionId, message: "duplicate answer" });
    byId.set(a.questionId, a);
  }
  const ids = new Set(page.questions.map((q) => q.id));
  for (const a of answers) {
    if (!ids.has(a.questionId)) errors.push({ questionId: a.questionId, message: "unknown questionId" });
  }
  for (const q of page.questions) {
    const a = byId.get(q.id);
    if (!a) {
      errors.push({ questionId: q.id, message: "missing answer entry" });
      continue;
    }
    for (const message of checkAnswer(q, a)) errors.push({ questionId: q.id, message });
  }
  return errors;
}

function checkAnswer(q: Question, a: Answer): string[] {
  if (!(a.confidence >= 0 && a.confidence <= 1)) return ["confidence must be between 0 and 1"];
  if (q.needsHuman || q.type === "file_upload") {
    return a.value === null && a.needsUser ? [] : ["this question needs a human: value must be null and needsUser set"];
  }
  if (a.value === null) {
    return q.required && !a.needsUser ? ["required question: give a value or set needsUser"] : [];
  }
  const v = a.value;
  if (v.kind !== expectedKind[q.type]) return [`value.kind must be "${expectedKind[q.type]}" for ${q.type}`];

  const labels = new Set((q.options ?? []).map((o) => o.label));
  const checkOption = (option: string, otherText: string | null): string | null => {
    if (labels.has(option)) return null;
    if (option === OTHER_OPTION) {
      if (!q.hasOther) return `"${OTHER_OPTION}" is not allowed, the question has no Other option`;
      return otherText?.trim() ? null : `otherText is required with "${OTHER_OPTION}"`;
    }
    return `"${option}" is not one of the options`;
  };

  switch (v.kind) {
    case "text": {
      if (q.required && !v.text.trim()) return ["required question: text is empty"];
      const err = q.validation ? checkTextValidation(q.validation, v.text) : null;
      return err ? [err] : [];
    }
    case "choice": {
      const err = checkOption(v.option, v.otherText);
      return err ? [err] : [];
    }
    case "choices": {
      const errs = v.options.map((o) => checkOption(o, v.otherText)).filter((e): e is string => e !== null);
      if (new Set(v.options).size !== v.options.length) errs.push("options contain duplicates");
      if (q.required && v.options.length === 0) errs.push("required question: pick at least one option");
      if (q.validation?.kind === "checkbox_count") {
        const n = v.options.length;
        const { op, value } = q.validation;
        const ok = op === "at_least" ? n >= value : op === "at_most" ? n <= value : n === value;
        if (!ok) errs.push(q.validation.message ?? `pick ${op.replace("_", " ")} ${value} options`);
      }
      return errs;
    }
    case "scale": {
      const s = q.scale;
      if (!s) return ["question has no scale definition"];
      return Number.isInteger(v.value) && v.value >= s.min && v.value <= s.max
        ? []
        : [`scale value must be an integer from ${s.min} to ${s.max}`];
    }
    case "grid": {
      const g = q.grid;
      if (!g) return ["question has no grid definition"];
      const errs: string[] = [];
      const rowIds = new Set(g.rows.map((r) => r.id));
      const cols = new Set(g.columns);
      const answered = new Set<string>();
      for (const r of v.rows) {
        if (!rowIds.has(r.rowId)) errs.push(`unknown grid row "${r.rowId}"`);
        if (answered.has(r.rowId)) errs.push(`grid row "${r.rowId}" answered twice`);
        answered.add(r.rowId);
        for (const c of r.columns) if (!cols.has(c)) errs.push(`"${c}" is not a column of row "${r.rowId}"`);
        if (q.type === "radio_grid" && r.columns.length > 1) errs.push(`row "${r.rowId}" takes exactly one column`);
      }
      if (q.required) {
        for (const r of g.rows) {
          const row = v.rows.find((x) => x.rowId === r.id);
          if (!row || row.columns.length === 0) errs.push(`required grid row "${r.id}" has no answer`);
        }
      }
      return errs;
    }
    case "date": {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.date);
      if (!m) return ["date must be YYYY-MM-DD"];
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? [] : ["date does not exist"];
    }
    case "time":
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(v.time) ? [] : ["time must be HH:MM (24h)"];
  }
}

function checkTextValidation(rule: NonNullable<Question["validation"]>, text: string): string | null {
  const fail = (fallback: string) => rule.message ?? fallback;
  switch (rule.kind) {
    case "length":
      if (rule.op === "max_chars" && text.length > rule.value) return fail(`at most ${rule.value} characters`);
      if (rule.op === "min_chars" && text.length < rule.value) return fail(`at least ${rule.value} characters`);
      return null;
    case "number": {
      const n = Number(text.trim());
      if (text.trim() === "" || !Number.isFinite(n)) return fail("must be a number");
      const a = rule.value ?? 0;
      const b = rule.value2 ?? 0;
      const ok = {
        gt: n > a,
        gte: n >= a,
        lt: n < a,
        lte: n <= a,
        eq: n === a,
        neq: n !== a,
        between: n >= a && n <= b,
        not_between: n < a || n > b,
        is_number: true,
        is_integer: Number.isInteger(n),
      }[rule.op];
      return ok ? null : fail(`number must satisfy ${rule.op} ${rule.value ?? ""} ${rule.value2 ?? ""}`.trim());
    }
    case "text": {
      const ok = {
        contains: text.includes(rule.value ?? ""),
        not_contains: !text.includes(rule.value ?? ""),
        // ponytail: loose shape checks; Google re-validates on submit and we repair from its error message
        email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text),
        url: /^https?:\/\/\S+$/.test(text),
      }[rule.op];
      return ok ? null : fail(`text must satisfy ${rule.op} ${rule.value ?? ""}`.trim());
    }
    case "regex": {
      let re: RegExp;
      try {
        re = new RegExp(rule.value);
      } catch {
        return null; // pattern from the form isn't valid JS regex; leave it to Google's own check
      }
      const ok = {
        matches: new RegExp(`^(?:${rule.value})$`).test(text),
        not_matches: !new RegExp(`^(?:${rule.value})$`).test(text),
        contains: re.test(text),
        not_contains: !re.test(text),
      }[rule.op];
      return ok ? null : fail(`text must satisfy regex ${rule.op} /${rule.value}/`);
    }
    case "checkbox_count":
      return null;
  }
}
