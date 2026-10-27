import { browser } from "wxt/browser";
import { ProviderSettings } from "../shared/settings";
import type { ProviderId } from "../shared/settings";

// API keys and settings live in storage.local. Only the service worker reads keys;
// extension pages get `hasKey`, never the value. storage.local is not encrypted at rest.
const keyName = (p: ProviderId) => `apiKey:${p}`;
const SETTINGS = "settings";

export async function getApiKey(provider: ProviderId): Promise<string | undefined> {
  const v = (await browser.storage.local.get(keyName(provider)))[keyName(provider)];
  return typeof v === "string" && v ? v : undefined;
}

export async function setApiKey(provider: ProviderId, key: string | null): Promise<void> {
  if (key === null || key.trim() === "") await browser.storage.local.remove(keyName(provider));
  else await browser.storage.local.set({ [keyName(provider)]: key.trim() });
}

export async function getSettings(): Promise<ProviderSettings | undefined> {
  const raw = (await browser.storage.local.get(SETTINGS))[SETTINGS];
  const parsed = ProviderSettings.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export async function saveSettings(settings: ProviderSettings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS]: settings });
}
