// MV-15: the deck MCP's tools as plain functions over the card store (data/cards.db, MV-13). app/mcp.ts only wraps
// them. Every query is built from fixed SQL fragments with the caller's values bound as parameters; no tool takes SQL
// (ISA ISC-18), and the store is opened read-only. Same inputs, same answer, card for card (ISA Constraints).

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { ciMask, fitsIdentity } from "./color-identity";
import { buildSpace, normName, parseDecklist, type DeckEntry, type Space, type SpaceCard } from "./deck-pool";
import { planContext, type PlanContext, type PlanEcho } from "./plan";
import { planShape } from "./plan-input";
import { DB_PATH, DECK_ROOT } from "./paths";
import { compileRoleMap, roleSheet, rolesOf, type RoleHit, type RoleIndex, type RoleMap, type TagRecord } from "./roles";

const ROLE_MAP_PATH = new URL("./roles.json", import.meta.url).pathname;

// The vocabularies a filter value must come from, lower case → the store's spelling.
type Vocab = Map<string, string>;
export type Store = {
  db: Database;
  vocab: { types: Vocab; subtypes: Vocab; keywords: Vocab; tags: Map<string, { id: number; label: string }> };
  // every card as deck-pool's SpaceCard (rules data in `meta`, Regions in `r`, no neighbor lists), so decklists resolve
  // exactly as `bun app/deck.ts` resolves them and swapsFor reads the same fields
  space: Space;
  names: { id: number; oracleId: string; name: string; norm: string }[]; // every card, in store id (name) order, for fuzzy lookup
  roles: RoleIndex; // the MV-14 role map compiled against the store's own Tagger tree
};

type CardRow = {
  id: number; oracle_id: string; name: string; norm_name: string; layout: string; mana_cost: string; mana_value: number;
  type_line: string; supertypes: string; types: string; subtypes: string; is_land: number; oracle_text: string;
  power: string | null; toughness: string | null; keywords: string; color_identity: string; ci_mask: number;
  usd_price: number | null; in_card_space: number;
  region_leiden: number | null; region_leiden_hi: number | null; region_hdb10: number | null;
};

// The role map's Tagger records, rebuilt from the store's tags, tag_edges and card_tags (direct taggings), so the
// MCP reads one file. app/mcp.test.ts checks the Namor counts match roles.ts over the Oracle Tags file.
function storeTagRecords(db: Database): TagRecord[] {
  const recs = new Map((db.query("SELECT id, label FROM tags ORDER BY id").all() as { id: number; label: string }[])
    .map((t) => [t.id, { id: String(t.id), label: t.label, parent_ids: [] as string[], taggings: [] as { oracle_id: string }[] }]));
  for (const e of db.query("SELECT parent_id, child_id FROM tag_edges ORDER BY child_id, parent_id").all() as { parent_id: number; child_id: number }[])
    recs.get(e.child_id)?.parent_ids.push(String(e.parent_id));
  for (const g of db.query("SELECT ct.tag_id, c.oracle_id FROM card_tags ct JOIN cards c ON c.id = ct.card_id ORDER BY ct.tag_id, c.id").all() as { tag_id: number; oracle_id: string }[])
    recs.get(g.tag_id)?.taggings.push({ oracle_id: g.oracle_id });
  return [...recs.values()];
}

// The card's Regions as deck-pool's `r` (the swap lever's same-Region rule reads `leidenHi`); none outside the Card Space.
const regionsOf = (r: CardRow): SpaceCard["r"] => Object.fromEntries(
  ([["leiden", r.region_leiden], ["leidenHi", r.region_leiden_hi], ["hdb10", r.region_hdb10]] as const).filter(([, v]) => v !== null));

const spaceCard = (r: CardRow): SpaceCard => ({
  id: r.oracle_id, name: r.name, ci: [...r.color_identity], legal: true, land: !!r.is_land, inSpace: !!r.in_card_space,
  nb: [], ns: [], r: regionsOf(r),
  meta: { cost: r.mana_cost, type: r.type_line.split(" // ")[0], text: r.oracle_text, cmc: r.mana_value, usd: r.usd_price, keywords: JSON.parse(r.keywords) },
});

