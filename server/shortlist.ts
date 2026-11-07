// DT-6.5, 6.13, 6.14: the shortlist tool (ISA ISC-41, 45.2, 59 to 65, 67, 86, 88 to 90). For one diagnosed problem and the player's confirmed plan,
// about 30 in-color cards outside the deck, each labeled by where it came from and carrying its links into the deck and
// the deck before and after it goes in. The data narrows ~31k cards to a shortlist with reasons; Claude judges it.
//
// The problem says which cards are candidates (the pool):
//   role       nonland cards holding a deck role (ramp, removal, ...), as the role map reads their Tagger tags
//   engineGap  cards that make an event happen to your own cards for at least one deck card paying off on it (the
//              diagnosis's engine gap, named by its words, "a creature dying"), lands included, as the gap's outlets are
//   offPlan    nonland cards that fit the plan (plan.ts planScorer above 0): replacements for cards off the plan or doing
//              the least
// Every pool card is commander-legal (every store card is), inside the commander's color identity, not the commander, not
// in the deck, and under the mana value and price ceilings when given. Left out, and counted in the notes: a card that
// fits a theme the plan avoids and does not fit the plan, and a cost reducer whose discounts name only colors or types the
// deck never casts (cost-reduction.ts, ISC-86).
//
// The plan's priority cards the deck lacks are offered whatever the problem (label: named by the player), unless a mana
// value or price ceiling rules one out (the notes say so), and count as deck cards for links (ISC-89).
//
// Rankings of the pool, each the source of one label:
//   fits this commander  commander synergy: the commander's EDHREC page weight, inclusion x max(0, synergy + offset)
//                        (the graph's synergy ranking; only cards the page lists with a weight above 0)
//   deeper cut           Tagger Deck fit: the card's Tagger Card vector against the commander's Tagger Deck vector (dot
//                        product; the commander's own card vector when it has no page), above 0
//   widely played        global EDHREC rank (Scryfall's), lowest first: popularity across all decks
//   fits the named theme only when the player named a theme and priority cards: fit to the named themes alone (plan.ts
//                        planScorer without the priority cards' profile), then the engine order's measures
//   engine partner       the card graph: links into the deck. First the cards linked to the plan's priority cards in the
//                        deck (most priority cards linked first); then, for an engine gap, payoffs fed (most first), an
//                        outlet that can fire again before a one-shot; then links into the deck's on-plan cards (the
//                        commander counts as on plan), then links into any deck card, then plan fit.
// Ties fall to the name in byte order, so the same deck, plan and problem give the same shortlist on every machine.
//
// The shortlist fills in this order, never past SHORTLIST_MAX (30): the named cards the deck lacks; the first PER_SOURCE
// (10) of commander synergy and of Tagger Deck fit; THEME_SLOTS (3) picks of a theme the player named beside priority
// cards (ISC-90; an inferred theme keeps none); at most POPULAR_ONLY (5) of the first 10 widely played cards not already
// in (ISC-63); then cards linked to a priority card (ISC-88), then the other engine partners. A player's plan is usually
// a few key cards and the interactions between them, not a list of staples. The 10 + 10 + 10 union measured in
// mtg-graph-api's leave-one-out (30 of 57 on Namor, 24 of 39 on Teysa) is the recall check (ISC-65). A card's labels
// are every ranking whose taken part holds it.

import { z } from "zod";
import { fitsIdentity } from "./color-identity";
import { discountUsable, spellDiscounts, type CastFacts } from "./cost-reduction";
import { type DeckEntry, type SpaceCard } from "./deck-pool";
import { deckNumbers, readDeck, resolveCard, resolveCommander, ToolInputError, unresolvedLines, type DeckStats, type Store } from "./deck-tools";
import { deckLinks, deckOnGraph, type DeckLink, type DeckOnGraph } from "./diagnose";
import { hookPhrase, outsideFeeders, payoffsOf } from "./graph/diagnose";
import type { Link } from "./graph/interact";
import { byteOrder, offProfile } from "./graph/profile";
import { graphOf } from "./graph/store-graph";
import { planEcho, planScorer, resolvePlan, type PlanContext, type PlanEcho, type PlanFit } from "./plan";
import { planShape } from "./plan-input";
import { rolesOf } from "./roles";
import { applySwap, statsDelta, swapStats, type StatsDelta, type SwapStats } from "./swap-tools";

