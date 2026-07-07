# pi-tavern

Terminal roleplaying harness on top of Pi's native TUI.

## Quick start

```bash
bun run bin/pi-tavern new alice --model openrouter/anthropic/claude-sonnet-4
```

The repo includes `characters/alice.json`, a basic SillyTavern Character Card V2 JSON (`spec: "chara_card_v2"`). Bundled cards can be referenced by name. For now, pi-tavern only supports Character Card V2 JSON; pass your own card path or place `.json` cards in the app-data `characters/` directory.

Useful commands:

```bash
bun run bin/pi-tavern characters
bun run bin/pi-tavern saves
bun run bin/pi-tavern launch <save-id>
```

## Returning to an existing session

List saves:

```bash
bun run bin/pi-tavern saves
```

Launch a specific save:

```bash
bun run bin/pi-tavern launch <save-id>
```

If it is the latest or only save, launch without an id:

```bash
bun run bin/pi-tavern launch
```

Inside the session, `/rp-status` shows the current save, branch, and commit.

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
