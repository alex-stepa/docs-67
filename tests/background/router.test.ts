import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { LLMProvider } from "../../src/providers/types";
import type { Answer } from "../../src/shared/answer";
import type { ProviderSettings } from "../../src/shared/settings";
import type { RunState } from "../../src/shared/state";
import { form, validAnswers } from "../helpers";

const complete = vi.fn<LLMProvider["complete"]>();
vi.mock("../../src/providers/registry", () => ({
  createProvider: (): LLMProvider => ({
    id: "anthropic",
    model: "claude-opus-5-5",
    origin: "https://api.anthropic.com",
    complete,
    testConnection: async () => ({ ok: true, model: "claude-opus-5-5" }),
  }),
}));

const { handleMessage, onTabRemoved } = await import("../../src/background/router");
const { writeState } = await import("../../src/background/store");

const TAB = 7;
const ui = () => ({ id: fakeBrowser.runtime.id, url: fakeBrowser.runtime.getURL("/sidepanel.html") });
const content = () => ({ id: fakeBrowser.runtime.id, url: "https://docs.google.com/forms/d/e/x/viewform", tab: { id: TAB } as any });
const settings: ProviderSettings = { provider: "anthropic", model: "claude-opus-5-5", confidenceThreshold: 0.7 };

let toContent: unknown[];
let granted: boolean;

async function call(msg: unknown, sender = ui()) {
  return handleMessage(msg, sender as any);
}
async function ok(msg: unknown, sender = ui()): Promise<any> {
  const r = await call(msg, sender);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.data;
}
const state = async (): Promise<RunState> => ok({ type: "state.get", tabId: TAB });

async function startRun(mode: "fill_all" | "step_approval" | "dry_run" = "fill_all") {
  await ok({ type: "settings.save", settings, apiKey: "sk-ant-secret" });
  await ok({ type: "form.parsed", form }, content());
  await ok({
    type: "run.start",
    tabId: TAB,
    mode,
    approvedFields: [{ key: "email", label: "E-mail", value: "jan@example.com" }],
    instructions: "I like green.",
  });
  return ok({ type: "fill.preview", tabId: TAB });
}

beforeEach(() => {
  fakeBrowser.reset();
  complete.mockReset();
  toContent = [];
  granted = true;
  vi.spyOn(fakeBrowser.permissions, "contains").mockImplementation(async () => granted);
  vi.spyOn(fakeBrowser.tabs, "sendMessage").mockImplementation(async (_tab: number, msg: unknown) => {
    toContent.push(msg);
  });
});

describe("senders", () => {
  it("rejects unknown senders and UI messages from the forms page", async () => {
    expect(await call({ type: "settings.get" }, { id: "other", url: "https://evil.example/" } as any)).toEqual({
      ok: false,
      error: "sender not allowed",
    });
    const r = await call({ type: "run.submit", tabId: TAB, confirmed: true }, content());
    expect(r.ok).toBe(false);
  });

  it("content script tabId comes from the sender, not the payload", async () => {
    await ok({ type: "form.parsed", form, tabId: 999 }, content());
    expect((await state()).tabId).toBe(TAB);
  });
});