export const SHORTLIST_LABELS = ["named by the player", "fits this commander", "deeper cut", "widely played", "fits the named theme", "engine partner"] as const;
export type SourceLabel = (typeof SHORTLIST_LABELS)[number];
/** Cards each of the first three rankings puts in: the measured union's 10 per source. */
export const PER_SOURCE = 10;
/** The most cards a shortlist holds: three sources of PER_SOURCE. */
export const SHORTLIST_MAX = 30;
/** The most cards popularity alone puts in (ISC-63, set 2026-11-07, reversible): widely played cards beyond this enter only
 * when another source wants them too. */
export const POPULAR_ONLY = 5;
/** Slots a theme the player named keeps once priority cards are named too (ISC-90, set 2026-11-07, reversible); an
 * inferred theme keeps none. */
export const THEME_SLOTS = 3;

const problemShape = z.union([
  z.object({ role: z.string().min(1).describe("A deck role, as diagnose and deck_stats name it (ramp, card draw, card selection, removal, board wipe, counterspell, protection, tutor, recursion, cost reducer): cards that hold it") }).strict(),
  z.object({ engineGap: z.string().min(1).describe("What an engine's payoffs wait on, in the words diagnose gives an engine gap's `mechanic` (e.g. \"a creature dying\"): cards that make it happen for the deck's payoffs") }).strict(),
  z.object({ offPlan: z.literal(true).describe("Cards that fit the plan, to replace cards off the plan or doing the least") }).strict(),
]).describe("The one diagnosed problem the shortlist answers: { role }, { engineGap } or { offPlan: true }");

export const shortlistShape = {
  commander: z.string().min(1).describe("The commander's exact name or front-face name (case and punctuation ignored)"),
  deckFile: z.string().min(1).optional().describe("Path to a `1 Card Name` decklist file, absolute or relative to the project directory (e.g. decks/namor.txt)"),
  decklist: z.string().min(1).optional().describe("The decklist text itself, `1 Card Name` per line; give this or deckFile"),
  plan: planShape.describe("The player's confirmed plan (themes, priority cards, themes to avoid): the engine partners lean on it, and every card's plan fit is read against it"),
  problem: problemShape,
  maxManaValue: z.number().min(0).optional().describe("Only cards with mana value at most this"),
  maxPrice: z.number().min(0).optional().describe("Only cards with a Scryfall USD price at most this (an unpriced card is left out)"),
  out: z.string().min(1).optional().describe("A card in the deck to swap out, exact name: each shortlist card then carries the swap, the deck numbers after swapping it in for this one (`after`) and what changed, instead of what adding it changes"),
};
const shortlistInput = z.object(shortlistShape).strict();
export type ShortlistInput = z.input<typeof shortlistInput>;

export type ShortlistCard = {
  name: string;
  manaValue: number;
  usd: number | null;
  typeLine: string;
  roles: string[];
  /** Where it came from, in SHORTLIST_LABELS order: every ranking whose taken part holds it. */
  labels: SourceLabel[];
  evidence: {
    /** The commander page's weight for it; null when the page does not list it. */
    commanderSynergy: number | null;
    /** Its Tagger Deck fit; null when it has no kept Tagger tags or no fit. */
    taggerFit: number | null;
    /** Scryfall's global EDHREC rank; null when it has none. */
    edhrecRank: number | null;
    /** Distinct deck cards it links to over links that count (not generic, not mana or keyword grants). */
    partners: number;
    /** Of those, the deck cards that fit the plan, and the commander. */
    planPartners: number;
    /** Its fit to the plan (plan.ts planScorer): 0 is off the plan; what matched, heaviest first. */
    planFit: PlanFit;
    /** The plan's priority cards in the deck it links to, over links that count; empty when none. */
    priorityLinks: string[];
    /** Engine gap only: the deck's payoffs it would feed. */
    feeds?: string[];
  };
  /** Its links into the deck that count, one row per event: the deck cards it feeds and is fed by on it (not generic, not
   * mana or keyword grants; the links its partners are counted over). Events in byte order. */
  links: ShortlistLink[];
  /** Links only because it is cast or enters, into deck cards that take a third of all cards that way: any card would make them. */
  genericLinks: number;
  /** Present when no link counts: why. */
  noLinks?: string;
  /** With `out`: the deck numbers after this card is swapped in for it (`before` is given once). */
  after?: SwapStats;
  /** What changes from `before`: swapped in for `out` when the call names one, else added. */
  delta: StatsDelta;
  /** Plan fit in minus out (out scores 0 when the call names none). */
  planGain: number;
};

