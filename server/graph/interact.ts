// The interaction rule, ported from mtg-graph-api src/interact.ts (branch rework/ts-card-graph; its ISA F5). Card-to-card
// links are computed here at query time, never stored. What changed in the port: the supply table is a static import
// (mapping/supply.yaml, verbatim), and CardInfo is built from a card store row (store-graph.ts) instead of a Scryfall
// oracle record, carrying the store's card id; the rule itself is unchanged.
//
// Card A feeds card B when something A makes happen is something B is waiting for:
//   - A emits a hook: every `produces` relation, and every `consumes` relation too, because a paid cost
//     is the event itself (sacrificing a creature makes it die; graph ISA Decisions 2026-11-06). Each emitted
//     hook is expanded through the closure rules (Sacrifice -> Dies -> LTB).
//   - Every card also emits what it does just by being played (graph ISA Decisions 2026-11-07): a nonland card
//     emits its own SpellCast, and a permanent card its own ETB. These are computed here, not stored as
//     relations, so a vanilla card still compiles to zero relations.
//   - B listens on a hook: `triggers_on` and `replaces` listen on their own hook; `consumes` listens on
//     whatever feeds that cost (data/ontology/supply.yaml: a sacrifice cost is fed by ETB).
//   - The two selectors overlap (same kind of card, compatible controller and token-ness). A "Self"
//     alternative is that one card: a nontoken with its own types and subtypes. So a card's "when this
//     enters" is never fed by another card's tokens, and two different cards' Self sides never meet.
import type { Closure } from "./closure";
import type { CardGraph, RelationKind, Selector, SelectorAlt } from "./grammar";
import supplyFile from "./mapping/supply.yaml";

export interface CardInfo {
  /** The card store's id for the card (cards.id): valid within one store build only. */
  id: number;
  name: string;
  oracleId: string;
  /** Front-face card types, so a "self" selector knows what the card is. */
  types: string[];
  /** Front-face subtypes (Goblin, Warrior), so a Self selector knows them too. */
  subtypes: string[];
  /** Front-face supertypes (Basic, Legendary, Snow). */
  supertypes: string[];
  /** Front-face colors (W U B R G), so color conditions can be checked against the card itself. */
  colors: string[];
  /** Colors of the mana symbols in the front face's cost (hybrid counts both), for ManaCostPartial conditions. */
  costColors: string[];
  /** Changeling: every creature type. */
  anySubtype: boolean;
  /** The faces this card can be cast or played as: one for most cards, each half of a split, adventure or modal double-faced card. */
  faces: Me[];
  colorIdentity: string[];
  edhrecRank: number | null;
  graph: CardGraph;
}

export interface Link {
  from: string;
  to: string;
  /** The hook the two cards meet on. */
  hook: string;
  /** Whether A's side came from an effect, a cost it pays, or the card itself being cast or entering. */
  emittedBy: "effect" | "cost" | "card";
  /** A's original hook before closure (Sacrifice when the link is on Dies). */
  emitted: string;
  listener: Exclude<RelationKind, "produces" | "modifies">;
  /** For a consumes link: the cost B pays (Sacrifice when the link is on ETB). */
  consumed?: string;
}

/** One hook a card makes happen, after closure. `me` is set on a card's own cast or entering: the face being played. */
export interface Emit { card: number; hook: string; emitted: string; by: Link["emittedBy"]; sel: Selector; me?: Me; /** Index into the card's graph.abilities and that ability's relations; absent on its own cast or entering. */ ability?: number; relation?: number }
/** One hook a card waits on. A consumes listen is fed by `hook` and pays `consumed`. */
export interface Listen { card: number; hook: string; listener: Link["listener"]; consumed?: string; sel: Selector; onlyEmitted?: string; /** Index into the card's graph.abilities and that ability's relations. */ ability: number; relation: number }

export type Supply = Map<string, string[]>;

/** What feeds each cost that spends something (a sacrifice cost is fed by ETB), from mapping/supply.yaml. */
export function loadSupply(): Supply {
  const y = supplyFile as { supply?: { consumes: string; fed_by: string[] }[] };
  if (!Array.isArray(y?.supply)) throw new Error("supply.yaml: missing supply list");
  return new Map(y.supply.map((s) => [s.consumes, s.fed_by]));
}

