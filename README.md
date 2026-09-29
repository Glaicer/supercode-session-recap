# session-recap

After a long OpenCode run, you shouldn't have to scroll back to remember what happened. **session-recap** puts a short, collapsible update in the TUI sidebar.

After each successful run in a top-level session, it writes a short, two-sentence update. It doesn't add anything to History or start another session. The recap does make one extra model request per run; subagent sessions don't get their own recaps.

## What you'll see

The sidebar shows `Recap appears after the session's next run.` until there's something to summarize, then `Generating recap…` while the request is running. Click the `Recap` heading to collapse or expand it. That choice survives a TUI restart, but the recap text doesn't: it's kept in memory and appears again after the next run. The section follows your theme and wraps in narrow terminals.

If a new run fails to generate a recap, you'll get an error and any previous recap stays visible. A timeout stops waiting locally; it doesn't guarantee the provider stopped working on the request.

## Install

Install the plugin with the OpenCode CLI:

```sh
opencode plugin add @glaicer/supercode-session-recap
```

Restart OpenCode after installing. The first load may take a moment while OpenCode downloads the package.

You can also add it manually to `plugins` in `~/.config/opencode/opencode.jsonc` (or your project's `opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@glaicer/supercode-session-recap"]
}
```

Restart OpenCode after saving. The one entry loads both the server side that generates the recap and the TUI side that displays it; putting it only in `cli.json` won't work.

Plugin version **1.0.0** is for OpenCode **v2** (`>=2.0.0`). If you're on OpenCode **v1**, stay on `@glaicer/supercode-session-recap@0.1.0` (`opencode plugin @glaicer/supercode-session-recap --global`); it uses `tui.json` instead of the setup below.

## Model and options

By default, the plugin uses the model configured for OpenCode's title agent, then falls back to the session's available default model. You can pick one explicitly and adjust how much session activity is sent:

```jsonc
{
  "plugins": [{
    "package": "@glaicer/supercode-session-recap",
    "options": {
      "model": "provider/model-id",
      "budget": 12000,
      "timeout_ms": 60000
    }
  }]
}
```

- `model` selects the recap model. If it isn't available, the plugin warns you and tries the title model, then the project's default. Model IDs can contain more `/` characters after the provider name.
- `budget` is the maximum length of the session digest in characters (default: `12000`). If the session is longer, the most recent activity takes priority.
- `timeout_ms` is how long to wait for a recap in milliseconds (default: `60000`).

The model only sees a compact digest of the conversation and tool activity, not full tool output. Later recaps use new activity and the previous recap rather than starting from scratch.

## Attribution

Inspired by [`streetturtle/opencode-recap`](https://github.com/streetturtle/opencode-recap). The code is original.