export type ShortlistLink = { on: string; feeds: string[]; fedBy: string[] };

export type ShortlistResult = {
  commander: { name: string; colorIdentity: string };
  plan: PlanEcho;
  problem: { kind: "role"; role: string } | { kind: "engine gap"; mechanic: string; payoffs: string[] } | { kind: "off plan" };
  ceilings: { maxManaValue: number | null; maxPrice: number | null };
  out: { name: string; manaValue: number; usd: number | null; planFit: number } | null;
  /** How many cards fit the problem under the ceilings, the shortlist drawn from them. */
  pool: number;
  before: SwapStats;
  cards: ShortlistCard[];
  notes: string[];
  unresolved: DeckStats["unresolved"];
};

// ---------- per-store facts ----------
type StoreFacts = { edhrecRank: Map<number, number>; synergyOffset: number; vectors: Map<number, Map<number, number> | null> };
const FACTS = new WeakMap<Store, StoreFacts>();

function storeFacts(store: Store): StoreFacts {
  const hit = FACTS.get(store);
  if (hit) return hit;
  const edhrecRank = new Map((store.db.query("SELECT card_id, edhrec_rank FROM card_scryfall WHERE edhrec_rank IS NOT NULL").all() as { card_id: number; edhrec_rank: number }[]).map((r) => [r.card_id, r.edhrec_rank]));
  const off = store.db.query("SELECT value FROM meta WHERE key = 'tagger_deck_synergy_offset'").get() as { value: string } | null;
  const synergyOffset = off ? Number(off.value) : NaN;
  if (!Number.isFinite(synergyOffset)) throw new Error("the card store records no tagger_deck_synergy_offset in meta");
  const out = { edhrecRank, synergyOffset, vectors: new Map() };
  FACTS.set(store, out);
  return out;
}

/** A packed Tagger vector (n float32 weights then n uint16 tag ids, little-endian; store.ts) as tag id → weight. */
function unpackVector(blob: Uint8Array): Map<number, number> {
  if (blob.byteLength % 6 !== 0) throw new Error(`Tagger vector of ${blob.byteLength} bytes is not n float32 + n uint16`);
  const n = blob.byteLength / 6;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Map<number, number>();
  for (let i = 0; i < n; i++) out.set(view.getUint16(n * 4 + i * 2, true), view.getFloat32(i * 4, true));
  return out;
}

function cardVector(store: Store, cardId: number): Map<number, number> | null {
  const f = storeFacts(store);
  if (f.vectors.has(cardId)) return f.vectors.get(cardId)!;
  const row = store.db.query("SELECT vector FROM card_tagger WHERE card_id = ?").get(cardId) as { vector: Uint8Array } | null;
  const v = row ? unpackVector(row.vector) : null;
  f.vectors.set(cardId, v);
  return v;
}

