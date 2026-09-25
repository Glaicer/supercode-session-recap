# session-recap

OpenCode V2 plugin that shows a short Recap of a completed root session in the TUI sidebar without writing it to History.

## Install

This V2 build has not been published. The current npm release (0.1.0) is V1-only; do not install it for V2. For local verification, pack this checkout, install the tarball into an isolated directory and reference that installed directory in the OpenCode server configuration (`~/.config/opencode/opencode.jsonc` or a project's `opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "/path/to/isolated/node_modules/@glaicer/supercode-session-recap", "options": {} }]
}
```

Restart OpenCode. The package exports a server plugin and a precompiled TUI plugin; a `cli.json`-only entry does not load the server companion. V1 `tui.json` instructions do not apply to V2.

The installed directory exports `index.js` and `tui.js` for V2 local plugin discovery. Once the V2 package is published, its package name can replace the local directory in `plugins`.

## Recap Model

Set `options.model` in the plugin entry to choose `provider/model-id`. Model IDs may contain more `/` characters. Without it, Recap uses the configured `agents.title.model` (including V1 `small_model` normalized by V2), then the available default model. An unavailable configured model produces one warning per source and location before falling back; an unavailable final default produces an error. The server checks models and generates within the completed session's location, so a project-only model can be selected there.

`budget` defaults to `12000` characters. Unknown options are ignored. A recognized option with the wrong type uses its default and produces one warning.

## Development

```bash
npm ci
npm run typecheck
npm test
npm pack
node scripts/probe.mjs
node scripts/probe-model-selection.mjs
```

The probe requires OpenCode V2 2.0.16, Python 3 and Node 24. It extracts the packed artifact in a temporary directory, starts an isolated OpenCode server and a controlled local model endpoint, opens a PTY TUI, and checks the location-scoped Recap, visible sidebar update, History, session count and tool-free generation. It does not publish the package or alter the active OpenCode configuration.

The model-selection probe packs the artifact into an isolated temporary directory and checks location-scoped requests against the controlled endpoint: a global title model, a project-only title model, a V1 `small_model`, an explicit namespaced model that overrides the title model, and fallback after invalid options. It also verifies that generation does not create a session or send tools.

## Attribution

Inspired by [`streetturtle/opencode-recap`](https://github.com/streetturtle/opencode-recap). The code is original.
