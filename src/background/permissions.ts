import { browser } from "wxt/browser";
import { originPattern } from "../shared/permissions";

/** The options page requests the permission; the worker only checks it before every call. */
export async function hasOriginPermission(origin: string): Promise<boolean> {
  return browser.permissions.contains({ origins: [originPattern(origin)] });
}
