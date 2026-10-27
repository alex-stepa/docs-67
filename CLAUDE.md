# Instructions for Claude Code

These instructions are intended for Claude Code only and apply to this directory and its subdirectories. More specific Claude Code instructions in subdirectories take precedence. They do not configure Codex or define instructions for other contributors.

## Project Status

Chrome extension (Manifest V3, WXT + TypeScript, React, zod, Vitest) that reads the Google Form in the active tab and lets an LLM fill it page by page, never submitting without the user's confirmation. Full requirements: `docs/SPEC.md`. Backend design (draft, awaiting approval): `docs/backend-architecture.md`.

No application code, build commands, or test commands yet. Update this section when code is added.

## Scope for Claude Code: backend only

- Own: `src/background.ts` (service worker), `src/providers/`, `src/shared/` (data models and message contract), session state, API key handling, host permissions, payload building.
- Do not implement `parser/`, `filler/`, `ui/`, the options page, or the side panel unless the user asks; those belong to the Codex contributor.
- `src/shared/` is the contract between both sides. Change it only with the user's agreement and call out every change in the handoff.
- Hard rules from the spec that the backend enforces: LLM calls only from the service worker; the API key lives in `chrome.storage.local` and goes only to the chosen endpoint; only user-approved data goes into the LLM payload, and the exact payload can be shown before sending; never submit a form without confirmation; never bypass CAPTCHA.
- Providers must be testable without a browser (mock `fetch`, recorded fixtures).
- Before using Anthropic API details (model IDs, headers, streaming), load the `claude-api` skill instead of relying on memory.

## Communication

- Respond in English unless the user chooses another language.
- Be concise, clear, and specific.
- Carry out actionable requests directly. Ask questions only when missing information would materially affect the result.
- During longer tasks, share meaningful progress updates and findings.
- Distinguish verified facts from estimates and assumptions.

## Working with Files

- Read relevant files first and follow their existing structure and style.
- Preserve existing content unrelated to the request.
- Make focused changes; avoid unnecessary dependencies and unrelated edits.
- Do not delete or overwrite other people's work in progress.
- Store working scripts, drafts, and temporary data in `work/`.
- Store finished deliverables in `outputs/` unless the request specifies another location. Edit project files and configuration in their appropriate locations.
- Never include passwords, access tokens, or other secrets in files or outputs.

## Collaboration with a Contributor Using Codex

- Another person works on this repository using Codex. Treat their changes as a collaborator's work and preserve them.
- Keep Claude Code instructions in `CLAUDE.md`. Do not edit, delete, or synchronize `AGENTS.md` or Codex configuration unless the user explicitly requests it.
- Before editing shared files, inspect the current Git status and relevant diffs. Re-read files that changed during your work before applying further edits.
- Keep changes focused on the assigned task. Do not reformat or refactor unrelated code written by the collaborator.
- Never discard the collaborator's changes, reset their work, or force-push over shared history.
- When committing, stage only changes belonging to the current task. Do not include another contributor's uncommitted work.
- If edits overlap and the intended result is unclear, explain the conflict and ask the user before overwriting either version.
- Leave a concise handoff describing changed files, verification, and any unfinished work.

## Verification and Completion

- Verify the result appropriately for the type of change. For code, run relevant available checks; for documents, review the content and formatting.
- Do not claim that checks passed if they were not run.
- At the end, briefly state what changed, how it was verified, and any material limitations.
- Publish externally, send messages, and perform irreversible operations only within the scope authorized by the user.