export function openStore(path = DB_PATH, roleMapPath = ROLE_MAP_PATH): Store {
  const db = new Database(path, { readonly: true, strict: true });
  const vocab = (sql: string): Vocab => new Map((db.query(sql).all() as { v: string }[]).map((r) => [r.v.toLowerCase(), r.v]));
  const tags = new Map((db.query("SELECT id, label FROM tags").all() as { id: number; label: string }[]).map((t) => [t.label.toLowerCase(), t]));
  const rows = db.query("SELECT * FROM cards ORDER BY id").all() as CardRow[];
  // resolveCard indexes `names` by id - 1: MV-13 numbers cards 1..N in name order
  rows.forEach((r, i) => { if (r.id !== i + 1) throw new Error(`${path}: card ids are not 1..N (row ${i} has id ${r.id})`); });
  const map: RoleMap = JSON.parse(readFileSync(roleMapPath, "utf8"));
  if (!Array.isArray(map?.roles)) throw new Error(`${roleMapPath}: no "roles" list`);
  return {
    db,
    vocab: {
      types: vocab("SELECT DISTINCT value AS v FROM card_types WHERE kind IN ('type', 'supertype') ORDER BY v"),
      subtypes: vocab("SELECT DISTINCT value AS v FROM card_types WHERE kind = 'subtype' ORDER BY v"),
      keywords: vocab("SELECT DISTINCT keyword AS v FROM card_keywords ORDER BY v"),
      tags,
    },
    space: buildSpace(rows.map(spaceCard)),
    names: rows.map((r) => ({ id: r.id, oracleId: r.oracle_id, name: r.name, norm: r.norm_name })),
    roles: compileRoleMap(map, storeTagRecords(db)),
  };
}

// A caller's mistake (unknown name, bad value): the server returns it as a tool error the model can act on (errors.ts).
export { ToolInputError } from "./errors";
import { ToolInputError } from "./errors";

// Edit distance, for "close matches" lists and fuzzy card names.
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Up to five known values close to `q`: containing it, contained in it, or within two edits; closest first.
function closeTo(q: string, values: Iterable<string>): string[] {
  const l = q.toLowerCase();
  return [...values]
    .map((k) => ({ k, d: editDistance(l, k.toLowerCase()), sub: k.toLowerCase().includes(l) || l.includes(k.toLowerCase()) }))
    .filter((x) => x.d <= 2 || x.sub)
    .sort((a, b) => a.d - b.d || (a.k < b.k ? -1 : 1))
    .slice(0, 5)
    .map((x) => x.k);
}

function known<T>(what: string, value: string, map: Map<string, T>, spell: (t: T) => string): T {
  const hit = map.get(value.toLowerCase());
  if (hit !== undefined) return hit;
  const near = closeTo(value, [...map.values()].map(spell));
  throw new ToolInputError(`unknown ${what} "${value}"${near.length ? `; close matches: ${near.join(", ")}` : ""}`);
}

// ---------- find_cards ----------
const range = (what: string) =>
  z.object({ min: z.number().optional(), max: z.number().optional() }).strict().describe(`${what} range, both ends inclusive`);