describe("settings and keys", () => {
  it("stores the key but never returns it", async () => {
    const view = await ok({ type: "settings.save", settings, apiKey: "sk-ant-secret" });
    expect(view).toMatchObject({ hasKey: true, endpoint: "https://api.anthropic.com", permissionGranted: true });
    expect(JSON.stringify(await ok({ type: "settings.get" }))).not.toContain("sk-ant-secret");
    expect(await fakeBrowser.storage.local.get("apiKey:anthropic")).toEqual({ "apiKey:anthropic": "sk-ant-secret" });

    await ok({ type: "settings.save", settings, apiKey: null });
    expect((await ok({ type: "settings.get" })).hasKey).toBe(false);
  });

  it("refuses to call the provider without host permission", async () => {
    const preview = await startRun();
    granted = false;
    const r = await call({ type: "fill.run", tabId: TAB, hash: preview.hash });
    expect(r).toEqual({ ok: false, error: "access to https://api.anthropic.com not granted; save the settings in Options again" });
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("fill flow", () => {
  it("fill_all: preview -> run sends exactly the previewed payload, then fills and goes next", async () => {
    const preview = await startRun("fill_all");
    expect(preview.request.user).toContain("jan@example.com");
    expect(preview).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", endpoint: "https://api.anthropic.com" });

    const confident = validAnswers.map((a) => ({ ...a, confidence: 0.9 }));
    complete.mockResolvedValue({ answers: confident });
    const out = await ok({ type: "fill.run", tabId: TAB, hash: preview.hash });

    expect(complete.mock.calls[0]![0]).toEqual(preview.request);
    expect(out.state.status).toBe("awaiting_user"); // entry.6/7 have needsUser
    expect(toContent).toEqual([]);

    // user answers the rest, then applies
    await ok({ type: "fill.apply", tabId: TAB });
    expect(toContent[0]).toMatchObject({ type: "fill.apply", pageIndex: 0 });
    expect((toContent[0] as any).answers.map((a: Answer) => a.questionId)).toEqual(["entry.1", "entry.2", "entry.3", "entry.4", "entry.5"]);

    // fill_all: once the user applied the page, the run continues on its own
    await ok({ type: "fill.applied", pageIndex: 0, failed: [], hasNext: true }, content());
    expect(toContent[1]).toEqual({ type: "nav.next" });
    expect((await state()).status).toBe("filling");
  });

  it("step_approval: never clicks Next on its own", async () => {
    const preview = await startRun("step_approval");
    complete.mockResolvedValue({ answers: validAnswers });
    await ok({ type: "fill.run", tabId: TAB, hash: preview.hash });
    await ok({ type: "fill.apply", tabId: TAB });
    await ok({ type: "fill.applied", pageIndex: 0, failed: [], hasNext: true }, content());
    expect(toContent.map((m: any) => m.type)).toEqual(["fill.apply"]);
    expect((await state()).status).toBe("awaiting_user");
    await ok({ type: "nav.next", tabId: TAB });
    expect(toContent.at(-1)).toEqual({ type: "nav.next" });
  });

  it("fill_all with confident answers fills and clicks Next on its own", async () => {
    const preview = await startRun("fill_all");
    const confident = validAnswers.map((a) => ({ ...a, confidence: 0.9, needsUser: null })).slice(0, 5);
    const page0 = form.pages[0]!;
    const onlyFive = { ...page0, questions: page0.questions.slice(0, 5) };
    await ok({ type: "form.parsed", form: { ...form, pages: [onlyFive] } }, content());
    const p2 = await ok({ type: "fill.preview", tabId: TAB });
    expect(p2.hash).not.toBe(preview.hash);

    complete.mockResolvedValue({ answers: confident });
    const out = await ok({ type: "fill.run", tabId: TAB, hash: p2.hash });
    expect(out.state.status).toBe("filling");
    expect(toContent).toHaveLength(1);

    await ok({ type: "fill.applied", pageIndex: 0, failed: [], hasNext: true }, content());
    expect(toContent[1]).toEqual({ type: "nav.next" });

    await ok({ type: "page.changed", pageIndex: 0 }, content());
    expect((await state()).status).toBe("awaiting_approval");
  });

  it("a stale hash is refused and nothing is sent", async () => {
    await startRun();
    const r = await call({ type: "fill.run", tabId: TAB, hash: "deadbeef" });
    expect(r).toEqual({ ok: false, error: "payload changed since preview; preview it again" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("dry run never writes into the page", async () => {
    const preview = await startRun("dry_run");
    complete.mockResolvedValue({ answers: validAnswers });
    await ok({ type: "fill.run", tabId: TAB, hash: preview.hash });
    expect(await call({ type: "fill.apply", tabId: TAB })).toMatchObject({ ok: false });
    expect(toContent).toEqual([]);
  });

  it("Stop aborts the in-flight call", async () => {
    const preview = await startRun();
    complete.mockImplementation(
      (_req, { signal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    );
    const running = call({ type: "fill.run", tabId: TAB, hash: preview.hash });
    await vi.waitFor(() => expect(complete).toHaveBeenCalled());
    await ok({ type: "run.stop", tabId: TAB });
    expect((await running).ok).toBe(false);
    expect((await state()).status).toBe("stopped");
    expect(toContent).toContainEqual({ type: "stop" });
  });

  it("form validation errors get at most 2 AI repairs, then go to the user", async () => {
    const preview = await startRun("step_approval");
    complete.mockResolvedValue({ answers: validAnswers });
    await ok({ type: "fill.run", tabId: TAB, hash: preview.hash });
    await ok({ type: "fill.apply", tabId: TAB });

    for (let i = 0; i < 2; i++) {
      await ok({ type: "fill.applied", pageIndex: 0, failed: [{ questionId: "entry.1", message: "Must be a valid email" }], hasNext: true }, content());
      await ok({ type: "fill.repair", tabId: TAB });
      expect(complete.mock.calls.at(-1)![0].user).toContain("entry.1: Must be a valid email");
    }
    await ok({ type: "page.validationErrors", errors: [{ questionId: "entry.1", message: "Must be a valid email" }] }, content());
    const r = await call({ type: "fill.repair", tabId: TAB });
    expect(r).toMatchObject({ ok: false });
    expect(complete).toHaveBeenCalledTimes(3);
    const s = await state();
    expect(s.answers["entry.1"]).toMatchObject({ value: null, needsUser: "Form rejected the answer: Must be a valid email" });
  });
});

describe("submit gate", () => {
  it("submits only from review, only with confirmed: true", async () => {
    await startRun();
    expect(await call({ type: "run.submit", tabId: TAB, confirmed: true })).toMatchObject({ ok: false });
    expect(await call({ type: "run.submit", tabId: TAB, confirmed: false })).toMatchObject({ ok: false });

    await writeState({ ...(await state()), status: "awaiting_user" });
    await ok({ type: "run.review", tabId: TAB });
    await ok({ type: "run.submit", tabId: TAB, confirmed: true });
    expect(toContent).toEqual([{ type: "nav.submit" }]);
    await ok({ type: "submit.done" }, content());
    expect((await state()).status).toBe("done");
  });

  it("last page goes to review instead of Next", async () => {
    const preview = await startRun("step_approval");
    complete.mockResolvedValue({ answers: validAnswers });
    await ok({ type: "fill.run", tabId: TAB, hash: preview.hash });
    await ok({ type: "fill.apply", tabId: TAB });
    await ok({ type: "fill.applied", pageIndex: 0, failed: [], hasNext: false }, content());
    expect((await state()).status).toBe("review");
    expect(toContent.filter((m: any) => m.type === "nav.next")).toEqual([]);
  });
});

describe("state and resume", () => {
  it("CAPTCHA blocks the run", async () => {
    await startRun();
    await ok({ type: "captcha.detected" }, content());
    expect(await state()).toMatchObject({ status: "blocked", error: expect.stringContaining("CAPTCHA") });
  });

  it("reload of the same form keeps progress; another form starts fresh", async () => {
    await startRun();
    await ok({ type: "answers.update", tabId: TAB, answers: [validAnswers[0]] });
    await ok({ type: "form.parsed", form }, content());
    expect((await state()).answers["entry.1"]).toEqual(validAnswers[0]);

    await ok({ type: "form.parsed", form: { ...form, formId: "other" } }, content());
    expect(await state()).toMatchObject({ formId: "other", status: "idle", answers: {} });
  });

  it("a call lost with a previous worker asks for approval again", async () => {
    await startRun();
    await writeState({ ...(await state()), status: "calling_llm" });
    expect(await state()).toMatchObject({ status: "awaiting_approval", error: expect.stringContaining("interrupted") });
  });

  it("state lives in storage.session and is cleared when the tab closes", async () => {
    await startRun();
    expect(Object.keys(await fakeBrowser.storage.session.get())).toEqual([`run:${TAB}`]);
    expect(Object.keys(await fakeBrowser.storage.local.get())).not.toContain(`run:${TAB}`);
    await onTabRemoved(TAB);
    expect(await fakeBrowser.storage.session.get()).toEqual({});
  });

  it("branching: going back truncates the page path", async () => {
    await startRun();
    for (const p of [2, 5]) await ok({ type: "page.changed", pageIndex: p }, content());
    expect((await state()).pagePath).toEqual([0, 2, 5]);
    await ok({ type: "page.changed", pageIndex: 2 }, content());
    expect((await state()).pagePath).toEqual([0, 2]);
  });
});