/** The commander's page signals: synergy weight per listed card id, and the Tagger Deck vector to fit against. */
function commanderSignals(store: Store, commanderId: number): { synergy: Map<number, number>; deckVector: Map<number, number> | null; notes: string[] } {
  const { synergyOffset } = storeFacts(store);
  const page = store.db.query("SELECT tagger_deck, tagger_deck_fallback FROM commanders WHERE card_id = ?").get(commanderId) as { tagger_deck: Uint8Array; tagger_deck_fallback: string | null } | null;
  const notes: string[] = [];
  if (!page) {
    notes.push("the commander has no EDHREC page: no card fits this commander by synergy, and the deeper cuts are fit to the commander's own card tags");
    return { synergy: new Map(), deckVector: cardVector(store, commanderId), notes };
  }
  if (page.tagger_deck_fallback) notes.push(`the commander's page is ${page.tagger_deck_fallback === "thin" ? "thin (under 20 decks)" : "without kept tags"}: the deeper cuts are fit to the commander's own card tags`);
  const rows = store.db.query("SELECT card_id, decks, potential_decks, synergy FROM commander_cards WHERE commander_id = ? ORDER BY card_id").all(commanderId) as { card_id: number; decks: number; potential_decks: number; synergy: number }[];
  const synergy = new Map<number, number>();
  for (const r of rows) {
    const w = (r.potential_decks ? r.decks / r.potential_decks : 0) * Math.max(0, r.synergy + synergyOffset);
    if (w > 0) synergy.set(r.card_id, w);
  }
  return { synergy, deckVector: unpackVector(page.tagger_deck), notes };
}

function taggerFit(store: Store, deckVector: Map<number, number> | null, cardId: number): number {
  if (!deckVector) return 0;
  let s = 0;
  for (const [t, w] of cardVector(store, cardId) ?? []) s += w * (deckVector.get(t) ?? 0);
  return s;
}

// ---------- links into a deck, kept for recent decks ----------
// A pool card's links with the deck's members (the graph's linksWith, through a linker built once per deck), memoized
// per deck: the engine ranking reads every pool card's partners, and the same deck is asked for several problems in a
// session. The deck key is its graph members, so the same cards in another order or spelling share it.
const RECENT_DECKS = 4;
type DeckLinks = { linker: (pos: number) => Link[]; links: Map<number, Link[]> };
const LINKS = new WeakMap<Store, Map<string, DeckLinks>>();

function linksIntoDeck(store: Store, members: ReadonlySet<number>): (pos: number) => Link[] {
  let byDeck = LINKS.get(store);
  if (!byDeck) LINKS.set(store, (byDeck = new Map()));
  const key = [...members].sort((a, b) => a - b).join(",");
  let memo = byDeck.get(key);
  if (memo) byDeck.delete(key); // re-inserted below as the most recent
  else memo = { linker: graphOf(store.db).index.linkerFor(members), links: new Map() };
  byDeck.set(key, memo);
  while (byDeck.size > RECENT_DECKS) byDeck.delete(byDeck.keys().next().value!);
  const { linker, links } = memo;
  return (pos) => {
    let ls = links.get(pos);
    if (!ls) links.set(pos, (ls = linker(pos)));
    return ls;
  };
}

// ---------- the tool ----------

type Candidate = { card: SpaceCard; id: number; pos: number | undefined; fit: PlanFit; feeds?: { feeds: Set<string>; repeatable: boolean } };

