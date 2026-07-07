# pi-tavern

Terminal roleplaying harness on top of Pi's native TUI.

## Quick start

```bash
bun run bin/pi-tavern init-example-character
bun run bin/pi-tavern new alice --model openrouter/anthropic/claude-sonnet-4
```

Useful commands:

```bash
bun run bin/pi-tavern characters
bun run bin/pi-tavern saves
bun run bin/pi-tavern launch <save-id>
```

Inside Pi, pi-tavern adds `/rp-*` commands:

- `/rp-new` / `/rp-load` / `/rp-saves`
- `/rp-status`
- `/rp-log`
- `/rp-branches`
- `/rp-checkout`
- `/rp-branch`
- `/rp-files`
- `/rp-diff`
- `/rp-regenerate`

## Data layout

Default app data root is `$PI_TAVERN_HOME`, then `$XDG_DATA_HOME/pi-tavern`, then `~/.local/share/pi-tavern`.

Each save is a git repository containing:

- `pi-session/` — Pi JSONL session files
- `world/` — the only agent-visible filesystem area
- `manifest.json`
- `meta.json`

Pi itself runs with an isolated home at `<app-data>/pi-home`.

## Safety defaults

The wrapper launches Pi with:

- custom system prompt
- no context files, skills, prompt templates, extension discovery, or theme discovery
- only this harness extension loaded
- only `read`, `write`, `edit`, `ls`, `find`, and `grep` enabled

The extension blocks shell commands and validates tool paths so file tools stay inside `world/`.