export const findCardsShape = {
  colorIdentity: z.string().regex(/^(C|c|[WUBRGwubrg]{1,5})$/).optional()
    .describe('Color identity the cards must fit inside, as WUBRG letters (e.g. "U", "UB"; "C" = colorless only)'),
  types: z.array(z.string().min(1)).optional().describe('Card types and supertypes the card must all have (e.g. ["Legendary", "Creature"])'),
  subtypes: z.array(z.string().min(1)).optional().describe('Subtypes the card must all have (e.g. ["Merfolk"])'),
  manaValue: range("Mana value").optional(),
  tags: z.array(z.string().min(1)).optional()
    .describe('Scryfall Tagger tags the card must all carry; a parent tag matches its descendants (e.g. ["ramp"])'),
  keywords: z.array(z.string().min(1)).optional().describe('Keywords the card must all have (e.g. ["Flying"])'),
  power: range("Power (cards with * in their power never match)").optional(),
  toughness: range("Toughness (cards with * in their toughness never match)").optional(),
  maxPrice: z.number().nonnegative().optional().describe("Scryfall USD price ceiling; unpriced cards never match"),
  land: z.boolean().optional().describe("true = lands only, false = nonland only; omit for both"),
  name: z.string().min(1).optional().describe("Part of the card name (case, accents and punctuation ignored)"),
  sort: z.enum(["name", "mana_value", "price"]).optional().describe("Result order (default name); ties break by name, then store id"),
  limit: z.number().int().min(1).max(100).optional().describe("Page size, 1 to 100 (default 25)"),
  offset: z.number().int().min(0).optional().describe("Skip this many matches (default 0)"),
  includeText: z.boolean().optional().describe("Include each card's oracle text (default false)"),
};
const findCardsInput = z.object(findCardsShape).strict();
export type FindCardsInput = z.input<typeof findCardsInput>;

export type FoundCard = {
  name: string; manaCost: string; manaValue: number; typeLine: string; colorIdentity: string;
  power: string | null; toughness: string | null; keywords: string[]; usd: number | null; oracleText?: string;
};
export type FindCardsResult = { total: number; offset: number; cards: FoundCard[] };

// power/toughness that are whole numbers ("-1" yes; "*", "1+*" no), compared as numbers
const numeric = (col: "power" | "toughness") => `(c.${col} IS NOT NULL AND CAST(CAST(c.${col} AS INTEGER) AS TEXT) = c.${col})`;
const ORDER_BY = {
  name: "c.name, c.id",
  mana_value: "c.mana_value, c.name, c.id",
  price: "c.usd_price IS NULL, c.usd_price, c.name, c.id",
} as const;

const found = (r: CardRow, text: boolean): FoundCard => ({
  name: r.name, manaCost: r.mana_cost, manaValue: r.mana_value, typeLine: r.type_line, colorIdentity: r.color_identity,
  power: r.power, toughness: r.toughness, keywords: JSON.parse(r.keywords), usd: r.usd_price, ...(text && { oracleText: r.oracle_text }),
});

