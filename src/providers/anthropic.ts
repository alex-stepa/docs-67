import Anthropic from "@anthropic-ai/sdk";
import { codeForStatus, isAbort, parseJsonOutput, parseRetryAfter, ProviderError } from "./types";
import type { LLMProvider } from "./types";

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  effort?: "low" | "medium" | "high";
}

const BASE_URL = "https://api.anthropic.com";
const MAX_TOKENS = 32_000;

// Server-side refusal fallback ("default" form) is accepted on these model lines only;
// Haiku 5.5 has none and older models reject the parameter.
const FALLBACK_MODELS = /^claude-(opus-5|fable-5|mythos-5|sonnet-5-5)/;

export function createAnthropicProvider(cfg: AnthropicConfig): LLMProvider {
  const client = () =>
    new Anthropic({
      apiKey: cfg.apiKey,
      baseURL: BASE_URL,
      maxRetries: 0, // retry.ts owns retries
      // Sends anthropic-dangerous-direct-browser-access; the key never leaves this extension.
      dangerouslyAllowBrowser: true,
    });

  return {
    id: "anthropic",
    model: cfg.model,
    origin: BASE_URL,

    async complete(req, { signal, onProgress }) {
      const withFallback = FALLBACK_MODELS.test(cfg.model);
      try {
        const stream = client().beta.messages.stream(
          {
            model: cfg.model,
            max_tokens: MAX_TOKENS,
            system: req.system,
            messages: [{ role: "user", content: req.user }],
            // No temperature (rejected by current models) and no forced tool_choice
            // (rejected by Opus 5.5 / Sonnet 5.5): structured output does the job.
            output_config: {
              ...(cfg.effort ? { effort: cfg.effort } : {}),
              format: { type: "json_schema", schema: req.schema },
            },
            ...(withFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { signal },
        );
        if (onProgress) stream.on("text", onProgress);
        const msg = await stream.finalMessage();

        if (msg.stop_reason === "refusal") {
          const why = msg.stop_details?.explanation ?? msg.stop_details?.category ?? "no details";
          throw new ProviderError("refusal", `model declined the request (${why})`);
        }
        if (msg.stop_reason === "max_tokens") {
          throw new ProviderError("truncated", "output hit max_tokens before the JSON was complete");
        }
        const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        return parseJsonOutput(text);
      } catch (e) {
        throw toProviderError(e, signal);
      }
    },

    async testConnection(signal) {
      try {
        const m = await client().models.retrieve(cfg.model, {}, { signal });
        return { ok: true, model: m.id };
      } catch (e) {
        return { ok: false, error: toProviderError(e, signal).message };
      }
    },
  };
}

function toProviderError(e: unknown, signal?: AbortSignal): ProviderError {
  if (e instanceof ProviderError) return e;
  if (isAbort(e, signal)) return new ProviderError("aborted", "stopped");
  if (e instanceof Anthropic.APIError) {
    const status = e.status;
    // 400 overloaded_error can also arrive mid-stream as an SSE error event.
    const overloaded = (e.error as { error?: { type?: string } } | undefined)?.error?.type === "overloaded_error";
    const code = overloaded ? "overloaded" : codeForStatus(status);
    return new ProviderError(code, `Anthropic: ${e.message}`, status, parseRetryAfter(e.headers));
  }
  return new ProviderError("network", `Anthropic: ${(e as Error)?.message ?? String(e)}`);
}
