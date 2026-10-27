import { ApiError, FinishReason, GoogleGenAI } from "@google/genai";
import { codeForStatus, isAbort, parseJsonOutput, ProviderError } from "./types";
import type { LLMProvider } from "./types";

export interface GeminiConfig {
  apiKey: string;
  model: string;
  temperature?: number;
}

const ORIGIN = "https://generativelanguage.googleapis.com";

const BLOCKED: ReadonlySet<string> = new Set([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
]);

export function createGeminiProvider(cfg: GeminiConfig): LLMProvider {
  const client = () => new GoogleGenAI({ apiKey: cfg.apiKey });

  return {
    id: "gemini",
    model: cfg.model,
    origin: ORIGIN,

    async complete(req, { signal, onProgress }) {
      try {
        const stream = await client().models.generateContentStream({
          model: cfg.model,
          contents: req.user,
          config: {
            systemInstruction: req.system,
            responseMimeType: "application/json",
            responseJsonSchema: req.schema,
            ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
            abortSignal: signal,
          },
        });
        let text = "";
        let finish: string | undefined;
        for await (const chunk of stream) {
          if (chunk.promptFeedback?.blockReason) {
            throw new ProviderError("refusal", `prompt blocked (${chunk.promptFeedback.blockReason})`);
          }
          const delta = chunk.text ?? "";
          if (delta) {
            text += delta;
            onProgress?.(delta);
          }
          finish = chunk.candidates?.[0]?.finishReason ?? finish;
        }
        if (signal.aborted) throw new ProviderError("aborted", "stopped");
        if (finish && BLOCKED.has(finish)) throw new ProviderError("refusal", `output blocked (${finish})`);
        if (finish === FinishReason.MAX_TOKENS) {
          throw new ProviderError("truncated", "output hit the token limit before the JSON was complete");
        }
        return parseJsonOutput(text);
      } catch (e) {
        throw toProviderError(e, signal);
      }
    },

    async testConnection(signal) {
      try {
        const m = await client().models.get({ model: cfg.model, config: { abortSignal: signal } });
        return { ok: true, model: m.name ?? cfg.model };
      } catch (e) {
        return { ok: false, error: toProviderError(e, signal).message };
      }
    },
  };
}

function toProviderError(e: unknown, signal?: AbortSignal): ProviderError {
  if (e instanceof ProviderError) return e;
  if (isAbort(e, signal)) return new ProviderError("aborted", "stopped");
  // ponytail: the SDK doesn't expose response headers, so 429s fall back to our backoff
  if (e instanceof ApiError) return new ProviderError(codeForStatus(e.status), `Gemini: ${e.message}`, e.status);
  return new ProviderError("network", `Gemini: ${(e as Error)?.message ?? String(e)}`);
}
