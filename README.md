# MTG Deck Tune

Tune a Magic: The Gathering Commander deck with Claude, using card data instead of memory.

Give Claude your commander, your decklist and a goal ("more mana efficient", "deal more damage", "cheaper to buy"). It reads your deck's numbers first (curve, ramp, card draw, removal, color pips, how many cards fit your commander's plan), tells you which changes would help most, and lets you pick. Every suggested swap comes with:

- **why** it fits, from the card data (the job the two cards share, the mana value change)
- **what it does to the deck**: average mana value, curve and role counts before and after, with a warning when a swap leaves a role thin
- **Claude's read**: its own opinion on whether the card is actually good here, labeled so you can always tell data from opinion

Claude only suggests cards the tools found, and it never changes your deck until you accept a swap.

## Install

You need [Claude Code](https://code.claude.com) and [Bun](https://bun.sh).

```bash
claude plugin install mtg-deck-tune --marketplace cgm-studios/mtg-deck-tune
```

Or, inside a Claude Code session: `/plugin marketplace add cgm-studios/mtg-deck-tune`, then `/plugin install mtg-deck-tune@cgm-studios`.

The first time the card tools run, they download the card data (about 63 MB, checked against a checksum) into the plugin's data folder. That takes a minute once.

## Use

Put your decklist in a text file in your project, one card per line (`1 Sol Ring`), and ask:

```
/mtg-deck-tune:deck-tune decks/my-deck.txt  I want this deck to be more mana efficient
```

You can also paste the list into the chat. Accepted swaps rewrite your deck file and add a dated line at the bottom saying what changed.

Want your deck explained instead of changed? Ask for a primer: how it plays, what works together and how it wins, written from the cards' own text.

```
/mtg-deck-tune:deck-primer decks/my-deck.txt
```

A primer reads the cards' rules text, not official rulings, so confirm the interactions before you rely on them.

## Updates

Run `claude plugin update mtg-deck-tune@cgm-studios`, or turn on auto-update for the `cgm-studios` marketplace under **Marketplaces** in `/plugin`.

## Data

Card data comes from [Scryfall](https://scryfall.com) and Scryfall Tagger, used under the Wizards of the Coast Fan Content Policy. MTG Deck Tune is free and not affiliated with or endorsed by Scryfall or Wizards of the Coast.

Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.

## License

GPL-3.0. See [LICENSE](LICENSE).
