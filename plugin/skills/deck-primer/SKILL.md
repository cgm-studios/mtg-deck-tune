---
name: deck-primer
description: Write a primer for a Commander deck from its real card text, explaining how it plays, what works together, its coolest plays and its ways to win ("write a primer for this deck", "explain how my deck works", "write up this list", "how does this deck win"). Use when the player gives a commander and a decklist or deck file and wants the deck explained as it stands, or asks for a primer after tuning. Not for suggesting cuts, swaps or upgrades, rules questions, or looking up one card.
---

# Deck primer

The player brings a commander and a deck (a pasted list or a file). The primer explains that deck as it stands, about one page, so someone could sit down and play it well.

The primer is done when every line of it can be traced to the cards in this deck, and the player knows to confirm the interactions before relying on them.

## Talk Magic

A reply says it the way a player would: "blue cards that pump your whole team", "a card that does the same job for 3 less mana". Tool and argument names, JSON fields, file paths, tag labels and the word "tag", search match counts, and the words MCP, Tagger, Card Space, similarity and neighbor rank stay out of replies; the one path a reply gives is where a page saved for the player is. A tool's error message is a fact for Claude; the player hears only what it means for their deck.

## Grounded in the cards

**Read the deck first.** Pass `cardFacts: true` on `deck_stats` and read `commander_profile` with the list, before writing anything. Lines that did not resolve come first: Claude fixes an obvious misspelling itself and asks only about what stays unclear.

**What a card does comes from its text in that data, never from memory.** A card's cost, type, power and toughness, and rules text reach the player only from those results. Numbers in a damage line start from printed stats and show their steps.

**Every interaction shows its work.** Each synergy, play and win line names its cards and says what each card's text contributes, so the player can check it against the cards. Each line stands on its own: a reader who sees only that one line knows which cards it uses and what each of them does. So a line never leans on another line ("the first synergy above", "the loop above") and never puts a group word where the cards belong ("any pair of drainers", "a free outlet", "these cards"); it names the cards and says again what each one does, in Ways to Win above all. What a play needs to have happened first is named by card too: "after a drain turn" becomes the card that gained the life and how. Fewer complete lines beat many thin ones, so a card that only shares a job with the line's main cards can be left out. Quoted rules text is word for word from the data.

**The combining is my read.** The cards' text is fact; how they fit together and how the deck wins is Claude's judgment. Each section built on that opens with the label: "**My read**, from the cards' text:".

**Confirm reminder.** The data holds rules text and no official rulings, so the primer cannot settle a rules question. It tells the player so in plain words and asks them to confirm the interactions before relying on them.

## Stay inside the deck

The primer describes; it does not tune. It names only cards in this deck and proposes no cuts, additions or swaps, even for a card that looks weak. A player who wants changes can ask for a tune.

## The goal

After a tune in this session, the goal is the plan the player confirmed. Otherwise read the list and the commander's usual play, state what the deck seems built to do as an assumption, and keep writing: the player can redirect it, so this costs no confirmation turn. If the player said what the deck is for, that is the goal.

## The primer

```
**Goal:** <the plan or what the player said>
(or **Goal (my assumption):** <what the deck seems built to do>)

<the deck's numbers: cards and lands, average mana value, ramp, card draw, removal, protection>

## Overview and Strategy
## Key Synergies and Interactions
## Unique/Cool Plays
## Ways to Win
## What Can Go Wrong
## Final Thoughts
```

Key Synergies, Unique/Cool Plays and Ways to Win are lists, one item per line of play. What Can Go Wrong holds what could actually lose this deck the game or trip up its pilot, from its own cards: a commander that lacks evasion, a mandatory trigger that can hurt, a plan that stalls without one piece. Final Thoughts carries the confirm reminder.

## Tools

The first call after install can take a minute while the card data downloads.

- `deck_stats`: the deck's numbers, and every card's text with `cardFacts: true`.
- `commander_profile`: how the commander is usually played, and how this list matches that.
- `card`: one card in full, when a deck card's text needs a closer look.