export function shortlist(store: Store, input: ShortlistInput): ShortlistResult {
  const f = shortlistInput.parse(input);
  const text = readDeck(f);
  const { card: commander } = resolveCommander(store, f.commander);
  const resolved = resolvePlan(store, { commander: commander.name, plan: f.plan });
  const fit = planScorer(store, resolved);
  const planCtx: PlanContext = { plan: planEcho(resolved), fit };
  const graph = graphOf(store.db);
  const idx = graph.index;
  const d = deckOnGraph(store, commander, text);
  const { deck, idOf, ctx } = d;
  const commanderId = idOf.get(commander.id)!;
  const inDeck = new Set(deck.entries.filter((e) => e.card).map((e) => e.card!.id));
  const entries = deck.entries;

  const out = f.out === undefined ? null : outCard(store, f.out, entries);
  // The plan's priority cards the deck lacks (ISC-89): each is offered, and counts as a deck card for links.
  const named = resolved.priorities.map((n) => store.space.cards.get(store.names.find((x) => x.name === n)!.oracleId)!);
  const absentNamed = named.filter((c) => !inDeck.has(c.id) && c.id !== commander.id);

  // The pool.
  const notes: string[] = [];
  const eligible = (c: SpaceCard, allowLand: boolean) =>
    (allowLand || !c.land) && c.id !== commander.id && !inDeck.has(c.id) && fitsIdentity(c, commander.ci) &&
    (f.maxManaValue === undefined || c.meta!.cmc <= f.maxManaValue) &&
    (f.maxPrice === undefined || (c.meta!.usd !== null && c.meta!.usd <= f.maxPrice));
  const avoid = resolved.avoid.map((p) => planScorer(store, { ...resolved, themes: [p], cards: null, inference: null }));
  let avoided = 0, idleDiscounts = 0;
  const casts = castFacts(store, [commander, ...entries.filter((e) => e.card && !e.card.land).map((e) => e.card!)]);
  const subtypes = new Set(store.vocab.subtypes.keys());
  const keep = (c: SpaceCard): boolean => {
    // a cost reducer whose discounts name only colors or types the deck never casts (cost-reduction.ts)
    if (/\bless\b/i.test(c.meta!.text) && !discountUsable(spellDiscounts(c.meta!.text, subtypes), casts)) { idleDiscounts++; return false; }
    if (!avoid.length || fit(c.id).score > 0 || !avoid.some((a) => a(c.id).score > 0)) return true;
    avoided++;
    return false;
  };
  const candidate = (c: SpaceCard): Candidate => {
    const id = idOf.get(c.id)!;
    return { card: c, id, pos: graph.positionOf.get(id), fit: fit(c.id) };
  };
  let problem: ShortlistResult["problem"];
  let pool: Candidate[];
  const all = () => store.names.map((n) => store.space.cards.get(n.oracleId)!);
  if ("role" in f.problem) {
    // matched whatever the capitals, as the engine gap's words are
    const role = store.roles.roleNames.find((r) => r.toLowerCase() === f.problem.role.trim().toLowerCase());
    if (role === undefined) throw new ToolInputError(`unknown role "${f.problem.role}"; roles: ${store.roles.roleNames.join(", ")}`);
    problem = { kind: "role", role };
    pool = all().filter((c) => eligible(c, false) && rolesOf(store.roles, c.id).roles.some((r) => r.role === role) && keep(c)).map(candidate);
  } else if ("engineGap" in f.problem) {
    const nonland = d.g.cards.filter((c) => !c.isLand).map((c) => ctx.nameIdx.get(c.name)!);
    const payoffs = payoffsOf(idx, nonland);
    const want = f.problem.engineGap.trim().toLowerCase();
    const hooks = [...payoffs.keys()].sort(byteOrder);
    const hook = hooks.find((h) => hookPhrase(h).toLowerCase() === want);
    if (hook === undefined) {
      const known = hooks.map((h) => ({ words: hookPhrase(h), n: payoffs.get(h)!.size })).sort((a, b) => b.n - a.n || byteOrder(a.words, b.words));
      throw new ToolInputError(`no deck card pays off on "${f.problem.engineGap}"; what this deck's payoffs wait on: ${known.map((k) => `${k.words} (${k.n})`).join("; ") || "nothing"}`);
    }
    const feeders = outsideFeeders(idx, ctx, hook, payoffs.get(hook)!, (i) => {
      const c = store.space.cards.get(idx.cards[i].oracleId);
      return !!c && eligible(c, true);
    });
    problem = { kind: "engine gap", mechanic: hookPhrase(hook), payoffs: [...payoffs.get(hook)!].map((i) => idx.cards[i].name).sort(byteOrder) };
    pool = [...feeders].map(([i, fd]) => ({ c: store.space.cards.get(idx.cards[i].oracleId)!, fd }))
      .sort((a, b) => byteOrder(a.c.name, b.c.name))
      .filter(({ c }) => keep(c)).map(({ c, fd }) => ({ ...candidate(c), feeds: fd }));
  } else {
    problem = { kind: "off plan" };
    pool = all().filter((c) => eligible(c, false) && fit(c.id).score > 0 && keep(c)).map(candidate);
  }
  if (idleDiscounts) notes.push(`${idleDiscounts} cost reducer${idleDiscounts === 1 ? "" : "s"} left out: ${idleDiscounts === 1 ? "it only discounts" : "they only discount"} spells of a color or type the deck does not cast`);
  if (avoided) notes.push(`${avoided} card${avoided === 1 ? "" : "s"} left out: ${avoided === 1 ? "it fits" : "they fit"} a theme the plan avoids and not the plan`);

  // Links into the deck, the named cards it lacks counted as deck cards, and which of those cards carry the plan.
  const absentPos = absentNamed.map((c) => graph.positionOf.get(idOf.get(c.id)!)).filter((p): p is number => p !== undefined);
  const into = linksIntoDeck(store, new Set([...ctx.members, ...absentPos]));
  const linksOf = (c: Candidate): Link[] => (c.pos === undefined ? [] : into(c.pos));
  const absentGraphNames = absentPos.map((p) => idx.cards[p].name);
  const onPlanDeck = new Set([...d.g.cards.filter((c) => c.name === idx.cards[d.commanderPos].name || fit(c.oracleId).score > 0).map((c) => c.name), ...absentGraphNames]);
  // the plan's priority cards, in the deck or named and lacking, by the index's spelling
  const priorityDeck = new Set([...resolved.priorities.map((n) => graph.positionOf.get(store.names.find((x) => x.name === n)!.id))
    .filter((p): p is number => p !== undefined && ctx.members.has(p)).map((p) => idx.cards[p].name), ...absentGraphNames]);
  const partners = new Map<number, { all: number; plan: number; priority: string[] }>();
  const partnersOf = (c: Candidate) => {
    let p = partners.get(c.id);
    if (!p) {
      const name = c.pos === undefined ? "" : idx.cards[c.pos].name;
      const others = new Set(linksOf(c).filter(ctx.counts).map((l) => (l.from === name ? l.to : l.from)));
      p = { all: others.size, plan: [...others].filter((n) => onPlanDeck.has(n)).length, priority: [...others].filter((n) => priorityDeck.has(n)).sort(byteOrder) };
      partners.set(c.id, p);
    }
    return p;
  };

  // The four rankings.
  const { synergy, deckVector, notes: pageNotes } = commanderSignals(store, commanderId);
  notes.push(...pageNotes);
  const { edhrecRank } = storeFacts(store);
  const tagger = new Map(pool.map((c) => [c.id, taggerFit(store, deckVector, c.id)]));
  const byName = (a: Candidate, b: Candidate) => byteOrder(a.card.name, b.card.name);
  const bySynergy = pool.filter((c) => synergy.has(c.id)).sort((a, b) => synergy.get(b.id)! - synergy.get(a.id)! || byName(a, b));
  const byTagger = pool.filter((c) => tagger.get(c.id)! > 0).sort((a, b) => tagger.get(b.id)! - tagger.get(a.id)! || byName(a, b));
  const byRank = pool.filter((c) => edhrecRank.has(c.id)).sort((a, b) => edhrecRank.get(a.id)! - edhrecRank.get(b.id)! || byName(a, b));
  const again = (c: Candidate) => (c.feeds?.repeatable ? 0 : 1);
  const byEngine = pool.filter((c) => partnersOf(c).all > 0).sort((a, b) =>
    (b.feeds?.feeds.size ?? 0) - (a.feeds?.feeds.size ?? 0) || again(a) - again(b) ||
    partnersOf(b).plan - partnersOf(a).plan || partnersOf(b).all - partnersOf(a).all || b.fit.score - a.fit.score || byName(a, b));

  // Cards linked to the plan's priority cards in the deck: most priority cards linked, then the engine order's measures.
  const byPriority = priorityDeck.size ? pool.filter((c) => partnersOf(c).priority.length > 0).sort((a, b) =>
    partnersOf(b).priority.length - partnersOf(a).priority.length || partnersOf(b).plan - partnersOf(a).plan ||
    partnersOf(b).all - partnersOf(a).all || b.fit.score - a.fit.score || byName(a, b)) : [];

  // A theme the player named, beside priority cards, keeps THEME_SLOTS picks of its own (ISC-90): the pool by fit to the
  // named themes alone (not the priority cards' profile), then the engine order's measures. An inferred theme keeps none.
  const themeOwn = resolved.inference === null && resolved.themes.length > 0 && resolved.priorities.length > 0
    ? planScorer(store, { ...resolved, cards: null, inference: null }) : null;
  const byTheme = themeOwn ? pool.filter((c) => themeOwn(c.card.id).score > 0).sort((a, b) =>
    themeOwn(b.card.id).score - themeOwn(a.card.id).score || partnersOf(b).plan - partnersOf(a).plan || partnersOf(b).all - partnersOf(a).all || byName(a, b)) : [];

  // The shortlist, in order, never past SHORTLIST_MAX: the named cards the deck lacks; commander synergy and Tagger Deck
  // fit whole; the named theme's picks; at most POPULAR_ONLY cards popularity alone wants; then cards linked to a
  // priority card, then the other engine partners.
  const chosen = new Map<number, Candidate>();
  const add = (c: Candidate) => { if (chosen.size < SHORTLIST_MAX && !chosen.has(c.id)) { chosen.set(c.id, c); return true; } return false; };
  const viaNamed = new Set<number>();
  for (const c of absentNamed) {
    const over = f.maxManaValue !== undefined && c.meta!.cmc > f.maxManaValue ? "mana value" : f.maxPrice !== undefined && !(c.meta!.usd !== null && c.meta!.usd <= f.maxPrice) ? "price" : null;
    if (over) { notes.push(`${c.name}, named in the plan and not in the deck, is over the ${over} ceiling, so it is left out`); continue; }
    const cand = pool.find((x) => x.card.id === c.id) ?? candidate(c);
    if (add(cand)) viaNamed.add(cand.id);
  }
  for (const list of [bySynergy, byTagger]) for (const c of list.slice(0, PER_SOURCE)) add(c);
  const viaTheme = new Set<number>();
  let themeTaken = 0;
  for (const c of byTheme) { if (themeTaken >= THEME_SLOTS || chosen.size >= SHORTLIST_MAX) break; viaTheme.add(c.id); if (add(c)) themeTaken++; }
  let popularOnly = 0;
  for (const c of byRank.slice(0, PER_SOURCE)) if (!chosen.has(c.id) && popularOnly < POPULAR_ONLY && add(c)) popularOnly++;
  const viaEngine = new Set(byEngine.slice(0, PER_SOURCE).map((c) => c.id));
  for (const list of [byPriority, byEngine]) for (const c of list) if (add(c)) viaEngine.add(c.id);
  const taken: Record<SourceLabel, Set<number>> = {
    "named by the player": viaNamed,
    "fits this commander": new Set(bySynergy.slice(0, PER_SOURCE).map((c) => c.id)),
    "deeper cut": new Set(byTagger.slice(0, PER_SOURCE).map((c) => c.id)),
    "widely played": new Set(byRank.slice(0, PER_SOURCE).map((c) => c.id)),
    "fits the named theme": viaTheme,
    "engine partner": viaEngine,
  };
  if (bySynergy.length < PER_SOURCE && synergy.size) notes.push(`the commander's page lists ${bySynergy.length} card${bySynergy.length === 1 ? "" : "s"} for this problem`);

  // Each card with its labels, links and the deck after it.
  const before = swapStats(deckNumbers(store, commander, entries, planCtx));
  const outFit = out ? fit(out.card.id).score : 0;
  const round = (x: number) => Math.round(x * 1e4) / 1e4;
  const cards: ShortlistCard[] = [...chosen.values()].map((c) => {
    const labels = SHORTLIST_LABELS.filter((l) => taken[l].has(c.id));
    const name = c.pos === undefined ? c.card.name : idx.cards[c.pos].name;
    const all = deckLinks(ctx, name, linksOf(c).filter((l) => !offProfile(l.hook)));
    const genericLinks = all.filter((l) => l.generic).length;
    const byEvent = new Map<string, ShortlistLink>();
    for (const l of all) {
      if (l.generic) continue;
      const row = byEvent.get(l.on) ?? byEvent.set(l.on, { on: l.on, feeds: [], fedBy: [] }).get(l.on)!;
      (l.direction === "feeds" ? row.feeds : row.fedBy).push(l.card); // deckLinks sorts by card, so each list is in byte order
    }
    const links = [...byEvent.values()].sort((a, b) => byteOrder(a.on, b.on));
    const after = swapStats(deckNumbers(store, commander, applySwap(entries, out?.card ?? null, c.card), planCtx));
    const p = partnersOf(c);
    return {
      name: c.card.name, manaValue: c.card.meta!.cmc, usd: c.card.meta!.usd, typeLine: c.card.meta!.type,
      roles: rolesOf(store.roles, c.card.id).roles.map((r) => r.role),
      labels,
      evidence: {
        commanderSynergy: synergy.has(c.id) ? round(synergy.get(c.id)!) : null,
        taggerFit: tagger.get(c.id)! > 0 ? round(tagger.get(c.id)!) : null,
        edhrecRank: edhrecRank.get(c.id) ?? null,
        partners: p.all, planPartners: p.plan, priorityLinks: p.priority, planFit: c.fit,
        ...(c.feeds ? { feeds: [...c.feeds.feeds].sort(byteOrder) } : {}),
      },
      links, genericLinks,
      ...(links.length ? {} : {
        noLinks: c.pos === undefined ? "the card graph cannot read this card, so its links are unknown"
          : genericLinks ? "only generic links: it is cast or enters into deck cards that any card would feed" : "links to no card in the deck",
      }),
      ...(out ? { after } : {}), delta: statsDelta(before, after),
      planGain: Math.round((c.fit.score - outFit) * 1000) / 1000,
    };
  }).sort((a, b) => b.labels.length - a.labels.length || b.evidence.planFit.score - a.evidence.planFit.score || byteOrder(a.name, b.name));

  return {
    commander: { name: commander.name, colorIdentity: commander.ci.join("") },
    plan: planEcho(resolved),
    problem,
    ceilings: { maxManaValue: f.maxManaValue ?? null, maxPrice: f.maxPrice ?? null },
    out: out && { name: out.card.name, manaValue: out.card.meta!.cmc, usd: out.card.meta!.usd, planFit: outFit },
    pool: pool.length,
    before,
    cards,
    notes,
    unresolved: unresolvedLines(store, deck.unresolved),
  };
}