const PERMANENT_TYPES = ["Artifact", "Battle", "Creature", "Enchantment", "Land", "Planeswalker"];
const CARD_TYPES = ["Artifact", "Battle", "Creature", "Enchantment", "Instant", "Kindred", "Land", "Planeswalker", "Sorcery"];
/** Supertypes: conditions on which card it is, never a kind of card (graph ISA ISC-47). */
const SUPERTYPES = ["Basic", "Legendary", "Snow"];

/** Layouts whose every face can be cast or played. Transform, flip and meld backs are never cast. */
const ALL_FACES_CAST = new Set(["split", "adventure", "modal_dfc", "omen"]);

/** Colors of the mana symbols in a cost: {U}, {W/U} (both), {U/P}, {2/U}. */
export function costColors(cost: string | undefined): string[] {
  const out = new Set<string>();
  for (const m of (cost ?? "").matchAll(/\{([^}]+)\}/g)) for (const ch of m[1].split("/")) if (/^[WUBRG]$/.test(ch)) out.add(ch);
  return ["W", "U", "B", "R", "G"].filter((x) => out.has(x));
}

function faceOf(typeLine: string, colors: string[], cost: string | undefined, anySubtype: boolean): Me {
  const [front, sub = ""] = typeLine.split("—");
  return { types: CARD_TYPES.filter((t) => front.includes(t)), supertypes: SUPERTYPES.filter((t) => front.includes(t)), subtypes: sub.trim().split(/\s+/).filter(Boolean), colors, costColors: costColors(cost), anySubtype };
}

/** The Scryfall fields of one card the link rule reads, as the card store holds them (cards + card_scryfall). */
export interface CardFields {
  id: number;
  layout: string;
  typeLine: string;
  manaCost: string;
  keywords: string[];
  colorIdentity: string[];
  /** Scryfall's top-level colors; null for a card whose faces carry them. */
  colors: string[] | null;
  /** Each face as Scryfall gives it; null for a one-face card. */
  faces: { type_line?: string; mana_cost?: string; colors?: string[] }[] | null;
  edhrecRank: number | null;
}

/** Join one card's graph with its Scryfall fields (the graph's cardInfos, one card at a time). */
export function cardInfo(g: CardGraph, c: CardFields): CardInfo {
  const anySubtype = c.keywords.includes("Changeling");
  const sides = c.faces?.length ? c.faces : [{ type_line: c.typeLine, colors: c.colors ?? undefined, mana_cost: c.manaCost }];
  // A face without its own colors (split and adventure halves) takes them from its own mana cost.
  const faces = sides.map((f) => faceOf(f.type_line ?? "", f.colors ?? (c.faces?.length ? costColors(f.mana_cost) : c.colors ?? []), f.mana_cost, anySubtype));
  const front = faces[0];
  return {
    id: c.id,
    name: g.name,
    oracleId: g.oracleId,
    types: front.types,
    subtypes: front.subtypes,
    supertypes: front.supertypes ?? [],
    colors: front.colors ?? [],
    costColors: front.costColors ?? [],
    anySubtype,
    faces: ALL_FACES_CAST.has(c.layout) ? faces : [front],
    colorIdentity: c.colorIdentity,
    edhrecRank: c.edhrecRank,
    graph: g,
  };
}

/** Types that say nothing about which card it is. */
const GENERIC = new Set(["Card", "Permanent", "Spell"]);

/** The card a Self alternative stands for. */
export interface Me { types: string[]; subtypes: string[]; supertypes?: string[]; colors?: string[]; costColors?: string[]; anySubtype?: boolean }

/** creatureOnly: subtypes that only name creatures. landOnly: subtypes that only name lands (graph ISA ISC-52). known: every printed
 * subtype; anything else is a Forge reference word. */
export interface SubtypeFacts { creatureOnly: Set<string>; landOnly: Set<string>; known: Set<string> }
const NO_FACTS: SubtypeFacts = { creatureOnly: new Set(), landOnly: new Set(), known: new Set() };

/** What an alternative concretely says, with Self resolved to the card itself (a nontoken). */
interface Resolved { types: string[]; subtypes: string[]; supertypes: string[]; nonSupertypes: string[]; anySubtype?: boolean; excluded: string[]; me?: Me; color: ColorTest[]; controller: SelectorAlt["controller"]; token: boolean | null; self: boolean; player?: string }

