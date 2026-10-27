# Specifikace: AI vyplňování Google Forms (Chrome extension)

Zadání od uživatele, beze změn obsahu. Rozdělení práce je v sekci "Vlastnictví" na konci.

## Úkol

Postav Chrome extension (Manifest V3, TypeScript), která přečte Google Form
v aktuální záložce a nechá AI vyplnit odpovědi, stránku po stránce.
Před odesláním vždy čeká na moje potvrzení.

## Stack
- WXT + TypeScript, React (side panel UI), zod, Vitest
- Content script na `https://docs.google.com/forms/*`
- Service worker volá LLM API (ne content script, kvůli CORS a klíčům)
- Klíč ukládej do `chrome.storage.local`, nikdy ho neposílej nikam
  kromě zvoleného API endpointu

## AI provider (BYOK, přepínatelný)
- Abstrakce `LLMProvider` s implementacemi: Anthropic, OpenAI, Google Gemini
  a "OpenAI-compatible" (vlastní base URL, např. Ollama/OpenRouter)
- Options page: výběr provideru, API klíč, model, base URL, teplota,
  tlačítko "Test connection"
- Výstup z modelu vždy jako strukturovaný JSON (tool use / JSON schema),
  validuj přes zod, při nevalidním výstupu 1x zopakuj s chybou
- Anthropic: v service workeru přidej host_permissions pro api.anthropic.com
  (případně hlavičku `anthropic-dangerous-direct-browser-access: true`)
- Streamuj odpovědi, ať UI nezamrzá; ošetři rate limit (429) s backoffem

## Jak to má fungovat

1. Parser (content script)
   - Vytáhni strukturu formuláře. Preferuj `FB_PUBLIC_LOAD_DATA_`
     (JSON ve <script>), fallback DOM podle `role`/`data-params`.
   - Model dat: Form -> Page[] -> Question { id, text, type, required,
     options, validation, branching }.
   - Typy: short text, paragraph, radio, checkbox, dropdown, scale,
     radio/checkbox grid, date, time, file upload (pouze označit jako
     "vyžaduje člověka").

2. Kontext od uživatele
   - Side panel: textové pole "Instrukce / kdo jsem" + uložené profily
     (jméno, e-mail, adresa, preference...), vše lokálně.
   - Režimy: "Vyplnit vše" / "Otázka po otázce se schválením" /
     "Jen navrhnout (dry run)".

3. Vyplňování
   - Pro každou stránku pošli AI otázky + profil + instrukce, dostaň
     odpovědi s `confidence` a krátkým `reasoning`.
   - Otázky s nízkou confidence nebo bez dat v profilu označ v UI a
     zeptej se mě, nehádej osobní údaje.
   - Vyplň DOM tak, aby to Google Forms vzal: Google Forms používá vlastní
     komponenty (div role=radio/checkbox, listbox), takže nestačí nastavit
     `.value`. Simuluj klik, focus a `input`/`change`/`blur` události,
     ověř, že se hodnota po vyplnění skutečně projevila.
   - Klikni "Další", počkej na načtení další stránky (MutationObserver,
     žádné pevné sleepy), pokračuj. Zvládni branching podle odpovědí.
   - Před "Odeslat" zobraz přehled všech odpovědí a čekej na potvrzení.

4. Stav
   - Ukládej průběh do `chrome.storage.session`, aby šlo po reloadu
     stránky pokračovat. Tlačítko Stop vždy funguje.

## Požadavky
- Respektuj povinná pole a validace; při chybě validace nech AI odpověď
  opravit (max 2 pokusy), pak se zeptej mě.
- Žádné obcházení CAPTCHA, při výskytu zastav a řekni mi to.
- Žádné automatické odeslání bez potvrzení.
- Minimální oprávnění v manifestu (activeTab, storage, scripting,
  host_permissions jen pro Forms a zvolený API endpoint).
- Do LLM posílej jen otázky a data, která jsem schválil; zobraz, co přesně
  se odesílá (tlačítko "Zobrazit payload").
- Architektura: `parser/`, `providers/`, `filler/`, `ui/`, `background.ts`.
  Parser a providery testovatelné bez prohlížeče (fixture HTML, mock API).

## Postup práce
1. Napiš `AGENTS.md`/`CLAUDE.md` s těmito požadavky.
2. Navrhni architekturu a datové modely, počkej na schválení.
3. Parser + testy na uložených fixture formulářích (vytvoř si testovací
   Google Form, ulož HTML do `tests/fixtures/`).
4. Provider vrstva + options page + "Test connection".
5. Filler pro jednoduché typy, pak scale, grid, date/time, branching.
6. Side panel UI, review před odesláním, resume.
7. README: instalace (`chrome://extensions` -> Load unpacked), nastavení klíče.

Po každém kroku spusť testy a stručně shrň, co funguje. Selektory a
strukturu dat si ověř na reálném formuláři, nevymýšlej je.

## Vlastnictví

- **Backend (Claude Code):** `src/background.ts` (service worker), `src/providers/`,
  `src/shared/` (datové modely a zprávy = kontrakt mezi částmi), stav v
  `chrome.storage.session`, správa klíče a host permissions, sestavení payloadu.
- **Ostatní (`parser/`, `filler/`, `ui/`, options page, side panel):** druhý
  přispěvatel, pokud se nedomluvíte jinak.
- Změny v `src/shared/` jsou společný kontrakt: měnit jen po domluvě obou stran.
