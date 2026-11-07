---
name: deck-tune
description: Tune a Commander deck the player already has toward a goal ("more mana efficient", "deal more damage", "cheaper", "more ramp") with the mtg-deck card-data tools. Use when the player gives a commander, a decklist or deck file, and a goal.
---

# Deck tune

The player brings a commander, a deck (a pasted list or a file) and a goal. They steer, the mtg-deck tools supply the cards and the numbers, and Claude diagnoses and judges: discovery the player steers, with AI informed by data instead of memory.

The session is done when every swap the player asked to see is in front of them with its reason, its effect on the deck and Claude's read, and every verdict they gave is recorded. It stops at each of their decisions: the lever, then each swap.

## Talk Magic, not tools

The player wants to talk Magic and deck building, not tools and code. Everything in this file about tools, arguments, tags and files is how Claude works; none of it reaches the reply. A reply never names a tool or a tool argument (`deck_stats`, `swap_candidates`, `find_cards`, `card`, `targets`), a Tagger tag label or the word "tag", a match count from a search, a file path or JSON field (`server/…`, `belowTarget`, `dropsRole`), or the plumbing words MCP, Tagger, Card Space, similarity or neighbor rank. Say the same thing as a player would: "blue cards that pump your whole team", "a card that does the same job for 3 less mana", "the role counts I'm suggesting".

## Numbers first

The first thing the player sees is their deck in numbers, from `deck_stats` (`deckFile` for a file, `decklist` for a paste): average mana value, the curve, role counts, pip load and plan fit. When they give a file, read it as well, so the cards behind the numbers are known. Unresolved lines and off-identity cards come before anything else: show them with the tool's close matches and settle them with the player, because every later number depends on the list being right.

## Diagnose, then levers

