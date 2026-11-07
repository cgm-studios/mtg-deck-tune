// Commander color identity, in one place. A card may go in a deck when every color in its identity is in the
// commander's (colorless cards fit every commander). The TypeScript tools ask fitsIdentity; the card store keeps the
// same identity as a bitmask (cards.ci_mask, written by build-db.ts) so SQL can filter with
// `(card_mask & ~commander_mask) = 0`. app/color-identity.test.ts checks the two agree on every pair of identities.

export const CI_BIT: Readonly<Record<string, number>> = { W: 1, U: 2, B: 4, R: 8, G: 16 };

/** WUBRG letters (a list, or a string such as "UB") → bitmask. Any other letter, "C" included, adds nothing. */
export const ciMask = (ci: Iterable<string>): number => {
  let m = 0;
  for (const c of ci) m |= CI_BIT[c] ?? 0;
  return m;
};

/** True when the card's color identity lies inside `ci`, the commander's. */
export const fitsIdentity = (card: { readonly ci: readonly string[] }, ci: readonly string[]): boolean =>
  card.ci.every((x) => ci.includes(x));
