# MTG Deck Tune

A Claude Code plugin: the `deck-tune` skill plus the `mtg-deck` MCP server (typed, deterministic card-data tools over one SQLite card store). The repo is its own marketplace; the plugin itself is the `plugin/` folder.

## Layout

- `server/`: the MCP server source (`mcp.ts` is the entry) and its tests. `paths.ts` decides where the store, labels and deck files live; `store.ts` downloads and verifies the card store on a plugin's first start.
- `plugin/`: exactly what an install copies. `plugin/.claude-plugin/plugin.json` (its MCP server runs `dist/mcp.js`), `plugin/skills/deck-tune/SKILL.md` (the tuning workflow; its lever table and block shapes are what `server/deck-tune-checks.ts` reads) and `plugin/dist/`, the bundled server (`bun run build`). Commit `plugin/dist/` rebuilt with every server change; ISC-34 checks it matches the source.
- `.claude-plugin/marketplace.json`: the marketplace, listing `./plugin`. `.mcp.json` runs `server/mcp.ts` for development in a checkout.
- `scripts/plugin-smoke.ts`: the installed-plugin check, run before every release.

## Development

- The card store is built in the sibling `mtg-vector` repo (`app/build-db.ts`). In a checkout, `data` is a symlink to `../mtg-vector/data`, gitignored; the tests read the raw Scryfall and Card Space files there as their independent oracle.
- `bun test server` runs every test. The session-check tests also need the recorded sessions in `docs/research/deck-tune/` (local only).
- A new card-data release: build `cards.db` in mtg-vector, run `bun server/store.ts manifest <cards.db> <release asset url>`, write the output to `server/store.json`, upload the `.gz` it wrote as the Release asset, rebuild, run `bun scripts/plugin-smoke.ts <cards.db.gz>`.

## Rules

- This repo is public. Nothing is pushed and no release is made without the owner's go-ahead on the exact tree. `ISA.md`, `backlog/` and `docs/research/` are gitignored working material until DT-2 decides otherwise.
- Read `ISA.md` before changing code, and change its criteria in the same turn as the code.

## Agent skills

### Issue tracker

Issues are cards on the Backlog.md board in `backlog/` (`deck-tune-backlog` MCP or `backlog` CLI, prefix `dt-`), not GitHub Issues. Web view: http://127.0.0.1:6427. See `docs/agents/issue-tracker.md`.
