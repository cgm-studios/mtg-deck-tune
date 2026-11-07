// What a cost reducer discounts, read from its own rules text (DT-6.13, ISA ISC-86): a reducer that only discounts
// spells of a color or card type the deck has none of does nothing for that deck. This is a rules-text fact, not a tuned
// number: "Black spells you cast cost {1} less" helps a deck only if it casts black spells.
//
// A discount clause is a sentence "<subject> spell(s) ... cost(s) {N} less". Its subject before each "spells" is one
// group ("Kithkin spells and Soldier spells" is two); a group split on "and", "or" and commas gives alternatives
// ("instant and sorcery"), and the words of one alternative must all hold ("white creature"). Each word is a color, a
// card type, "non" plus a type, a supertype, "historic" or "permanent", or one of the store's subtypes. A clause is not
// judged (null) when a group has no words (any spell) or a word outside that vocabulary ("of the chosen type" comes after
// the subject; "face-down" is not a color or type). Clauses about this spell itself ("This spell costs"), about spells
// named before ("Those spells"), or about an opponent's spells are not discounts the card gives the deck.

/** A cast card's facts, lower case: its types, colors (none for a colorless card), subtypes and supertypes. */
export type CastFacts = { types: Set<string>; colors: Set<string>; subtypes: Set<string>; supertypes: Set<string> };
/** One discount clause: alternatives, each a list of words that must all hold; null when the clause is not judged. */
export type DiscountClause = string[][] | null;

const COLORS = new Set(["white", "blue", "black", "red", "green"]);
const TYPES = new Set(["artifact", "battle", "creature", "enchantment", "instant", "kindred", "land", "planeswalker", "sorcery", "tribal"]);
const SUPERTYPES = new Set(["legendary", "snow", "basic"]);
const PERMANENT = ["artifact", "battle", "creature", "enchantment", "land", "planeswalker"];
/** Words that only count or place a spell ("the first creature spell"), never narrow which spells. */
const FILLER = new Set(["the", "first", "each", "a", "an", "other", "you", "cast"]);

const CLAUSE = /^(.*?\bspells?\b.*?)\bcosts?\s+(?:\{[^}]*\})+\s+less\b/i;

/** The discount clauses of a card's rules text, in text order. */
export function spellDiscounts(text: string, subtypes: ReadonlySet<string>): DiscountClause[] {
  const out: DiscountClause[] = [];
  for (const sentence of text.split(/[.\n]/)) {
    const m = CLAUSE.exec(sentence);
    if (!m) continue;
    // the subject starts after any leading condition ("As long as this creature is tapped, ...", "II — ...")
    const subject = m[1].split(/,|—/).pop()!.trim();
    const lower = subject.toLowerCase();
    if (/^(this|those|that|these)\b/.test(lower) || /\bopponents?\b/.test(lower)) continue;
    const pieces = lower.split(/\bspells?\b/);
    pieces.pop(); // what follows the last "spells" ("you cast of the chosen type") only narrows further
    const alternatives: string[][] = [];
    let judged = true;
    for (const piece of pieces) {
      const group = piece.replace(/^\s*(and|or|,)\s+/, "").trim();
      for (const alt of group.split(/\s*(?:,|\band\b|\bor\b)\s*/)) {
        const words = alt.split(/\s+/).filter((w) => w && !FILLER.has(w));
        if (!words.length || !words.every((w) => known(w, subtypes))) judged = false;
        else alternatives.push(words);
      }
    }
    out.push(judged && alternatives.length ? alternatives : null);
  }
  return out;
}

function known(word: string, subtypes: ReadonlySet<string>): boolean {
  const w = word.startsWith("non") && word.length > 3 ? word.slice(3).replace(/^-/, "") : word;
  return COLORS.has(w) || w === "colorless" || w === "multicolored" || w === "monocolored" || TYPES.has(w) || SUPERTYPES.has(w) ||
    w === "historic" || w === "permanent" || subtypes.has(w);
}

function holds(word: string, c: CastFacts): boolean {
  if (word.startsWith("non") && word.length > 3) return !holds(word.slice(3).replace(/^-/, ""), c);
  if (COLORS.has(word)) return c.colors.has(word);
  if (word === "colorless") return c.colors.size === 0;
  if (word === "multicolored") return c.colors.size > 1;
  if (word === "monocolored") return c.colors.size === 1;
  if (word === "kindred" || word === "tribal") return c.types.has("kindred") || c.types.has("tribal");
  if (TYPES.has(word)) return c.types.has(word);
  if (SUPERTYPES.has(word)) return c.supertypes.has(word);
  if (word === "historic") return c.types.has("artifact") || c.supertypes.has("legendary") || c.subtypes.has("saga");
  if (word === "permanent") return PERMANENT.some((t) => c.types.has(t));
  return c.subtypes.has(word);
}

/** Whether a card with these discount clauses discounts something the deck casts: true when it has no clause, a clause is
 * not judged, or some alternative of some clause holds for some card in `deck`. */
export function discountUsable(clauses: DiscountClause[], deck: CastFacts[]): boolean {
  if (!clauses.length) return true;
  return clauses.some((clause) => clause === null || clause.some((words) => deck.some((c) => words.every((w) => holds(w, c)))));
}
