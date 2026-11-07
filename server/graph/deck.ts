// The deck graph, ported from mtg-graph-api src/deck.ts (branch rework/ts-card-graph; its ISA F6): every link between the
// cards of one decklist. What changed in the port: a member's links into the deck come from linksWith (the selector
// test runs only on member cards) instead of linksFrom cut to the deck, the same links in the same order but far
// cheaper; roles come from this repo's role index (roles.ts, compiled from the store's Tagger tree); names sort by byte
// order, not localeCompare (the tools answer the same on every machine); the fields only the graph's CLI printed
// (zero-link flags, hook tallies, incidental roles, card types) are left out.
import { rolesOf, type RoleHit, type RoleIndex } from "../roles";
import type { InteractionIndex, Link } from "./interact";
import { byteOrder } from "./profile";

export interface DeckEntry { name: string; count: number; /** Listed under a Commander section header. */ commander?: boolean }

export interface DeckCard {
  name: string;
  oracleId: string;
  count: number;
  isLand: boolean;
  /** Links in plus links out, inside this deck. */
  degree: number;
  /** The deck roles of a nonland card, each with the Tagger tags that gave it. Empty when unroled, absent on lands and when no role index was given. */
  roles?: RoleHit[];
}

/** The deck's roles: copies of nonland cards per role, every role listed, and the nonland cards with none. Lands are skipped, as on the role sheet. */
export interface DeckRoles {
  counts: Record<string, number>;
  unroled: string[];
}

export interface DeckGraph {
  cards: DeckCard[];
  /** Every link between two deck cards, once. */
  links: Link[];
  /** Lines that named no card the graph knows. */
  unresolved: string[];
  /** Commander names as the graph spells them: from `commanders`, else from a Commander section. */
  commanders: string[];
  /** Present when a role index was given. */
  roles?: DeckRoles;
}

/** Section headers that start a part of the list. Sideboard and maybeboard parts are not the deck. */
const SECTION = /^(commander|commanders|companion|deck|main|mainboard|sideboard|maybeboard|considering)\b\s*(\(\d+\))?:?$/i;
const NOT_DECK = /^(sideboard|maybeboard|considering)/i;

/**
 * Parses a decklist as exported by Moxfield, Archidekt, Arena, MTGO or TopDecked: "1 Card", "1x Card", "Card" (one copy),
 * set code and collector number suffixes ("(C21) 263", "[c21]", "*F*"), section headers, "SB:" lines, "Fire/Ice".
 * URLs and a leading "name: name" title line are skipped. Sideboard and maybeboard cards are left out.
 */
export function parseDeckList(text: string): DeckEntry[] {
  const out = new Map<string, DeckEntry>();
  let section = "deck";
  let first = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^https?:\/\//.test(line) || line.startsWith("//") || line.startsWith("#")) continue;
    const h = SECTION.exec(line);
    if (h) { section = h[1].toLowerCase(); first = false; continue; }
    if (/^SB:\s*/i.test(line)) continue;
    const m = /^(\d+)\s*x?\s+(.+)$/i.exec(line);
    // A first uncounted "title: title" line (TopDecked) is the deck's name, not a card.
    if (!m && first && /^[^:]+:\s/.test(line) && !/\s\/\/\s/.test(line)) { first = false; continue; }
    first = false;
    if (NOT_DECK.test(section)) continue;
    let name = (m ? m[2] : line)
      .replace(/\s+\*[A-Z]+\*$/i, "")          // *F*, *E* foil and etched markers
      .replace(/\s+[([][A-Za-z0-9]{2,6}[)\]](\s+\S+)?$/, "") // (C21) 263, [c21], (PLST) KTK-34
      .replace(/\s+\^[^^]*\^$/, "")           // Archidekt ^tag^ markers
      .trim();
    if (/^[^/]+\/[^/]+$/.test(name)) name = name.replace("/", " // "); // Fire/Ice
    const count = m ? Number(m[1]) : 1;
    const e = out.get(name) ?? { name, count: 0 };
    e.count += count;
    if (section.startsWith("commander")) e.commander = true;
    out.set(name, e);
  }
  return [...out.values()];
}

/**
 * Builds the deck graph. `commanders` are matched like any card name (any case, either face); a name not in the
 * list throws. Without them, cards listed under a Commander section are the commanders.
 */
export function deckGraph(idx: InteractionIndex, entries: DeckEntry[], commanders: string[] = [], roleIndex?: RoleIndex): DeckGraph {
  const unresolved: string[] = [];
  const members = new Map<number, number>();
  const sectionCommanders = new Set<number>();
  for (const e of entries) {
    let i: number;
    try { i = idx.indexOf(e.name); } catch { unresolved.push(e.name); continue; }
    members.set(i, (members.get(i) ?? 0) + e.count);
    if (e.commander) sectionCommanders.add(i);
  }
  const cmdIdx = commanders.length ? commanders.map((n) => {
    let i: number;
    try { i = idx.indexOf(n); } catch { throw new Error(`${n} is not a card the graph knows`); }
    if (!members.has(i)) throw new Error(`${idx.cards[i].name} is not in the list`);
    return i;
  }) : [...sectionCommanders];
  const memberSet = new Set(members.keys());
  const links = [...members.keys()].flatMap((i) => idx.linksWith(i, memberSet).filter((l) => l.from === idx.cards[i].name));
  const degree = new Map<string, number>();
  for (const l of links) for (const n of [l.from, l.to]) degree.set(n, (degree.get(n) ?? 0) + 1);

  const cards: DeckCard[] = [...members].map(([i, count]) => {
    const c = idx.cards[i];
    const isLand = c.types.includes("Land");
    const r = roleIndex && !isLand ? rolesOf(roleIndex, c.oracleId) : undefined;
    return { name: c.name, oracleId: c.oracleId, count, isLand, degree: degree.get(c.name) ?? 0, ...(r ? { roles: r.roles } : {}) };
  }).sort((a, b) => b.degree - a.degree || byteOrder(a.name, b.name));

  let roles: DeckRoles | undefined;
  if (roleIndex) {
    const counts = Object.fromEntries(roleIndex.roleNames.map((n) => [n, 0]));
    for (const c of cards) for (const r of c.roles ?? []) counts[r.role] += c.count;
    roles = { counts, unroled: cards.filter((c) => !c.isLand && !c.roles?.length).map((c) => c.name) };
  }

  return { cards, links, unresolved, commanders: cmdIdx.map((i) => idx.cards[i].name), ...(roles ? { roles } : {}) };
}