// Every condition is a fixed fragment; only `?` values come from the caller.
export function findCards(store: Store, input: FindCardsInput): FindCardsResult {
  const f = findCardsInput.parse(input);
  const where: string[] = [], args: (string | number)[] = [];
  const add = (sql: string, ...v: (string | number)[]) => { where.push(sql); args.push(...v); };
  if (f.colorIdentity !== undefined) add("(c.ci_mask & ~?) = 0", ciMask(f.colorIdentity.toUpperCase())); // "C" has no bits
  for (const t of f.types ?? [])
    add("c.id IN (SELECT x.card_id FROM card_types x WHERE x.value = ? AND x.kind IN ('type', 'supertype'))", known("type", t, store.vocab.types, (v) => v));
  for (const t of f.subtypes ?? [])
    add("c.id IN (SELECT x.card_id FROM card_types x WHERE x.value = ? AND x.kind = 'subtype')", known("subtype", t, store.vocab.subtypes, (v) => v));
  for (const k of f.keywords ?? [])
    add("c.id IN (SELECT x.card_id FROM card_keywords x WHERE x.keyword = ?)", known("keyword", k, store.vocab.keywords, (v) => v));
  for (const t of f.tags ?? [])
    add("c.id IN (SELECT x.card_id FROM tag_closure k JOIN card_tags x ON x.tag_id = k.descendant_id WHERE k.ancestor_id = ?)",
      known("Tagger tag", t, store.vocab.tags, (v) => v.label).id);
  const between = (col: string, r?: { min?: number; max?: number }) => {
    if (r?.min !== undefined) add(`${col} >= ?`, r.min);
    if (r?.max !== undefined) add(`${col} <= ?`, r.max);
  };
  between("c.mana_value", f.manaValue);
  if (f.power) { add(numeric("power")); between("CAST(c.power AS INTEGER)", f.power); }
  if (f.toughness) { add(numeric("toughness")); between("CAST(c.toughness AS INTEGER)", f.toughness); }
  if (f.maxPrice !== undefined) add("c.usd_price IS NOT NULL AND c.usd_price <= ?", f.maxPrice);
  if (f.land !== undefined) add("c.is_land = ?", f.land ? 1 : 0);
  if (f.name !== undefined) add("instr(c.norm_name, ?) > 0", normName(f.name));
  const cond = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (store.db.query(`SELECT COUNT(*) AS n FROM cards c ${cond}`).get(...args) as { n: number }).n;
  const limit = f.limit ?? 25, offset = f.offset ?? 0;
  const rows = store.db.query(`SELECT c.* FROM cards c ${cond} ORDER BY ${ORDER_BY[f.sort ?? "name"]} LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as CardRow[];
  return { total, offset, cards: rows.map((r) => found(r, f.includeText ?? false)) };
}

// ---------- card ----------
// Name resolution, first stage that matches wins: exact (decklist normalization: case, accents and punctuation
// ignored), face (the front name of a two-faced card), prefix, substring (both need 3+ characters), then fuzzy (the
// fewest edits, at most a quarter of the name's length, two at least). Ties keep store order (name, then id);
// within prefix and substring a name whose part before the comma is the query leads ("Talrand" → "Talrand, Sky Summoner"),
// then the shortest name. The other names at the winning stage come back as
// `alternatives` (up to 10) so an ambiguous name is visible.
export type MatchKind = "exact" | "face" | "prefix" | "substring" | "fuzzy";
export type Resolved = { id: number; matchedBy: MatchKind; alternatives: string[] };

export function resolveCard(store: Store, name: string): Resolved {
  const q = normName(name);
  if (!q) throw new ToolInputError(`no card matches "${name}"`);
  const pick = (ids: number[], matchedBy: MatchKind): Resolved => ({
    id: ids[0], matchedBy, alternatives: ids.slice(1, 11).map((id) => store.names[id - 1].name),
  });
  const shortName = (n: Store["names"][number]) => (normName(n.name.split(",")[0]) === q ? 0 : 1);
  const shortestFirst = (a: Store["names"][number], b: Store["names"][number]) => shortName(a) - shortName(b) || a.norm.length - b.norm.length || a.id - b.id;
  const stages: [MatchKind, (n: Store["names"][number]) => boolean, boolean][] = [
    ["exact", (n) => n.norm === q, false],
    ["face", (n) => n.name.includes(" // ") && normName(n.name.split(" // ")[0]) === q, false],
    ["prefix", (n) => q.length >= 3 && n.norm.startsWith(q), true],
    ["substring", (n) => q.length >= 3 && n.norm.includes(q), true],
  ];
  for (const [kind, hit, shortest] of stages) {
    const ids = store.names.filter(hit);
    if (ids.length) return pick((shortest ? ids.sort(shortestFirst) : ids).map((n) => n.id), kind);
  }
  const budget = Math.max(2, Math.floor(q.length / 4));
  const scored = store.names.map((n) => ({ id: n.id, d: Math.abs(n.norm.length - q.length) > budget ? budget + 1 : editDistance(q, n.norm) }))
    .filter((x) => x.d <= budget)
    .sort((a, b) => a.d - b.d || a.id - b.id);
  if (!scored.length) throw new ToolInputError(`no card matches "${name}"`);
  return pick(scored.map((x) => x.id), "fuzzy");
}

export const cardShape = {
  name: z.string().min(1).describe("Card name; case, accents and punctuation are ignored, a front-face name, a partial name or a small misspelling resolve too"),
};
const cardInput = z.object(cardShape).strict();
export type CardInput = z.input<typeof cardInput>;

export type CardDetails = {
  name: string; oracleId: string; layout: string; manaCost: string; manaValue: number; typeLine: string;
  supertypes: string[]; types: string[]; subtypes: string[]; oracleText: string; power: string | null; toughness: string | null;
  keywords: string[]; colorIdentity: string; usd: number | null; land: boolean; inCardSpace: boolean;
  tags: { label: string; weight: string }[]; // direct Tagger taggings, by label
  roles: RoleHit[]; incidentalRoles: RoleHit[]; // MV-14 role map: role → the card's tags that gave it
};
export type CardResult = { matchedBy: MatchKind; alternatives: string[]; card: CardDetails };

const words = (s: string) => s.split(" ").filter(Boolean);

export function cardDetails(store: Store, input: CardInput): CardResult {
  const { name } = cardInput.parse(input);
  const { id, matchedBy, alternatives } = resolveCard(store, name);
  const r = store.db.query("SELECT * FROM cards WHERE id = ?").get(id) as CardRow | null;
  if (!r) throw new Error(`card store is inconsistent: id ${id} resolved but has no row`);
  const tags = store.db.query("SELECT t.label, ct.weight FROM card_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.card_id = ? ORDER BY t.label")
    .all(id) as { label: string; weight: string }[];
  const roles = rolesOf(store.roles, r.oracle_id);
  return {
    matchedBy, alternatives,
    card: {
      name: r.name, oracleId: r.oracle_id, layout: r.layout, manaCost: r.mana_cost, manaValue: r.mana_value, typeLine: r.type_line,
      supertypes: words(r.supertypes), types: words(r.types), subtypes: words(r.subtypes), oracleText: r.oracle_text,
      power: r.power, toughness: r.toughness, keywords: JSON.parse(r.keywords), colorIdentity: r.color_identity, usd: r.usd_price,
      land: !!r.is_land, inCardSpace: !!r.in_card_space, tags, roles: roles.roles, incidentalRoles: roles.incidental,
    },
  };
}

// ---------- deck_stats ----------
// A deck file (or pasted list) of `1 Card Name` lines, read with deck-pool's parseDecklist (headers, URLs, set
// codes skipped). The numbers cover the cards in the list as written: the commander counts once if the list has
// it (`commanderInDeck`) and is never added. Lands are left out of the average, the curve and the pip load.
//   averageManaValue  mean mana value of nonland copies (X counts 0), rounded to 3 places
//   curve             nonland copies by mana value, 0 to 6 and 7+ (fractional values round down)
//   roleCounts        MV-14 role map: copies per role, every role listed; `unroled` names nonland cards with none
//   pipLoad           colored mana symbols in nonland mana costs (front face), per color; a hybrid or Phyrexian
//                     symbol counts once for each color in it
//   planFit           with the player's confirmed plan (`plan`): which nonland cards other than the commander fit it
//                     (plan.ts planScorer score > 0: a hook or tag of the plan's profiles), and which do not; null when
//                     the call carries no plan. The plan always comes from the player, never from the commander's text.
const CURVE = ["0", "1", "2", "3", "4", "5", "6", "7+"] as const;
const COLORS = ["W", "U", "B", "R", "G"] as const;

export const deckStatsShape = {
  commander: z.string().min(1).describe("The commander's exact name or front-face name (case and punctuation ignored); use the card tool to look a partial name up"),
  deckFile: z.string().min(1).optional().describe("Path to a `1 Card Name` decklist file, absolute or relative to the project directory (e.g. decks/namor.txt)"),
  decklist: z.string().min(1).optional().describe("The decklist text itself, `1 Card Name` per line; give this or deckFile"),
  plan: planShape.optional().describe("The player's confirmed plan (themes, priority cards, themes to avoid); with it, planFit says which cards fit it"),
};
const deckStatsInput = z.object(deckStatsShape).strict();
export type DeckStatsInput = z.input<typeof deckStatsInput>;

// The numbers for a resolved list, without the commander lookup or the unresolved lines: deckStats reports them, and
// the swap tools (swap-tools.ts) call this on a list with one swap applied for the after side of a candidate.
export type DeckNumbers = {
  commanderInDeck: boolean;
  cards: number; lands: number; nonland: number; // copies of resolved cards
  averageManaValue: number;
  curve: Record<(typeof CURVE)[number], number>;
  roleCounts: Record<string, number>;
  unroled: string[];
  pipLoad: Record<(typeof COLORS)[number], number>;
  planFit: { plan: PlanEcho; onPlan: number; of: number; offPlan: string[] } | null; // null without a plan
  offIdentity: string[]; // cards outside the commander's color identity
};
export type DeckStats = DeckNumbers & {
  commander: { name: string; colorIdentity: string; matchedBy: MatchKind };
  unresolved: { line: number; text: string; closeMatches: string[] }[];
};

// A deckFile path as the tools read it: absolute, or relative to the repo root.
export const deckPath = (deckFile: string) => (isAbsolute(deckFile) ? deckFile : join(DECK_ROOT, deckFile));

export function readDeck(input: { deckFile?: string; decklist?: string }): string {
  if ((input.deckFile === undefined) === (input.decklist === undefined)) throw new ToolInputError("give exactly one of deckFile or decklist");
  if (input.decklist !== undefined) return input.decklist;
  const path = deckPath(input.deckFile!);
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new ToolInputError(`cannot read deck file ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// The commander sets the plan and the identity, so a guess would skew every number: exact or front face only.
export function resolveCommander(store: Store, name: string): { card: SpaceCard; matchedBy: MatchKind } {
  const who = resolveCard(store, name);
  if (who.matchedBy !== "exact" && who.matchedBy !== "face") {
    const candidates = [store.names[who.id - 1].name, ...who.alternatives].join("; ");
    throw new ToolInputError(`commander "${name}" is not an exact card name; candidates: ${candidates}`);
  }
  const card = store.space.cards.get(store.names[who.id - 1].oracleId);
  if (!card) throw new Error(`card store is inconsistent: ${store.names[who.id - 1].name} resolved but is not in the deck index`);
  return { card, matchedBy: who.matchedBy };
}

export function unresolvedLines(store: Store, misses: DeckEntry[]): DeckStats["unresolved"] {
  return misses.map((e) => {
    let closeMatches: string[] = [];
    try { const r = resolveCard(store, e.text); closeMatches = [store.names[r.id - 1].name, ...r.alternatives].slice(0, 5); } catch (err) { if (!(err instanceof ToolInputError)) throw err; }
    return { line: e.line, text: e.text, closeMatches };
  });
}

export function deckNumbers(store: Store, commander: SpaceCard, deckEntries: DeckEntry[], plan: PlanContext | null = null): DeckNumbers {
  const entries = deckEntries.filter((e): e is DeckEntry & { card: SpaceCard } => !!e.card);
  const nonland = entries.filter((e) => !e.card.land);
  const copies = (es: typeof entries) => es.reduce((n, e) => n + e.qty, 0);

  const curve = Object.fromEntries(CURVE.map((k) => [k, 0])) as DeckNumbers["curve"];
  const pipLoad = Object.fromEntries(COLORS.map((k) => [k, 0])) as DeckNumbers["pipLoad"];
  let mvSum = 0;
  for (const e of nonland) {
    const mv = e.card.meta!.cmc;
    mvSum += mv * e.qty;
    curve[CURVE[Math.min(7, Math.floor(mv))]] += e.qty;
    for (const sym of e.card.meta!.cost.match(/\{[^}]+\}/g) ?? []) for (const c of COLORS) if (sym.includes(c)) pipLoad[c] += e.qty;
  }
  const n = copies(nonland);

  const sheet = roleSheet(store.roles, deckEntries);
  const scored = [...new Map(nonland.filter((e) => e.card.id !== commander.id).map((e) => [e.card.id, e.card])).values()];
  const offPlan = plan ? scored.filter((c) => plan.fit(c.id).score === 0).map((c) => c.name) : [];
  const distinct = [...new Map(entries.map((e) => [e.card.id, e.card])).values()];
  const offIdentity = distinct.filter((c) => !fitsIdentity(c, commander.ci)).map((c) => c.name);

  return {
    commanderInDeck: entries.some((e) => e.card.id === commander.id),
    cards: copies(entries), lands: copies(entries) - n, nonland: n,
    averageManaValue: n ? Math.round((mvSum / n) * 1000) / 1000 : 0,
    curve, roleCounts: sheet.counts, unroled: sheet.unroled, pipLoad,
    planFit: plan ? { plan: plan.plan, onPlan: scored.length - offPlan.length, of: scored.length, offPlan } : null,
    offIdentity,
  };
}

export function deckStats(store: Store, input: DeckStatsInput): DeckStats {
  const f = deckStatsInput.parse(input);
  const text = readDeck(f);
  const { card: commander, matchedBy } = resolveCommander(store, f.commander);
  const deck = parseDecklist(store.space, text);
  const plan = planContext(store, commander.name, f.plan);
  return {
    commander: { name: commander.name, colorIdentity: commander.ci.join(""), matchedBy },
    ...deckNumbers(store, commander, deck.entries, plan),
    unresolved: unresolvedLines(store, deck.unresolved),
  };
}

// ---------- neighbors (ISC-26) ----------
// A card's Card Space neighbors that a commander can play, nearest first, with their similarity scores. The store
// keeps one list per card over every identity; the first rows whose neighbor fits the commander's identity are exactly
// MV-10's in-color top 30 (same cards, order and scores) when the card itself fits that identity (card-store.md), so a
// card outside the identity is an error rather than a list without that guarantee. Lands and other cards outside the
// Card Space have no list. A text-less card lists only text-less cards, so it can have fewer than 30.
const NEIGHBORS_K = 30;

export const neighborsShape = {
  card: z.string().min(1).describe("The card whose neighbors to list; case, accents and punctuation are ignored, and a partial name or small misspelling resolves"),
  commander: z.string().min(1).describe("The commander's exact name or front-face name; neighbors are limited to its color identity, and the card must fit it"),
  limit: z.number().int().min(1).max(NEIGHBORS_K).optional().describe(`How many neighbors, nearest first, 1 to ${NEIGHBORS_K} (default ${NEIGHBORS_K})`),
};
const neighborsInput = z.object(neighborsShape).strict();
export type NeighborsInput = z.input<typeof neighborsInput>;

export type Neighbor = {
  rank: number; // 1 = nearest, counted within the commander's identity
  name: string; score: number; // Card Space similarity
  manaValue: number; typeLine: string; colorIdentity: string; usd: number | null;
  roles: string[]; // MV-14 role map
};
export type NeighborsResult = {
  card: { name: string; colorIdentity: string; matchedBy: MatchKind; alternatives: string[] };
  commander: { name: string; colorIdentity: string };
  neighbors: Neighbor[];
};

export function neighbors(store: Store, input: NeighborsInput): NeighborsResult {
  const f = neighborsInput.parse(input);
  const { card: commander } = resolveCommander(store, f.commander);
  const { id, matchedBy, alternatives } = resolveCard(store, f.card);
  const card = store.space.cards.get(store.names[id - 1].oracleId);
  if (!card) throw new Error(`card store is inconsistent: ${store.names[id - 1].name} resolved but is not in the deck index`);
  if (!card.inSpace) throw new ToolInputError(`${card.name} is not in the Card Space (lands have no neighbors)`);
  if (!fitsIdentity(card, commander.ci)) {
    throw new ToolInputError(`${card.name} is outside ${commander.name}'s color identity (${commander.ci.join("") || "colorless"}); ask for a card the deck can play`);
  }
  const rows = store.db.query(`SELECT c.*, n.score AS score FROM neighbors n JOIN cards c ON c.id = n.neighbor_id
    WHERE n.card_id = ? AND (c.ci_mask & ~?) = 0 ORDER BY n.rank LIMIT ?`).all(id, ciMask(commander.ci), f.limit ?? NEIGHBORS_K) as (CardRow & { score: number })[];
  return {
    card: { name: card.name, colorIdentity: card.ci.join(""), matchedBy, alternatives },
    commander: { name: commander.name, colorIdentity: commander.ci.join("") },
    neighbors: rows.map((r, i) => ({
      rank: i + 1, name: r.name, score: r.score, manaValue: r.mana_value, typeLine: r.type_line, colorIdentity: r.color_identity,
      usd: r.usd_price, roles: rolesOf(store.roles, r.oracle_id).roles.map((h) => h.role),
    })),
  };
}

// ---------- tags ----------
// The Tagger vocabulary is ~4,600 tags, far more than any role map or lever names, so a concept the levers do not
// cover ("anthem", "evasion", "sac outlet") is found here and then searched with find_cards' `tags` filter. Every
// word of `text` must appear in a tag's label or description (case ignored). Order: exact label, label starting with
// the text, every word in the label, the rest; then most cards; then label. `cards` counts the commander-legal cards
// carrying the tag or any descendant, inside `colorIdentity` when given, so it is the count find_cards would return.
export const tagsShape = {
  text: z.string().min(1).describe('Words to look for in Tagger tag labels and descriptions (e.g. "anthem", "evasion", "sacrifice outlet")'),
  colorIdentity: z.string().regex(/^(C|c|[WUBRGwubrg]{1,5})$/).optional()
    .describe("Count only cards that fit inside this color identity (WUBRG letters); tags with no such card are left out"),
  limit: z.number().int().min(1).max(50).optional().describe("Most tags to return, 1 to 50 (default 15)"),
};
const tagsInput = z.object(tagsShape).strict();
export type TagsInput = z.input<typeof tagsInput>;
export type TagHit = { label: string; description: string | null; cards: number; parents: string[] };
export type TagsResult = { total: number; tags: TagHit[] };

export function findTags(store: Store, input: TagsInput): TagsResult {
  const f = tagsInput.parse(input);
  const text = f.text.toLowerCase().trim();
  const words = text.split(/\s+/).filter(Boolean);
  const all = store.db.query("SELECT id, label, description FROM tags ORDER BY label").all() as { id: number; label: string; description: string | null }[];
  const rank = (t: { label: string; description: string | null }): number => {
    const label = t.label.toLowerCase(), hay = `${label} ${(t.description ?? "").toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) return -1;
    if (label === text) return 0;
    if (label.startsWith(text)) return 1;
    if (words.every((w) => label.includes(w))) return 2;
    return 3;
  };
  const ci = f.colorIdentity !== undefined ? ciMask(f.colorIdentity.toUpperCase()) : undefined;
  const count = store.db.query(ci === undefined
    ? "SELECT COUNT(DISTINCT x.card_id) AS n FROM tag_closure k JOIN card_tags x ON x.tag_id = k.descendant_id WHERE k.ancestor_id = ?"
    : "SELECT COUNT(DISTINCT x.card_id) AS n FROM tag_closure k JOIN card_tags x ON x.tag_id = k.descendant_id JOIN cards c ON c.id = x.card_id WHERE k.ancestor_id = ? AND (c.ci_mask & ~?) = 0");
  const parentsOf = store.db.query("SELECT p.label FROM tag_edges e JOIN tags p ON p.id = e.parent_id WHERE e.child_id = ? ORDER BY p.label");
  const hits = all
    .map((t) => ({ t, r: rank(t) }))
    .filter((h) => h.r >= 0)
    .map((h) => ({ ...h, n: (ci === undefined ? count.get(h.t.id) : count.get(h.t.id, ci)) as { n: number } }))
    .filter((h) => h.n.n > 0)
    .sort((a, b) => a.r - b.r || b.n.n - a.n.n || (a.t.label < b.t.label ? -1 : a.t.label > b.t.label ? 1 : 0));
  return {
    total: hits.length,
    tags: hits.slice(0, f.limit ?? 15).map((h) => ({
      label: h.t.label, description: h.t.description, cards: h.n.n,
      parents: (parentsOf.all(h.t.id) as { label: string }[]).map((p) => p.label),
    })),
  };
}
