import { describe, expect, it } from "vitest";
import { validateAgainstPage } from "../../src/shared/answer";
import type { Answer, AnswerValue } from "../../src/shared/answer";
import { page, validAnswers } from "../helpers";

const withValue = (id: string, value: AnswerValue | null, needsUser: string | null = null): Answer[] =>
  validAnswers.map((a) => (a.questionId === id ? { ...a, value, needsUser } : a));

const messages = (answers: Answer[]) => validateAgainstPage(page, answers).map((e) => `${e.questionId}: ${e.message}`);

describe("validateAgainstPage", () => {
  it("accepts a fully valid page", () => {
    expect(messages(validAnswers)).toEqual([]);
  });

  it("reports missing, unknown and duplicate entries", () => {
    const answers = [...validAnswers.slice(1), validAnswers[1]!, { ...validAnswers[0]!, questionId: "entry.99" }];
    expect(messages(answers)).toEqual(
      expect.arrayContaining(["entry.2: duplicate answer", "entry.99: unknown questionId", "entry.1: missing answer entry"]),
    );
  });

  it("enforces value kind per question type", () => {
    expect(messages(withValue("entry.4", { kind: "text", text: "4" }))).toEqual(['entry.4: value.kind must be "scale" for scale']);
  });

  it("checks options, Other and checkbox count", () => {
    expect(messages(withValue("entry.2", { kind: "choice", option: "Green", otherText: null }))).toEqual([
      'entry.2: "Green" is not one of the options',
    ]);
    expect(messages(withValue("entry.2", { kind: "choice", option: "__other__", otherText: " " }))).toEqual([
      'entry.2: otherText is required with "__other__"',
    ]);
    expect(messages(withValue("entry.3", { kind: "choices", options: ["CZ", "EN", "DE"], otherText: null }))).toEqual([
      "entry.3: pick at most 2 options",
    ]);
    expect(messages(withValue("entry.3", { kind: "choices", options: ["__other__"], otherText: "FR" }))).toEqual([
      'entry.3: "__other__" is not allowed, the question has no Other option',
    ]);
  });

  it("checks scale range and grid rows", () => {
    expect(messages(withValue("entry.4", { kind: "scale", value: 6 }))).toEqual(["entry.4: scale value must be an integer from 1 to 5"]);
    expect(
      messages(withValue("entry.5", { kind: "grid", rows: [{ rowId: "entry.5a", columns: ["Bad", "Good"] }, { rowId: "x", columns: ["Meh"] }] })),
    ).toEqual([
      'entry.5: row "entry.5a" takes exactly one column',
      'entry.5: unknown grid row "x"',
      'entry.5: "Meh" is not a column of row "x"',
      'entry.5: required grid row "entry.5b" has no answer',
    ]);
  });

  it("checks date, time and text validation", () => {
    expect(messages(withValue("entry.6", { kind: "date", date: "2026-02-30" }))).toEqual(["entry.6: date does not exist"]);
    expect(messages(withValue("entry.6", { kind: "date", date: "30.1.2026" }))).toEqual(["entry.6: date must be YYYY-MM-DD"]);
    expect(messages(withValue("entry.1", { kind: "text", text: "not-an-email" }))).toEqual(["entry.1: text must satisfy email"]);
  });

  it("requires needsUser when a required question has no value", () => {
    expect(messages(withValue("entry.1", null))).toEqual(["entry.1: required question: give a value or set needsUser"]);
    expect(messages(withValue("entry.1", null, "No e-mail in profile."))).toEqual([]);
  });

  it("never lets the model answer a needsHuman question", () => {
    expect(messages(withValue("entry.7", { kind: "text", text: "cv.pdf" }, null))).toEqual([
      "entry.7: this question needs a human: value must be null and needsUser set",
    ]);
  });
});
