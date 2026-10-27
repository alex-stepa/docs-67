import OpenAI from "openai";
import { codeForStatus, isAbort, parseJsonOutput, parseRetryAfter, ProviderError } from "./types";
import type { LLMProvider, LLMRequest } from "./types";

export interface OpenAIConfig {
  apiKey: string;
  model: string;
  temperature?: number;
  /** Set for "OpenAI-compatible" servers (Ollama, OpenRouter, ...). */
  baseUrl?: string;
}

const OPENAI_URL = "https://api.openai.com/v1";

export function createOpenAIProvider(cfg: OpenAIConfig): LLMProvider {
  const compatible = cfg.baseUrl !== undefined;
  const baseURL = cfg.baseUrl ?? OPENAI_URL;
  const client = () =>
    new OpenAI({
      // Local servers like Ollama take no key, but the SDK requires a non-empty one.
      apiKey: cfg.apiKey || "no-key",
      baseURL,
      maxRetries: 0, // retry.ts owns retries
      dangerouslyAllowBrowser: true,
    });

  // Some compatible servers reject json_schema; after the first 400 we use json_object
  // + the schema in the prompt for the rest of this provider's life. zod still validates.
  let jsonObjectOnly = false;

  async function run(req: LLMRequest, signal: AbortSignal, onProgress?: (d: string) => void) {
    const system = jsonObjectOnly
      ? `${req.system}\n\nReply with a single JSON object matching this JSON schema:\n${JSON.stringify(req.schema)}`
      : req.system;
    const stream = await client().chat.completions.create(
      {
        model: cfg.model,
        stream: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: req.user },
        ],
        ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
        response_format: jsonObjectOnly
          ? { type: "json_object" }
          : { type: "json_schema", json_schema: { name: req.schemaName, schema: req.schema, strict: true } },
      },
      { signal },
    );
    let text = "";
    let finish: string | null | undefined;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta?.content ?? "";
      if (choice?.delta && "refusal" in choice.delta && choice.delta.refusal) {
        throw new ProviderError("refusal", `model declined the request (${choice.delta.refusal})`);
      }
      if (delta) {
        text += delta;
        onProgress?.(delta);
      }
      finish = choice?.finish_reason ?? finish;
    }
    if (finish === "length") throw new ProviderError("truncated", "output hit the token limit before the JSON was complete");
    if (finish === "content_filter") throw new ProviderError("refusal", "output blocked by the content filter");
    return parseJsonOutput(text);
  }

  return {
    id: compatible ? "openai_compatible" : "openai",
    model: cfg.model,
    origin: new URL(baseURL).origin,

    async complete(req, { signal, onProgress }) {
      try {
        return await run(req, signal, onProgress);
      } catch (e) {
        const err = toProviderError(e, signal);
        if (compatible && !jsonObjectOnly && err.code === "bad_request") {
          jsonObjectOnly = true;
          try {
            return await run(req, signal, onProgress);
          } catch (e2) {
            throw toProviderError(e2, signal);
          }
        }
        throw err;
      }
    },

    async testConnection(signal) {
      try {
        const m = await client().models.retrieve(cfg.model, { signal });
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
  if (e instanceof OpenAI.APIError) {
    return new ProviderError(codeForStatus(e.status), `OpenAI: ${e.message}`, e.status, parseRetryAfter(e.headers));
  }
  return new ProviderError("network", `OpenAI: ${(e as Error)?.message ?? String(e)}`);
}
