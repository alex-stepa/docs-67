import type { ProviderSettings } from "../shared/settings";
import { createAnthropicProvider } from "./anthropic";
import { createGeminiProvider } from "./gemini";
import { createOpenAIProvider } from "./openai";
import type { LLMProvider } from "./types";

export function createProvider(settings: ProviderSettings, apiKey: string): LLMProvider {
  const { model, temperature, effort } = settings;
  switch (settings.provider) {
    case "anthropic":
      return createAnthropicProvider({ apiKey, model, effort: effort ?? "medium" });
    case "openai":
      return createOpenAIProvider({ apiKey, model, temperature });
    case "openai_compatible":
      if (!settings.baseUrl) throw new Error("OpenAI-compatible provider needs a base URL");
      return createOpenAIProvider({ apiKey, model, temperature, baseUrl: settings.baseUrl });
    case "gemini":
      return createGeminiProvider({ apiKey, model, temperature });
  }
}
