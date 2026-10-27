import { LlmPageAnswers, validateAgainstPage } from "../shared/answer";
import type { Answer, AnswerError, PageAnswers } from "../shared/answer";
import type { Page } from "../shared/form";
import { withRepair } from "./prompt";
import { withRetry } from "./retry";
import type { RetryOptions } from "./retry";
import { ProviderError } from "./types";
import type { LLMProvider, LLMRequest } from "./types";

export interface FillPageOptions {
  signal: AbortSignal;
  onProgress?: (textDelta: string) => void;
  onRetry?: RetryOptions["onRetry"];
  /** Injected in tests to skip real backoff waits. */
  sleep?: RetryOptions["sleep"];
}

export interface FillPageResult {
  result: PageAnswers;
  /** Questions still invalid after the repair attempt; their value is null and needsUser set. */
  unresolved: AnswerError[];
  /** Every request actually sent, for the payload log. A repair adds only the model's own output and the errors. */
  sent: LLMRequest[];
}

/**
 * One page: call the model, check shape (zod) and meaning (validateAgainstPage),
 * and on failure retry once with the errors. Rate limits/5xx are retried separately.
 */
export async function fillPage(
  provider: LLMProvider,
  request: LLMRequest,
  page: Page,
  opts: FillPageOptions,
): Promise<FillPageResult> {
  const sent: LLMRequest[] = [];
  let req = request;

  for (let attempt = 1; attempt <= 2; attempt++) {
    sent.push(req);
    const output = await withRetry(() => provider.complete(req, { signal: opts.signal, onProgress: opts.onProgress }), {
      signal: opts.signal,
      onRetry: opts.onRetry,
      sleep: opts.sleep,
    });

    const parsed = LlmPageAnswers.safeParse(output);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
      if (attempt === 2) throw new ProviderError("bad_output", `model output has the wrong shape twice:\n${problems}`);
      req = withRepair(request, output, problems);
      continue;
    }

    const errors = validateAgainstPage(page, parsed.data.answers);
    if (errors.length === 0) {
      return { result: { pageIndex: page.index, answers: orderByPage(page, parsed.data.answers) }, unresolved: [], sent };
    }
    if (attempt === 2) {
      return {
        result: { pageIndex: page.index, answers: markUnresolved(page, parsed.data.answers, errors) },
        unresolved: errors.filter((e) => page.questions.some((q) => q.id === e.questionId)),
        sent,
      };
    }
    req = withRepair(request, output, errors);
  }
  throw new Error("unreachable");
}

function orderByPage(page: Page, answers: Answer[]): Answer[] {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  return page.questions.flatMap((q) => {
    const a = byId.get(q.id);
    return a ? [a] : [];
  });
}

// Keeps valid answers, turns invalid or missing ones into questions for the user.
function markUnresolved(page: Page, answers: Answer[], errors: AnswerError[]): Answer[] {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  return page.questions.map((q) => {
    const errs = errors.filter((e) => e.questionId === q.id).map((e) => e.message);
    const a = byId.get(q.id);
    if (a && errs.length === 0) return a;
    return {
      questionId: q.id,
      value: null,
      confidence: 0,
      reasoning: a?.reasoning ?? "",
      needsUser: `AI answer was invalid: ${errs.join("; ")}`,
    };
  });
}