/** The cast facts of cards (types, colors, subtypes, supertypes, lower case), from the store's plain columns; a card's
 * colors are Scryfall's, or its front face's cost symbols for a card with faces. */
function castFacts(store: Store, cards: SpaceCard[]): CastFacts[] {
  const q = store.db.query("SELECT c.types, c.subtypes, c.supertypes, c.mana_cost, s.colors FROM cards c LEFT JOIN card_scryfall s ON s.card_id = c.id WHERE c.oracle_id = ?");
  const words = (x: string) => new Set(x.toLowerCase().split(/\s+/).filter(Boolean));
  const COLOR: Record<string, string> = { W: "white", U: "blue", B: "black", R: "red", G: "green" };
  return [...new Map(cards.map((c) => [c.id, c])).values()].map((c) => {
    const r = q.get(c.id) as { types: string; subtypes: string; supertypes: string; mana_cost: string; colors: string | null };
    const letters: string[] = r.colors !== null ? JSON.parse(r.colors) : [...new Set(r.mana_cost.match(/[WUBRG]/g) ?? [])];
    return { types: words(r.types), subtypes: words(r.subtypes), supertypes: words(r.supertypes), colors: new Set(letters.map((l) => COLOR[l])) };
  });
}

/** The deck card to swap out: an exact or front-face name of a card in the list. */
function outCard(store: Store, name: string, entries: DeckEntry[]): { card: SpaceCard } {
  const r = resolveCard(store, name);
  const hit = store.space.cards.get(store.names[r.id - 1].oracleId)!;
  if (r.matchedBy !== "exact" && r.matchedBy !== "face") throw new ToolInputError(`out card "${name}" is not an exact card name; candidates: ${[hit.name, ...r.alternatives].join("; ")}`);
  if (!entries.some((e) => e.card?.id === hit.id)) throw new ToolInputError(`${hit.name} is not in the deck, so it cannot be swapped out`);
  return { card: hit };
}