type ColorTest = (me: Me) => boolean;
const COLOR: Record<string, string> = { White: "W", Blue: "U", Black: "B", Red: "R", Green: "G" };
/** Forge color properties on a selector, as tests over a card: Blue tests its colors, ManaCostPartialBlue its cost's mana symbols. */
function colorTests(props: string[]): ColorTest[] {
  const out: ColorTest[] = [];
  for (const p of props) {
    const m = /^(non)?(ManaCostPartial)?(White|Blue|Black|Red|Green|Colorless|MonoColor|Multicolor)$/.exec(p);
    if (!m) continue;
    const pick = (me: Me) => (m[2] ? me.costColors : me.colors) ?? [];
    const base: ColorTest = m[3] === "Colorless" ? (me) => pick(me).length === 0 : m[3] === "MonoColor" ? (me) => pick(me).length === 1 : m[3] === "Multicolor" ? (me) => pick(me).length > 1 : (me) => pick(me).includes(COLOR[m[3]]);
    out.push(m[1] ? (me) => !base(me) : base);
  }
  return out;
}

/** Hooks where the card itself changes hands, so "this card" may be an opponent's until the event resolves. */
const CHANGES_HANDS = new Set(["GainControl", "ExchangeControl"]);

function resolve(a: SelectorAlt, me: Me, facts: SubtypeFacts, hook?: string): Resolved {
  let types = a.types.filter((x) => !GENERIC.has(x) && !SUPERTYPES.includes(x));
  const supertypes = a.types.filter((x) => SUPERTYPES.includes(x));
  const nonSupertypes = a.props.flatMap((p) => { const m = /^non([A-Z][a-z]+)$/.exec(p); return m && SUPERTYPES.includes(m[1]) ? [m[1]] : []; });
  // Words like Enchanted, Targeted, Remembered or Any are references Forge resolves at play time, not subtypes.
  let subtypes = facts.known.size ? a.subtypes.filter((x) => facts.known.has(x)) : a.subtypes;
  let token = a.token;
  // Only lands are basic, so a selector naming just Basic means a basic land.
  if (!types.length && supertypes.includes("Basic")) types = ["Land"];
  if (a.self) { types = [...new Set([...types, ...me.types])]; subtypes = [...new Set([...subtypes, ...me.subtypes])]; token = false; }
  else if (!types.length && subtypes.some((x) => facts.creatureOnly.has(x))) types = ["Creature"];
  // Likewise land subtypes name a land: Polluted Delta's "Island or Swamp card" is a land entering, never a creature (graph ISA ISC-52).
  else if (!types.length && subtypes.length && subtypes.every((x) => facts.landOnly.has(x))) types = ["Land"];
  const excluded = a.props.flatMap((p) => { const m = /^non([A-Z][a-z]+)$/.exec(p); return m && CARD_TYPES.includes(m[1]) ? [m[1]] : []; });
  // Equipment attaches only to creatures you control.
  // "This card" is yours unless the selector says otherwise or the event is it changing hands (graph ISA ISC-48).
  const controller = a.controller === "any" && (a.props.includes("EquippedBy") || (a.self && !CHANGES_HANDS.has(hook ?? ""))) ? "you" : a.controller;
  return { types, subtypes, supertypes, nonSupertypes, ...(a.self && me.anySubtype ? { anySubtype: true } : {}), excluded, ...(a.self ? { me } : {}), color: colorTests(a.props), controller, token, self: a.self, player: a.player };
}

function playerSide(p: string | undefined): "you" | "opponent" | "any" {
  if (p === "You") return "you";
  if (p === "Opponent") return "opponent";
  return "any";
}

