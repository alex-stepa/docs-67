import { z } from "zod";

export const ProviderId = z.enum(["anthropic", "openai", "gemini", "openai_compatible"]);
export type ProviderId = z.infer<typeof ProviderId>;

// The API key is stored separately (see background/keys.ts), never in this object.
export const ProviderSettings = z.object({
  provider: ProviderId,
  model: z.string().min(1),
  baseUrl: z.url().optional(), // openai_compatible only
  temperature: z.number().min(0).max(2).optional(), // ignored by Anthropic
  effort: z.enum(["low", "medium", "high"]).optional(), // Anthropic only
  confidenceThreshold: z.number().min(0).max(1).default(0.7),
});
export type ProviderSettings = z.infer<typeof ProviderSettings>;

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-5",
  gemini: "gemini-2.5-pro",
  openai_compatible: "",
};
