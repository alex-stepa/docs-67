import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { fillPage } from "../providers/fill-page";
import { buildPageRequest, hashRequest, withRepair } from "../providers/prompt";
import { createProvider } from "../providers/registry";
import { ProviderError } from "../providers/types";
import type { LLMProvider, LLMRequest } from "../providers/types";
import type { Answer } from "../shared/answer";
import type { Form, Page } from "../shared/form";
import { ContentMessage, UiMessage } from "../shared/messages";
import type { Reply, ToContentMessage } from "../shared/messages";
import { endpointOrigin } from "../shared/permissions";
import { currentPage } from "../shared/state";
import type { RunState, RunStatus } from "../shared/state";
import { getApiKey, getSettings, saveSettings, setApiKey } from "./keys";
import { hasOriginPermission } from "./permissions";
import { broadcast, clearState, readState, withTabLock, writeState } from "./store";

const FORMS_PREFIX = "https://docs.google.com/forms/";
const MAX_REPAIRS = 2;

// In-flight LLM calls, per tab. Lost on worker restart; loadRun() handles that.
const controllers = new Map<number, AbortController>();

class UserError extends Error {}

export async function handleMessage(raw: unknown, sender: Browser.runtime.MessageSender): Promise<Reply> {
  try {
    if (isExtensionPage(sender)) return { ok: true, data: await handleUi(UiMessage.parse(raw)) };
    const tabId = sender.tab?.id;
    if (isFormsContentScript(sender) && tabId !== undefined) {
      return { ok: true, data: await handleContent(ContentMessage.parse(raw), tabId) };
    }
    return { ok: false, error: "sender not allowed" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function onTabRemoved(tabId: number): Promise<void> {
  controllers.get(tabId)?.abort();
  controllers.delete(tabId);
  return clearState(tabId);
}

function isExtensionPage(sender: Browser.runtime.MessageSender): boolean {
  return sender.id === browser.runtime.id && (sender.url?.startsWith(browser.runtime.getURL("/")) ?? false);
}

function isFormsContentScript(sender: Browser.runtime.MessageSender): boolean {
  return sender.id === browser.runtime.id && (sender.url?.startsWith(FORMS_PREFIX) ?? false);
}

// ---------- UI ----------

async function handleUi(msg: UiMessage): Promise<unknown> {
  switch (msg.type) {
    case "settings.get":
      return settingsView();

    case "settings.save":
      await saveSettings(msg.settings);
      if (msg.apiKey !== undefined) await setApiKey(msg.settings.provider, msg.apiKey);
      return settingsView();

    case "settings.test":
      return (await requireProvider()).testConnection();

    case "state.get":
      return withTabLock(msg.tabId, () => loadRun(msg.tabId));

    case "run.start":
      return withTabLock(msg.tabId, async () => {
        const s = await requireRun(msg.tabId);
        if (s.status === "calling_llm") throw new UserError("a request is already running; press Stop first");
        return writeState({
          ...s,
          mode: msg.mode,
          approvedFields: msg.approvedFields,
          instructions: msg.instructions,
          status: "awaiting_approval",
          pagePath: [currentPage(s)],
          answers: {},
          pending: undefined,
          repairAttempts: {},
          validationErrors: [],
          error: undefined,
        });
      });

    case "run.stop":
      controllers.get(msg.tabId)?.abort();
      await sendToContent(msg.tabId, { type: "stop" });
      return withTabLock(msg.tabId, async () => {
        const s = await readState(msg.tabId);
        return s ? writeState({ ...s, status: "stopped", pending: undefined }) : null;
      });

    case "fill.preview":
      return withTabLock(msg.tabId, async () => {
        const s = await requireRun(msg.tabId);
        assertStatus(s, ["awaiting_approval", "awaiting_user", "stopped", "error"]);
        const page = pageOf(s.form, currentPage(s));
        const request = buildPageRequest({ form: s.form, page, profileFields: s.approvedFields, instructions: s.instructions });
        return preview(s, page.index, request);
      });

    case "fill.run": {
      const { s, provider } = await withTabLock(msg.tabId, async () => {
        const s = await requireRun(msg.tabId);
        if (!s.pending || s.pending.hash !== msg.hash) throw new UserError("payload changed since preview; preview it again");
        if (s.pending.pageIndex !== currentPage(s)) throw new UserError("page changed since preview; preview it again");
        const provider = await requireProvider();
        return { s: await writeState({ ...s, status: "calling_llm", error: undefined }), provider };
      });
      return runLlm(s, provider, s.pending!.request, false);
    }

    case "fill.repair": {
      const { s, provider, request } = await withTabLock(msg.tabId, async () => {
        const s = await requireRun(msg.tabId);
        assertStatus(s, ["awaiting_user", "filling", "error"]);
        const page = pageOf(s.form, currentPage(s));
        const errors = s.validationErrors.filter((e) => page.questions.some((q) => q.id === e.questionId));
        if (errors.length === 0) throw new UserError("no validation errors on this page");
        const attempts = s.repairAttempts[String(page.index)] ?? 0;
        if (attempts >= MAX_REPAIRS) {
          // Out of AI attempts: hand those questions to the user.
          const answers = { ...s.answers };
          for (const e of errors) answers[e.questionId] = askUser(answers[e.questionId], e.questionId, `Form rejected the answer: ${e.message}`);
          await writeState({ ...s, answers, status: "awaiting_user" });
          throw new UserError(`AI could not fix this page in ${MAX_REPAIRS} attempts; answer the marked questions yourself`);
        }
        const provider = await requireProvider();
        // Only already-approved data, the model's own answers and the form's error messages.
        const base = buildPageRequest({ form: s.form, page, profileFields: s.approvedFields, instructions: s.instructions });
        const previous = { answers: page.questions.flatMap((q) => (s.answers[q.id] ? [s.answers[q.id]] : [])) };
        const request = withRepair(base, previous, errors);
        const next = await writeState({
          ...s,
          status: "calling_llm",
          repairAttempts: { ...s.repairAttempts, [String(page.index)]: attempts + 1 },
          error: undefined,
        });
        return { s: next, provider, request };
      });
      return runLlm(s, provider, request, true);
    }

    case "answers.update":
      return withTabLock(msg.tabId, async () => {
        const s = await requireRun(msg.tabId);
        const known = new Set(s.form.pages.flatMap((p) => p.questions.map((q) => q.id)));
        const answers = { ...s.answers };
        for (const a of msg.answers) {
          if (!known.has(a.questionId)) throw new UserError(`unknown question ${a.questionId}`);
          answers[a.questionId] = a;
        }
        return writeState({ ...s, answers });
      });

    case "fill.apply":
      return withTabLock(msg.tabId, async () => {
        const s = await requireRun(msg.tabId);
        if (s.mode === "dry_run") throw new UserError("dry run only suggests answers; start a fill run to write them");
        assertStatus(s, ["awaiting_user", "filling"]);
        const page = pageOf(s.form, currentPage(s));
        await sendToContent(s.tabId, { type: "fill.apply", pageIndex: page.index, answers: answersFor(s, page) }, true);
        return writeState({ ...s, status: "filling", validationErrors: [] });
      });

    case "nav.next":
      return withTabLock(msg.tabId, async () => {
        const s = await requireRun(msg.tabId);
        assertStatus(s, ["awaiting_user", "filling"]);
        await sendToContent(s.tabId, { type: "nav.next" }, true);
        return s;
      });

    case "run.review":
      return withTabLock(msg.tabId, async () => {
        const s = await requireRun(msg.tabId);
        assertStatus(s, ["awaiting_user", "filling", "review"]);
        return writeState({ ...s, status: "review" });
      });

    case "run.submit":
      // The only path to submitting: an explicit confirmation from an extension page,
      // and only from the review screen.
      return withTabLock(msg.tabId, async () => {
        const s = await requireRun(msg.tabId);
        assertStatus(s, ["review"]);
        await sendToContent(s.tabId, { type: "nav.submit" }, true);
        return writeState({ ...s, status: "submitting" });
      });
  }
}

async function preview(s: RunState, pageIndex: number, request: LLMRequest) {
  const settings = await getSettings();
  const hash = await hashRequest(request);
  await writeState({ ...s, status: "awaiting_approval", pending: { hash, pageIndex, request } });
  return {
    hash,
    request, // exactly what will be sent, minus the API key
    provider: settings?.provider ?? null,
    model: settings?.model ?? null,
    endpoint: settings ? safeOrigin(settings) : null,
  };
}

async function runLlm(s: RunState, provider: LLMProvider, request: LLMRequest, isRepair: boolean) {
  const tabId = s.tabId;
  const page = pageOf(s.form, currentPage(s));
  const ctrl = new AbortController();
  controllers.get(tabId)?.abort();
  controllers.set(tabId, ctrl);

  let chars = 0;
  let lastSent = 0;
  try {
    const { result, unresolved } = await fillPage(provider, request, page, {
      signal: ctrl.signal,
      onProgress: (d) => {
        chars += d.length;
        // ponytail: 200 ms throttle keeps the panel live without flooding it
        if (Date.now() - lastSent > 200) {
          lastSent = Date.now();
          broadcast({ type: "llm.progress", tabId, chars });
        }
      },
      onRetry: ({ attempt, delayMs, error }) => broadcast({ type: "llm.retry", tabId, attempt, delayMs, reason: error.message }),
    });

    return await withTabLock(tabId, async () => {
      const cur = await readState(tabId);
      if (!cur || cur.status !== "calling_llm") throw new UserError("run was stopped");
      const answers = { ...cur.answers };
      for (const a of result.answers) answers[a.questionId] = a;
      const threshold = (await getSettings())?.confidenceThreshold ?? 0.7;
      const needsUser = result.answers.some((a) => a.needsUser !== null || a.confidence < threshold);
      const autoFill = cur.mode === "fill_all" && !needsUser;
      const next = await writeState({
        ...cur,
        answers,
        pending: undefined,
        validationErrors: isRepair ? [] : cur.validationErrors,
        status: autoFill ? "filling" : "awaiting_user",
      });
      if (autoFill) await sendToContent(tabId, { type: "fill.apply", pageIndex: page.index, answers: answersFor(next, page) });
      return { state: next, result, unresolved };
    });
  } catch (e) {
    const aborted = e instanceof ProviderError && e.code === "aborted";
    await withTabLock(tabId, async () => {
      const cur = await readState(tabId);
      if (cur && cur.status === "calling_llm") {
        await writeState({ ...cur, status: aborted ? "stopped" : "error", error: aborted ? undefined : (e as Error).message });
      }
    });
    throw e;
  } finally {
    if (controllers.get(tabId) === ctrl) controllers.delete(tabId);
  }
}

// ---------- content script ----------

async function handleContent(msg: ContentMessage, tabId: number): Promise<unknown> {
  if (msg.type === "captcha.detected") controllers.get(tabId)?.abort();

  return withTabLock(tabId, async () => {
    const s = await loadRun(tabId);

    if (msg.type === "form.parsed") {
      if (s && s.formId === msg.form.formId) return writeState({ ...s, form: msg.form }); // reload: resume
      return writeState(newRun(tabId, msg.form));
    }
    if (!s) throw new UserError("form not parsed yet");

    switch (msg.type) {
      case "page.changed": {
        const i = s.pagePath.indexOf(msg.pageIndex);
        const pagePath = i >= 0 ? s.pagePath.slice(0, i + 1) : [...s.pagePath, msg.pageIndex]; // Back truncates
        const active: RunStatus[] = ["filling", "awaiting_user", "awaiting_approval"];
        return writeState({
          ...s,
          pagePath,
          pending: undefined,
          validationErrors: [],
          status: active.includes(s.status) ? "awaiting_approval" : s.status,
        });
      }
      case "fill.applied": {
        if (msg.failed.length > 0) return writeState({ ...s, status: "awaiting_user", validationErrors: msg.failed });
        if (!msg.hasNext) return writeState({ ...s, status: "review" });
        if (s.mode === "fill_all" && s.status === "filling") await sendToContent(tabId, { type: "nav.next" });
        return writeState({ ...s, status: s.mode === "fill_all" ? "filling" : "awaiting_user" });
      }
      case "page.validationErrors":
        return writeState({ ...s, status: "awaiting_user", validationErrors: msg.errors });
      case "captcha.detected":
        return writeState({ ...s, status: "blocked", pending: undefined, error: "CAPTCHA detected. Solve it yourself, then continue." });
      case "submit.done":
        return writeState({ ...s, status: "done", pending: undefined });
    }
  });
}

// ---------- helpers ----------

function newRun(tabId: number, form: Form): RunState {
  return {
    tabId,
    formId: form.formId,
    form,
    mode: "step_approval",
    status: "idle",
    pagePath: [0],
    approvedFields: [],
    instructions: "",
    answers: {},
    repairAttempts: {},
    validationErrors: [],
    updatedAt: Date.now(),
  };
}

/** Reads state and repairs a call that died with a previous worker instance. */
async function loadRun(tabId: number): Promise<RunState | undefined> {
  const s = await readState(tabId);
  if (s?.status === "calling_llm" && !controllers.has(tabId)) {
    return writeState({ ...s, status: "awaiting_approval", error: "Request was interrupted; approve the page again." });
  }
  return s;
}

async function requireRun(tabId: number): Promise<RunState> {
  const s = await loadRun(tabId);
  if (!s) throw new UserError("no Google Form detected in this tab yet");
  return s;
}

function assertStatus(s: RunState, allowed: RunStatus[]): void {
  if (!allowed.includes(s.status)) throw new UserError(`not allowed while status is "${s.status}"`);
}

function pageOf(form: Form, index: number): Page {
  const page = form.pages.find((p) => p.index === index);
  if (!page) throw new UserError(`page ${index} not found in the parsed form`);
  return page;
}

function answersFor(s: RunState, page: Page): Answer[] {
  return page.questions.flatMap((q) => {
    const a = s.answers[q.id];
    return a && a.value !== null ? [a] : [];
  });
}

function askUser(prev: Answer | undefined, questionId: string, why: string): Answer {
  return { questionId, value: null, confidence: 0, reasoning: prev?.reasoning ?? "", needsUser: why };
}

async function requireProvider(): Promise<LLMProvider> {
  const settings = await getSettings();
  if (!settings) throw new UserError("set up the AI provider in Options first");
  const key = await getApiKey(settings.provider);
  if (!key && settings.provider !== "openai_compatible") throw new UserError(`no API key saved for ${settings.provider}`);
  const origin = endpointOrigin(settings);
  if (!(await hasOriginPermission(origin))) throw new UserError(`access to ${origin} not granted; save the settings in Options again`);
  const provider = createProvider(settings, key ?? "");
  if (provider.origin !== origin) throw new Error(`provider origin mismatch: ${provider.origin} vs ${origin}`);
  return provider;
}

async function settingsView() {
  const settings = await getSettings();
  if (!settings) return { settings: null, hasKey: false, endpoint: null, permissionGranted: false };
  const endpoint = safeOrigin(settings);
  return {
    settings,
    hasKey: (await getApiKey(settings.provider)) !== undefined,
    endpoint,
    permissionGranted: endpoint ? await hasOriginPermission(endpoint) : false,
  };
}

function safeOrigin(settings: Parameters<typeof endpointOrigin>[0]): string | null {
  try {
    return endpointOrigin(settings);
  } catch {
    return null;
  }
}

async function sendToContent(tabId: number, msg: ToContentMessage, required = false): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, msg);
  } catch (e) {
    if (required) throw new UserError(`form page is not responding (reload the tab): ${(e as Error).message}`);
  }
}