function overlap(a: Resolved, b: Resolved): boolean {
  // Two different cards' Self sides are two different objects.
  if (a.self && b.self) return false;
  if (a.controller !== "any" && b.controller !== "any" && a.controller !== b.controller) return false;
  if (a.token !== null && b.token !== null && a.token !== b.token) return false;
  const aPlayer = a.player !== undefined, bPlayer = b.player !== undefined;
  if (aPlayer && bPlayer) {
    const x = playerSide(a.player), y = playerSide(b.player);
    return x === "any" || y === "any" || x === y;
  }
  // A player on one side and a definite card type on the other are different things.
  if ((aPlayer && b.types.length) || (bPlayer && a.types.length)) return false;
  if (a.types.length && b.types.length && !a.types.some((t) => b.types.includes(t))) return false;
  // non<Type>: a definite card is excluded if it has any excluded type (an artifact creature is not noncreature);
  // a range of cards only if every type it allows is excluded.
  const excludes = (x: Resolved, y: Resolved) => y.excluded.length > 0 && x.types.length > 0 && (x.self ? x.types.some((t) => y.excluded.includes(t)) : x.types.every((t) => y.excluded.includes(t)));
  if (excludes(a, b) || excludes(b, a)) return false;
  if (a.subtypes.length && b.subtypes.length && !a.anySubtype && !b.anySubtype && !a.subtypes.some((x) => b.subtypes.includes(x))) return false;
  // Supertypes are known only for a card itself: a basic-land fetch cannot find Godless Shrine.
  const superOk = (me: Me, y: Resolved) => y.supertypes.every((t) => me.supertypes?.includes(t)) && !y.nonSupertypes.some((t) => me.supertypes?.includes(t));
  // Between two ranges: what one side requires, the other must not exclude (a basic land is never nonbasic).
  if (a.supertypes.some((t) => b.nonSupertypes.includes(t)) || b.supertypes.some((t) => a.nonSupertypes.includes(t))) return false;
  if (a.me && !superOk(a.me, b)) return false;
  if (b.me && !superOk(b.me, a)) return false;
  // Colors are known only for a card itself; check them against the other side's color conditions.
  if (a.me && !b.color.every((t) => t(a.me!))) return false;
  if (b.me && !a.color.every((t) => t(b.me!))) return false;
  return true;
}

/** True when some alternative of `a` can be the same thing as some alternative of `b`. An empty selector matches anything. */
export function selectorsOverlap(a: Selector, aMe: Me, b: Selector, bMe: Me, facts: SubtypeFacts = NO_FACTS, hook?: string): boolean {
  if (!a.any.length || !b.any.length) return true;
  return a.any.some((x) => b.any.some((y) => overlap(resolve(x, aMe, facts, hook), resolve(y, bMe, facts, hook))));
}

/**
 * Closure condition types for a selector, so Destroy implies Dies only when the thing can be a creature.
 * A wholly generic selector (Card, Permanent, an unresolved Forge word) may be a creature; one naming only
 * non-creature types or subtypes (Treasure, Mountain, Aura) may not.
 */
function closureTypes(sel: Selector, me: Me, facts: SubtypeFacts): string[] {
  const out = new Set<string>();
  for (const a of sel.any) {
    if (a.player) continue;
    const r = resolve(a, me, facts);
    if (!r.types.length && !r.subtypes.length && !r.excluded.includes("Creature")) out.add("creature");
    for (const x of r.types) out.add(x.toLowerCase());
  }
  return [...out];
}

export class InteractionIndex {
  readonly cards: CardInfo[];
  private emits = new Map<string, Emit[]>();
  private listens = new Map<string, Listen[]>();
  private emitsByCard: Emit[][] = [];
  private listensByCard: Listen[][] = [];
  private byName = new Map<string, number>();
  private byLower = new Map<string, number>();
  /** How many cards touch each hook, for rarity weights. */
  readonly hookCards = new Map<string, number>();

  private facts: SubtypeFacts;

