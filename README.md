# pi-tavern

Terminal roleplaying harness on top of Pi's native TUI.

## Quick start

```bash
bun run bin/pi-tavern new alice --model openrouter/anthropic/claude-sonnet-4
```

The repo includes bundled SillyTavern Character Card V2 JSON cards (`spec: "chara_card_v2"`):

- `alice` — roleplay example librarian/archivist
- `card-creator` — utility assistant for creating new Character Card V2 JSON cards

Bundled cards can be referenced by name. For now, pi-tavern only supports Character Card V2 JSON; pass your own card path or place `.json` cards in the app-data `characters/` directory.

Create new V2 cards with the bundled card creator:

```bash
bun run bin/pi-tavern new card-creator --model openrouter/anthropic/claude-sonnet-4
```

Run with a card anywhere on your filesystem:

```bash
bun run bin/pi-tavern new ~/Downloads/my-character.json --model openrouter/anthropic/claude-sonnet-4
```

When a save is created, pi-tavern snapshots the resolved character card into the save repo as `character.json`, so resuming the save does not depend on the original card path still existing.

Useful commands:

```bash
bun run bin/pi-tavern characters
bun run bin/pi-tavern saves
bun run bin/pi-tavern launch <save-id>
```

## Save commands

```bash
# Create a new save from a bundled or app-data card name
bun run bin/pi-tavern new alice

# Create a new save from a card anywhere on disk
bun run bin/pi-tavern new /path/to/character-card.json

# List saves
bun run bin/pi-tavern saves

# Launch the latest/only save
bun run bin/pi-tavern launch

# Launch a specific save
bun run bin/pi-tavern launch <save-id>

# Delete a save, with confirmation
bun run bin/pi-tavern delete <save-id>

# Delete non-interactively
bun run bin/pi-tavern delete <save-id> --yes
```

Aliases: `load`/`run` for `launch`; `list` for `saves`; `remove`/`rm` for `delete`.

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
- `character.json` — snapshotted Character Card V2 JSON
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
