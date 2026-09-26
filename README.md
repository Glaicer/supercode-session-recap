# session-recap

OpenCode V2 plugin that shows a short Recap of a completed root session in the TUI sidebar without writing it to History.

## Install

The package is V2-only: it needs OpenCode 2.0.x and does not load under V1. Install it in the OpenCode **server** configuration — global `~/.config/opencode/opencode.jsonc` or a project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "@glaicer/supercode-session-recap", "options": {} }]
}
```

The 1.0.0 release has not been published yet; the current npm release (0.1.0) is V1-only, do not install it for V2. Until then, pack this checkout, install the tarball into an isolated directory and reference that installed directory instead:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "/path/to/isolated/node_modules/@glaicer/supercode-session-recap", "options": {} }]
}
```

Restart OpenCode. One package entry loads both components: the server plugin (which resolves the Recap Model and performs one stateless generation per completed session) and the TUI plugin (which reacts to completions, builds the Recap Digest and renders the sidebar section). A `cli.json`-only entry starts neither server companion nor TUI component; V1 `tui.json` instructions do not apply to V2. Options live in the same `plugins` entry — set them where the entry is, globally or per project.

## Sidebar behavior

After a successful root-session execution the section shows a two-sentence Recap as Markdown in the sidebar, never in History. The `▼ Recap` header collapses the section; it starts expanded and the collapsed/expanded choice is remembered across TUI restarts (the Recap text itself is not persisted and is rebuilt from new session activity). While nothing has been generated the section shows a muted `Recap appears after the session's next run.` hint; while a generation is in flight it shows `Generating recap…`. Rendering follows the active theme, including live theme switches, and wraps on narrow terminals. Child-session completions do not generate their own Recap.

## Recap Model

Set `options.model` to a `provider/model-id` reference to pick the Recap Model explicitly; model IDs may contain further `/` characters. Without it, Recap uses the configured `agents.title.model` (which includes a V1 `small_model` normalized by V2), then the location's available default model. Candidates are resolved against the model catalog of the completed session's location, so a project-only provider or model works even when the package is configured globally; a global configuration never overrides a project's model. An invalid or unavailable configured model produces one warning per source and falls through to the next candidate; an unavailable final default produces a visible error instead of silently generating elsewhere.

## Options

- `model` — `provider/model-id` override for the Recap Model (see above).
- `budget` — character budget for the Recap Digest, default `12000`. When the budget is exceeded the newest activity is kept and the truncation is disclosed to the model.
- `timeout_ms` — local wait for a generation, default `60000`. A timed-out attempt reports an error, releases the loading state and leaves the last successful Recap untouched; it does not claim the provider call was stopped.

Unknown options are ignored. A recognized option with the wrong type uses its default and produces one warning. The TUI component reads `budget` and `timeout_ms` from the server companion at the session's location, so one configuration entry covers both components; if the companion cannot answer, the TUI falls back to its own parsed options.

## Differences from V1

The V1 package (npm `0.1.0`) targets OpenCode 1.x and its `tui.json` slot registry; it is not updated by this release and the two must not be mixed. V2 changes the configuration shape (a `plugins` package entry with `options` instead of `tui.json` tuples), replaces the V1 Recap Session with one stateless generation, and drops the unfinished V1-plan features (runtime model picker, explicit button, Recap Staleness). There is no V1 compatibility mode and no automatic migration of existing V1 settings.

## Development

```bash
npm ci
npm run typecheck
npm test
npm pack
node scripts/probe.mjs
node scripts/probe-model-selection.mjs
```

The probes require OpenCode V2 2.0.16, Python 3 and Node 24. They pack the artifact into a temporary directory, start an isolated OpenCode server and a controlled local model endpoint, and drive the installed package — never the checkout sources and never the active OpenCode configuration. `probe.mjs` opens a PTY TUI and checks the location-scoped Recap, visible sidebar update, markdown rendering with concealed markers, waiting and generating states, narrow/wide repaints, a live dark→light theme switch, mouse-driven collapse, the persisted expanded choice across a TUI restart, timeout and late answers, History exclusion, session count and tool-free generation; it then drives the installed TUI entry directly for re-entry, per-session isolation, an unavailable RPC, in-flight deletion and plugin unload. `probe-model-selection.mjs` checks location-scoped model selection: a global title model, a project-only title model, a V1 `small_model`, an explicit namespaced model, and fallback after invalid options. Neither probe publishes the package.

## Attribution

Inspired by [`streetturtle/opencode-recap`](https://github.com/streetturtle/opencode-recap). The code is original.
