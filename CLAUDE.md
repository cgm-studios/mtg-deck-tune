# MTG Deck Tune

A Claude Code plugin: the `deck-tune` skill plus the `mtg-deck` MCP server (typed, deterministic card-data tools over one SQLite card store). The repo is its own marketplace; the plugin itself is the `plugin/` folder.

## Layout

- `server/`: the MCP server source (`mcp.ts` is the entry) and its tests. `paths.ts` decides where the store, labels and deck files live; `store.ts` downloads and verifies the card store on a plugin's first start.
- `server/graph/`: the card graph code ported from `mtg-graph-api` (interaction index, closure, hook profiles, strategy profiles) as source, reading only the store; its mapping files are verbatim copies, and the store's `meta.graph_mapping_version` must match `mapping/forge-map.json`. Port fidelity is checked against output recorded from the graph repo on the store's own inputs (`fixtures/graph-profiles.json`; re-record it when the store's corpus or the EDHREC pages change).
- `server/plan.ts`: the player's plan (themes, priority cards, themes to avoid) resolved into profiles, and the one plan fit the tools read. The plan always comes from the player, never from the commander's text.
- `plugin/`: exactly what an install copies. `plugin/.claude-plugin/plugin.json` (its MCP server runs `dist/mcp.js`), `plugin/skills/deck-tune/SKILL.md` (the tuning workflow; its lever table and block shapes are what `server/deck-tune-checks.ts` reads) and `plugin/dist/`, the bundled server (`bun run build`). Commit `plugin/dist/` rebuilt with every server change; ISC-34 checks it matches the source.
- `.claude-plugin/marketplace.json`: the marketplace, listing `./plugin`. `.mcp.json` runs `server/mcp.ts` for development in a checkout.
- `scripts/plugin-smoke.ts`: the installed-plugin check, run before every release.

## Development

- The card store is built in the sibling `mtg-vector` repo (`app/build-db.ts`). In a checkout, `data` is a symlink to `../mtg-vector/data`, gitignored; the tests read the raw Scryfall, Card Space and EDHREC page files there, and the card graph corpus in `data/graph/`, as their independent oracle. `server/store.ts` lists the store schema (2: card rows plus the card graph per card and each commander's EDHREC Themes, synergy list and Tagger Deck vector); the server refuses a store of another schema.
- `bun test server` runs every test. The session-check tests also need the recorded sessions in `docs/research/deck-tune/` (local only).
- A new card-data release: in the card graph repo (`mtg-graph-api`), `bun src/cli.ts extract --oracle <mtg-vector>/data/scryfall/oracle_cards.jsonl.gz --out <mtg-vector>/data/graph/corpus.json --facts <mtg-vector>/data/graph/subtype-facts.json`; build `cards.db` in mtg-vector; run `bun server/store.ts manifest <cards.db> <release asset url>`, write the output to `server/store.json`, upload the `.gz` it wrote as the Release asset, rebuild, run `bun scripts/plugin-smoke.ts <cards.db.gz>`.

## Rules

- This repo is public. Nothing is pushed and no release is made without the owner's go-ahead on the exact tree. `ISA.md`, `backlog/` and `docs/research/` are gitignored working material until DT-2 decides otherwise.
- Read `ISA.md` before changing code, and change its criteria in the same turn as the code.

## Agent skills

### Issue tracker

Issues are cards on the Backlog.md board in `backlog/` (`deck-tune-backlog` MCP or `backlog` CLI, prefix `dt-`), not GitHub Issues. Web view: http://127.0.0.1:6427. See `docs/agents/issue-tracker.md`.
