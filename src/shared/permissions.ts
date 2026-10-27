import type { ProviderSettings } from "./settings";

const FIXED_ORIGINS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
} as const;

/** Origin the chosen provider talks to. */
export function endpointOrigin(settings: Pick<ProviderSettings, "provider" | "baseUrl">): string {
  if (settings.provider !== "openai_compatible") return FIXED_ORIGINS[settings.provider];
  if (!settings.baseUrl) throw new Error("OpenAI-compatible provider needs a base URL");
  return new URL(settings.baseUrl).origin;
}

/**
 * Match pattern to pass to browser.permissions.request() from the options page
 * (must run in a user-gesture handler, so it can't live in the service worker).
 * Ports are dropped: a pattern without a port matches every port.
 */
export function originPattern(origin: string): string {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}
