# Issue tracker: Backlog.md board

Issues and specs for this repo are cards on the MTG Deck Tune Backlog.md board in `backlog/` (task prefix `dt-`, so ids look like `DT-1`). GitHub Issues are not used. Use the `deck-tune-backlog` MCP server, or the `backlog` CLI run from the repo root. Web view: http://127.0.0.1:6427 (always on).

Every card needs a description, testable acceptance criteria, blockers as native dependencies, a type and a label. Labels must come from `backlog/config.yml`; adding a label means editing that file too. Board changes are not auto-committed: commit them in this repo at the end of the session.

## Conventions

- **Create an issue**: MCP `task_create`, or `backlog task create "<title>" -d "<description>" --ac "<criterion>" -l <label> --type <type> --priority <priority>`.
- **Read an issue**: MCP `task_view`, or `backlog task <id> --plain`.
- **List issues**: MCP `task_list` / `task_search`, or `backlog task list --plain` with `-s <status>` / `-l <label>` filters.
- **Make an issue a sub-issue of a parent**: `backlog task create ... --parent <parent-id>`.
- **Comment on an issue**: `backlog task edit <id> --comment "..."`, or append a dated line with `--append-notes "..."` (the notes are the card's running log).
- **Apply / remove labels**: `backlog task edit <id> --add-label "..."` / `--remove-label "..."`.
- **Close**: set status `Done` only when every acceptance criterion is ticked, each with evidence (commit, test run or screenshot); record it with `--final-summary "..."`. A card with a criterion still waiting stays `In Progress` with a note on what waits and on whom. For won't-do, apply `wontfix`, record why in a comment, then archive (`task_archive`).
- **In a worktree**, edit cards with the `backlog` CLI run from that worktree: the `deck-tune-backlog` MCP writes to the main checkout.
- **Card edits land on whatever branch the main checkout has out.** During `/implement-spec`, keep the main checkout on `main` and put the integration branch in its own worktree, so card status reaches `main` without waiting for the feature merge.

Statuses are `To Do`, `In Progress` and `Done`. Decisions only the project owner can make go on cards of type `decision`; agents present options and never make the call.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

A ticket is a card on the board. A **spec** (from `to-spec`) is a Backlog document titled `Spec: <name>` (`backlog doc create`), holding the spec text and the list of its card ids; its cards carry the `ready-for-agent` label. When the cards already exist, the spec points at them instead of re-creating them.

## When a skill says "fetch the relevant ticket"

Read the card as in **Read an issue** above. The user normally passes the id (`MV-n`).

## Wayfinding operations

Used by `/wayfinder`. The **map** is a parent card with **child** cards as tickets.

- **Map**: a card labelled `wayfinder-map`, with the Notes / Decisions-so-far / Fog in its description.
- **Child ticket**: `backlog task create ... --parent <map-id>`, with the question in the description and one `wayfinder-<type>` label (`wayfinder-research`/`-prototype`/`-grilling`/`-task`). This repo uses a hyphen where the skill uses a colon: read `wayfinder:<type>` in the skill as `wayfinder-<type>`.
- **Blocking**: the card's dependency field (`--dep <ids>`). A ticket is unblocked when every dependency is `Done`.
- **Frontier**: the map's child cards in `To Do`, with every dependency `Done` and no assignee; lowest id wins.
- **Claim**: `backlog task edit <id> -s "In Progress" -a @claude`, the session's first write.
- **Resolve**: append the answer with `--append-notes`, set status `Done`, then append a context pointer (gist + card id) to the map's Decisions-so-far.
- **Research findings**: land under `docs/research/` on `main` once the ticket resolves.