  constructor(cards: CardInfo[], closure: Closure, supply: Supply, facts: SubtypeFacts = NO_FACTS) {
    this.cards = cards;
    this.facts = facts;
    cards.forEach((c, i) => {
      this.byName.set(c.name, i);
      for (const face of c.name.split(" // ")) if (!this.byName.has(face)) this.byName.set(face, i);
      for (const n of [c.name, ...c.name.split(" // ")]) if (!this.byLower.has(n.toLowerCase())) this.byLower.set(n.toLowerCase(), i);
      const emits: Emit[] = [], listens: Listen[] = [];
      const seen = new Set<string>();
      for (const [ability, ab] of c.graph.abilities.entries()) for (const [relation, r] of ab.relations.entries()) {
        if (r.relation === "produces" || r.relation === "consumes") {
          const by = r.relation === "produces" ? "effect" : "cost";
          for (const hook of closure.expand(r.hook, closureTypes(r.selector, c, facts))) emits.push({ card: i, hook, emitted: r.hook, by, sel: r.selector, ability, relation });
        }
        if (r.relation === "triggers_on" || r.relation === "replaces") listens.push({ card: i, hook: r.hook, listener: r.relation, sel: r.selector, ability, relation });
        if (r.relation === "consumes") {
          const [base, sub] = r.hook.split(":");
          for (const fed of supply.get(base) ?? []) {
            if (sub && fed === "CounterPlaced") {
              // CounterRemoved:P1P1 is fed by CounterPlaced:P1P1, and by an effect placing a counter of unnamed kind.
              listens.push({ card: i, hook: `${fed}:${sub}`, listener: "consumes", consumed: r.hook, sel: r.selector, ability, relation });
              listens.push({ card: i, hook: fed, listener: "consumes", consumed: r.hook, sel: r.selector, onlyEmitted: fed, ability, relation });
            } else listens.push({ card: i, hook: fed, listener: "consumes", consumed: r.hook, sel: r.selector, ability, relation });
          }
        }
      }
      // The card itself, once per face it can be cast or played as: a nonland face is cast, a permanent face
      // (a land included) enters. The selector is that face: Self, yours, nontoken, with the face's own types and colors.
      const self: Selector = { any: [{ types: [], subtypes: [], controller: "you", token: false, self: true, other: false, props: [] }], raw: "intrinsic" };
      for (const f of c.faces) {
        if (!f.types.length) continue;
        if (!f.types.includes("Land")) emits.push({ card: i, hook: "SpellCast", emitted: "SpellCast", by: "card", sel: self, me: f });
        if (f.types.some((t) => PERMANENT_TYPES.includes(t))) emits.push({ card: i, hook: "ETB", emitted: "ETB", by: "card", sel: self, me: f });
      }
      for (const e of emits) { (this.emits.get(e.hook) ?? this.emits.set(e.hook, []).get(e.hook)!).push(e); seen.add(e.hook); }
      for (const l of listens) { (this.listens.get(l.hook) ?? this.listens.set(l.hook, []).get(l.hook)!).push(l); seen.add(l.hook); }
      for (const h of seen) this.hookCards.set(h, (this.hookCards.get(h) ?? 0) + 1);
      this.emitsByCard.push(emits);
      this.listensByCard.push(listens);
    });
  }

  /** What card `i` makes happen, after closure, its own casting and entering included (by "card"). */
  emitsOf(i: number): readonly Emit[] { return this.emitsByCard[i]; }

  /** What card `i` waits on. */
  listensOf(i: number): readonly Listen[] { return this.listensByCard[i]; }

  /** The interaction rule's selector test, with this index's subtype facts. */
  selectorsMeet(a: Selector, aMe: Me, b: Selector, bMe: Me, hook?: string): boolean {
    return selectorsOverlap(a, aMe, b, bMe, this.facts, hook);
  }

  indexOf(name: string): number {
    const i = this.byName.get(name) ?? this.byLower.get(name.toLowerCase());
    if (i === undefined) throw new Error(`no card named ${name} in the graph`);
    return i;
  }

  private link(e: Emit, l: Listen): Link | null {
    if (e.card === l.card) return null;
    if (l.onlyEmitted && e.emitted !== l.onlyEmitted) return null;
    const a = this.cards[e.card], b = this.cards[l.card];
    if (!selectorsOverlap(e.sel, e.me ?? a, l.sel, b, this.facts, e.hook)) return null;
    return { from: a.name, to: b.name, hook: e.hook, emittedBy: e.by, emitted: e.emitted, listener: l.listener, ...(l.consumed ? { consumed: l.consumed } : {}) };
  }

  /** Everything card `i` feeds. */
  linksFrom(i: number): Link[] {
    const out: Link[] = [];
    for (const e of this.emitsByCard[i]) for (const l of this.listens.get(e.hook) ?? []) { const k = this.link(e, l); if (k) out.push(k); }
    return dedupe(out);
  }

  /** Everything that feeds card `i`. */
  linksTo(i: number): Link[] {
    const out: Link[] = [];
    for (const l of this.listensByCard[i]) for (const e of this.emits.get(l.hook) ?? []) { const k = this.link(e, l); if (k) out.push(k); }
    return dedupe(out);
  }

