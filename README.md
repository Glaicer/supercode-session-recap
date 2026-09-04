# session-recap

An OpenCode plugin that adds a collapsible **recap** section to the TUI session sidebar. After every finished turn it folds the session into a recap of at most two short sentences.

OpenCode's `small_model` (the same model that generates session titles) produces the recap in a throwaway child session.

## Install

Install with the OpenCode CLI. It detects the TUI target and registers the plugin in `tui.json` for you:

```bash
opencode plugin @glaicer/supercode-session-recap
```

- `--global` installs into the global config (`~/.config/opencode`); default is local (`.opencode` in the current project).
- `--force` replaces an already-installed version.
- Restart OpenCode after installing.

Manual install also works: add the package to the `plugin` array in `tui.json` (global `~/.config/opencode/tui.json` or local `<project>/.opencode/tui.json`):

```jsonc
{
  "plugin": ["@glaicer/supercode-session-recap"]
}
```

> [!IMPORTANT]
> **The first OpenCode load after installing this plugin may be slow.** That's OpenCode downloading the plugin's packages and managed tools into its cache. It happens once. Every subsequent start is fast.

## Options

Options live in the second tuple element in `tui.json`. All keys are optional. The plugin ignores an unrecognized key silently. A recognized key with the wrong type produces one warning toast at startup, and the default applies.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `model` | string `provider/model-id` | `small_model` | Recap model override; the id may contain `/` |
| `budget` | number | `12000` | Recap digest budget in characters; the plugin drops overflow from the head of the window |
| `timeout_ms` | number | `60000` | Call timeout: aborts the recap session, then deletes it |

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["@glaicer/supercode-session-recap", {
      "budget": 12000,
      "timeout_ms": 60000
    }]
  ]
}
```

You can adjust `small_model` in the OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "small_model": "opencode/nemotron-3.5-lightning-free"
}
```

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test, network-free: pure logic, no TUI
npm run build       # precompile Solid TSX into dist
npm pack --dry-run  # build and verify the publish artifact
```

## Attribution

The idea was inspired by [`streetturtle/opencode-recap`](https://github.com/streetturtle/opencode-recap). The code is original.