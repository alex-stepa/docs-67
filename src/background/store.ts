import { browser } from "wxt/browser";
import { RunState } from "../shared/state";
import type { BroadcastMessage } from "../shared/messages";

const keyOf = (tabId: number) => `run:${tabId}`;

export async function readState(tabId: number): Promise<RunState | undefined> {
  const raw = (await browser.storage.session.get(keyOf(tabId)))[keyOf(tabId)];
  const parsed = RunState.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export async function writeState(state: RunState): Promise<RunState> {
  const next = { ...state, updatedAt: Date.now() };
  await browser.storage.session.set({ [keyOf(state.tabId)]: next });
  broadcast({ type: "state.changed", tabId: state.tabId, state: next });
  return next;
}

export async function clearState(tabId: number): Promise<void> {
  await browser.storage.session.remove(keyOf(tabId));
}

// ponytail: one in-memory queue per tab serializes read-modify-write; enough for one
// worker instance, which is all MV3 runs.
const queues = new Map<number, Promise<unknown>>();

export function withTabLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(tabId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(tabId, tail);
  void tail.then(() => {
    if (queues.get(tabId) === tail) queues.delete(tabId);
  });
  return run;
}

/** Fire and forget: no listener (panel closed) is not an error. */
export function broadcast(msg: BroadcastMessage): void {
  browser.runtime.sendMessage(msg).catch(() => {});
}
