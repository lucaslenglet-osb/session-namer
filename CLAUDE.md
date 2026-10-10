# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code **mod** (a function-hooks plugin, early-access API): after each Claude reply, Haiku reads the conversation and suggests 3 session names in a band above the prompt, following a user-configurable template. Published publicly at github.com/lucaslenglet/session-namer; the repo is its own marketplace (`.claude-plugin/marketplace.json`, `"source": "./"`), installed with `/plugin install session-namer --marketplace lucaslenglet/session-namer`.

## Commands

```sh
claude plugin validate .   # manifest + marketplace + static checks of the hooks module (run after every change)
claude plugin test .       # runs every *.test.ts; there is no filter for a single test
claude --plugin-dir .      # start Claude Code with this working copy loaded
```

There is no build step and no npm project. `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes (gitignored) each time it loads the mod; before that, `tsc -p .` has nothing to extend. To type-check without loading, use a tsconfig kept outside the repo that includes the API declaration file written by the `plugin-authoring` skill, plus `hooks`, `types` and `tests` (strict, `noUncheckedIndexedAccess`, `jsx: react` with `jsxFactory: h`).

Bump `version` in `.claude-plugin/plugin.json` before pushing, or installed copies won't update.

## Architecture

- `hooks/naming.ts`: pure functions, no `$`: project code from the folder name, the template engine (`parseSpec` / `applySpec` / `formatName`), the constraints sent to Haiku (`constraints`), the Haiku system prompt (`SYSTEM`) and the JSON parsing of its reply, and the `/rs help` text. Most behaviour is unit-tested here.
- `hooks/register.tsx`: the hooks. Flow: `turn.complete` (main loop, `reason === 'answer'` only) → `schedule` → `$.clock.after(0)` so the turn is never delayed → `drain` (one Haiku call at a time; a request that arrives meanwhile triggers exactly one rerun) → `suggest` → `$.model.complete({ model: 'haiku' })` → `names` → `$.state`. The `AbovePrompt` `ui.render` hook draws the band from that state.
- `types/index.d.ts`: the `$.state` contract. Two values: `suggestions` (empty = band hidden) and `baseline` (the reference name). Without `force`, suggestions are shown only when Haiku answers `sameSubject: false` against `baseline`. `baseline` is set by picking a name, by Dismiss (to the first suggestion), by any `/rename` (a `command.run` hook on `rename` that wraps `next`), and by a resumed session's existing title (`classic.SessionStart`).
- Spend: every `$.model.complete` result's `usage` is added to the `total` state value (even failed calls and calls that change nothing on screen); `lastCall` is the call behind the suggestions shown. Prices live in `PRICE` in `naming.ts` (Claude Haiku 5.5 API rates; the `haiku` alias's exact model is not reported back, so this is an estimate).
- Options (`userConfig` in `plugin.json`: `template`, `rules`, `project`, `showCost`) are read once in `register(on, options)` into module variables; a change in `/config` reloads the module. A template with no `{desc}` field falls back to `DEFAULT_TEMPLATE`, and `/rs help` reports it.

### Rules of the mod engine that shape the code

- Any function that receives `$` must be declared at the top level of the module (not inside `register`), or `claude plugin validate` refuses it. That is why `suggest`, `drain` and `schedule` and their flags live at module level.
- Module variables are lost on reload; anything the band draws from belongs in `$.state` (atoms from `claude-code`).
- The `.d.ts` contract may only export types (no `export {}`) and must declare `interface PluginState` under the plugin's name.
- In tests, nothing sits beneath the plugin: each test answers `session.messages`, `session.cwd`, `model.complete` (as `{ value: … }`), `command.run` for `rename`, `turn.complete` and `ui.render` itself (see `world()` in the test file), and uses `mock.clock` to fire `$.clock.after`.

### Template engine semantics (`formatName`)

Fields are `{name:mod:mod|fallback}` over `type`, `id`, `project`, `kind`, `desc`; unknown fields stay as literal text and unknown modifiers are ignored. Order inside `applySpec`: allowed-values check (canonicalized to the list's spelling) → fallback → word cap → case/kebab/snake → char max (cut) → char min (pad; default right-pad with spaces, protected from the final whitespace cleanup by a `\u0000` placeholder; `_x` pads on the left). An empty field removes the literal before it if a field was already emitted and that literal opens no bracket, otherwise the literal after it; empty bracket pairs and trailing openers are then stripped. Changing any of these rules needs the matching tests updated, including the README example test.

## Conventions

- Everything (code, comments, the Haiku prompt, UI text, docs) is in English: the band, `/rs` output, toasts, `/config` labels and README included.
- Haiku fills only fields; the code assembles the name, so the format is always respected. Haiku is told the template's limits and allowed values (`FIELD CONSTRAINTS`) so it doesn't get cut, and must never invent an `id`.