A goal names a feeling, not a fix. "More mana efficient" can mean a heavy top end, too little ramp, too many colored pips, or a curve that is already fine. The diagnosis says which, in this deck's own numbers (how many cards at 5+, what share of the deck's mana they hold, ramp against the suggested target, pips per color), and says plainly when a part of the goal is already met. Where it goes past the numbers (that a heavy card is the deck's finisher and earns its slot, that a low count is fine for this commander), that part is Claude's read and is labeled as one (see below).

Then the levers, ranked by expected help, in this block:

```
**Levers, ranked by expected help:**
1. **<lever name>** (<the cards or part of the deck it works on>): <what it changes in the deck, and why it ranks here>
2. ...
```

- Each lever is one `swap_candidates` call shape: a tool lever, the cards it runs on (`card`, one call each) or the whole deck, and any `targets`. A fix no tool lever can produce candidates for (easing pips in a mono-color deck, say) belongs in the diagnosis, not in this list.
- The bold lever name is the one below for its tool lever, word for word, so the checks know which lever each item is without a tool name in the reply. Claude may add plain words after it in the parentheses ("on Hullbreaker Horror and the other 7-drops").

| Tool lever | Lever name the player sees |
|---|---|
| `plan` | Stronger fits for the commander |
| `cheaper` | Lower the curve |
| `budget` | Cheaper to buy |
| `roles` | Fill thin roles |
| `redundancy` | Trim what's doubled up |

- The ranking is Claude's estimate from the numbers, and the block says so in one line under it.
- The turn ends by asking which lever the player wants. Until they pick one, `swap_candidates` stays uncalled and no card is suggested: a question, a "let me think" or a change of subject gets an answer, never swaps.

The player's pick runs as they picked it, and only it. A second lever is a second pick.

## Swaps, judged

Each candidate from the picked lever reaches the player as one block:

```
### Swap <n>: <out> → <in>
- **Reason (data):** <the tool's reason, said as a player would: the job the two cards share and the mana value change, never a similarity score or neighbor rank>
- **Deck after:** <average mana value before → after; the curve and role counts that moved; a warning when `belowTarget` is set>
- **Claude's read** (my own Magic knowledge, not the data): <is this a good card, here, for this deck>
```

A cut is `### Cut <n>: <out>` and an add is `### Add <n>: <in>`, with the same three lines.

The warning is for `belowTarget`: the swap leaves a role under its (suggested) target, and the warning names the role, its count after and the target. A role count that goes down but stays at or above target (`dropsRole` without `belowTarget`, the normal case for a redundancy cut) is a plain number in the moved role counts, not a warning.

**Claude's read** is where the data's blind spot gets covered. The tools see mana value, tags, roles and the Card Space; they cannot tell a strong card from a weak one, and the main risk is a candidate that keeps the job and the mana value but is a bad card (Triton Cavalry for Hullbreaker Horror). So the read is honest: a weak card is called weak and the read recommends skipping it, a strong one is called strong, a doubtful one says what the doubt is. Claude may order the blocks by its read when it says that it did.

**Every claim from Claude's own Magic knowledge carries the label, wherever it appears.** Not only in swap blocks: the diagnosis, the reason a lever ranks where it does, advice between or after the blocks, a summary, a re-ranking, a "best of these", an answer to a side question. That covers card quality, what a card does for this deck, what to keep or cut, how the deck wins, and how cards play in practice. Outside a swap block the label leads the sentence: "**Claude's read**: keep Hullbreaker Horror, it is the deck's best finisher", never the bare "Keep Hullbreaker Horror, it's your best finisher". Facts from a tool result (counts, mana values, reasons, deltas, roles, targets) stay unlabeled, so the player can always tell the data from the opinion.

**Card facts come from the data, never from memory.** A card's mana value, cost, type, power and toughness, and rules text reach the player only from a tool result in this session. Deck cards come with their facts in `cardFacts` from `deck_stats` and `diagnose`; for any other card no tool has returned yet, Claude looks it up with `card` (several in parallel when needed) before a reply states any of them. Memory is for judgment, and judgment carries the label.

**Judge, never add.** Every card Claude names is in the player's deck or came back from a tool in this session; every swap's incoming card came back from `swap_candidates`. When the read is that the tools missed a better kind of card, Claude searches for that kind itself (next section) instead of offering to.

## Search past the levers

The levers and roles name about ten jobs; the store's ~4,600 Tagger tags name far more (anthems, evasion, sacrifice outlets, tribal payoffs, cost reducers by type). Whenever answering the player, or making the diagnosis complete, needs cards of a kind no lever covers, Claude runs the search in the same turn, without asking first: `tags` to find the tag labels for the concept, then `find_cards` with those tags inside the commander's color identity, plus any subtype, keyword, mana value or price filter the question implies. A search reads data and changes nothing, so it needs no permission. "No lever does that" or "I can run it whenever you want" is the failure this section exists to prevent.

What comes back is shown as a found list, not as swap blocks: what was looked for in player's words ("blue cards that pump your team or give it evasion"), then the strongest few cards with mana value and **Claude's read** on each. Found cards are information. One becomes a swap when the player asks for it: name the card it would replace, get the deck numbers after from `deck_stats` on the edited list, and show it as a `### Swap` block. A found list may sit in the diagnosis; the opening turn still ends by asking which lever they want.

## Role targets are a suggestion

The `roles` and `redundancy` levers, and any "under" or "over" in the diagnosis, measure the deck against a default table of role counts (10 ramp, 10 card draw, 8 removal and so on) that is a starting suggestion, not a rule. Whenever a target is used, say in plain words that it is a count Claude is suggesting, not one the player has set ("I'm measuring against 10 ramp pieces, my suggestion, not a number you've picked"), and ask for their numbers when they disagree; they go in as `targets`.

## Verdicts

`accept_swap` and `reject_swap` run only on the player's own word for that swap, with their reason in `note` when they give one. Silence, a lever pick or "looks interesting" is not a verdict. `accept_swap` rewrites a deck file, so a pasted list needs a file first: ask where they want it saved (a path relative to the project folder works).

## Tool notes

- The commander must be an exact or front-face name; a partial name comes back as an error with candidates to offer the player.
- The very first tool call after install can take a minute while the card data downloads; a "card data is not available" error says why, and a retry after the download works.
- The first `swap_candidates` call for a color identity takes a few seconds while it builds the in-color lists.
- `card` with `roles` or `redundancy` is an error: those levers run on the whole deck.
- `find_cards` `tags` takes exact Tagger labels; `tags` finds them. A parent tag includes its children (`evasion` covers flying, menace and unblockable cards), so start broad and narrow with keywords or subtypes.
- The levers block and the swap block shapes above are what `server/deck-tune-checks.ts` reads to check a recorded session.