  // Kept as sorted card positions (4 bytes a card) rather than Sets: the shortlist asks this of thousands of cards, and
  // the sets ran to millions of entries.
  private feedersMemo = new Map<string, Int32Array>();

  /** The feeders of `l` with the listening card still in, sorted; memoized when the listen has no Self alternative. */
  private feedersOf(l: Listen): Int32Array {
    const shared = !l.sel.any.some((a) => a.self);
    const key = `${l.hook}|${l.consumed ?? ""}|${l.onlyEmitted ?? ""}|${l.sel.raw}`;
    const hit = shared ? this.feedersMemo.get(key) : undefined;
    if (hit) return hit;
    const from = new Set<number>();
    const b = this.cards[l.card];
    for (const e of this.emits.get(l.hook) ?? []) {
      if (e.by !== "card" || from.has(e.card)) continue;
      if (l.onlyEmitted && e.emitted !== l.onlyEmitted) continue;
      if (selectorsOverlap(e.sel, e.me ?? this.cards[e.card], l.sel, b, this.facts, e.hook)) from.add(e.card);
    }
    const sorted = Int32Array.from(from).sort();
    if (shared) this.feedersMemo.set(key, sorted);
    return sorted;
  }

  /** The cards that feed listen `l` just by being cast or entering, the set behind a generic link (rank.ts pools these per
   * hook and cost across a card's listens). A listen with no Self alternative depends only on its hook, cost and selector,
   * so the set is memoized across cards; the listening card is never its own feeder, as in link(). */
  castFeeders(l: Listen): ReadonlySet<number> {
    const s = new Set(this.feedersOf(l));
    s.delete(l.card);
    return s;
  }

  /** How many cards castFeeders(l) holds, without building the set. */
  castFeederCount(l: Listen): number {
    const f = this.feedersOf(l);
    let lo = 0, hi = f.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (f[mid] < l.card) lo = mid + 1; else hi = mid; }
    return f.length - (lo < f.length && f[lo] === l.card ? 1 : 0);
  }

  /** Links between card `i` and the cards in `members`, both directions. Cheaper than linksFrom plus linksTo when the
   * other side is a small set, such as a decklist, because the selector test runs only on member cards. */
  linksWith(i: number, members: ReadonlySet<number>): Link[] {
    const out: Link[] = [];
    for (const e of this.emitsByCard[i]) for (const l of this.listens.get(e.hook) ?? []) if (members.has(l.card)) { const k = this.link(e, l); if (k) out.push(k); }
    for (const l of this.listensByCard[i]) for (const e of this.emits.get(l.hook) ?? []) if (members.has(e.card)) { const k = this.link(e, l); if (k) out.push(k); }
    return dedupe(out);
  }

  /** linksWith for one fixed set of members, for many cards: the members' emits and listens are grouped by hook once, so
   * each card is tested only against member cards, not walked through every card on a hook. Same links, same order. */
  linkerFor(members: ReadonlySet<number>): (i: number) => Link[] {
    const emits = new Map<string, Emit[]>(), listens = new Map<string, Listen[]>();
    for (const [hook, es] of this.emits) { const m = es.filter((e) => members.has(e.card)); if (m.length) emits.set(hook, m); }
    for (const [hook, ls] of this.listens) { const m = ls.filter((l) => members.has(l.card)); if (m.length) listens.set(hook, m); }
    return (i) => {
      const out: Link[] = [];
      for (const e of this.emitsByCard[i]) for (const l of listens.get(e.hook) ?? []) { const k = this.link(e, l); if (k) out.push(k); }
      for (const l of this.listensByCard[i]) for (const e of emits.get(l.hook) ?? []) { const k = this.link(e, l); if (k) out.push(k); }
      return dedupe(out);
    };
  }

  /** Links where `a` feeds `b`. */
  linksBetween(a: string, b: string): Link[] {
    const name = this.cards[this.indexOf(b)].name;
    return this.linksFrom(this.indexOf(a)).filter((l) => l.to === name);
  }
}

function dedupe(links: Link[]): Link[] {
  const seen = new Set<string>();
  return links.filter((l) => {
    const k = `${l.from}|${l.to}|${l.hook}|${l.emittedBy}|${l.emitted}|${l.listener}|${l.consumed ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
