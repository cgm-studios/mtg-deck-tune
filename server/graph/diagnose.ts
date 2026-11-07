// Deck diagnosis, ported from mtg-graph-api src/diagnose.ts (branch rework/ts-card-graph; its ISA F6, ISC-24, 25, 53 to
// 61 there): what a decklist's engine is short of, what it has too much of, and which cards do the least for it. The
// graph gives the engine (who feeds whom); the Tagger roles give the jobs every deck needs. The rules are the graph
// repo's, each one its ISA Decisions 2026-11-07 (deck diagnosis) call. What changed in the port: role targets are passed
// in (the diagnose tool, ../diagnose.ts, shapes them from the player's plan); the adds for a short role and the
// leave-one-out comparison of add rankings are left to the shortlist; names sort by byte order, not localeCompare (the
// tools answer the same on every machine); card names resolve through the store's index.
import type { DeckGraph } from "./deck";
import type { Selector } from "./grammar";
import type { InteractionIndex, Link, Listen } from "./interact";
import map from "./mapping/forge-map.json";
import { byteOrder, offProfile } from "./profile";

/** A listen fed by the turn itself, not by another card: the steps and phases, and combat. */
const GAME_FED = new Set<string>([
  ...Object.values((map as { phases: Record<string, string> }).phases),
  "Attacks", "AttackersDeclared", "BlockersDeclared", "Blocks", "BecomesBlocked", "CombatDamage", "Damage", "ExcessDamage", "CumulativeUpkeep",
]);
/** A card that accepts at least this share of the pool just for being cast or entering is not picky (graph ISA Decisions 2026-11-07, as in its rank.ts). */
const BROAD = 1 / 3;

/** A role target table and a name for where it came from. */
export interface RoleTargets { targets: Record<string, number>; source: string }

export interface Starved {
  hook: string;
  /** Deck cards that pay off on the hook. */
  payoffs: string[];
  /** Deck cards that make it happen for at least one payoff. */
  enablers: string[];
  /** payoffs:enablers, e.g. "16:4". */
  ratio: string;
  /** In-color cards outside the deck that would feed at least two of the payoffs, most payoffs fed first. */
  candidates: { name: string; feeds: string[]; /** Makes it happen from an ability you can use again, not a one-shot spell. */ repeatable: boolean }[];
}

/** commander; core (well linked, has a role); engine (well linked, no role); utility (loosely linked, but a role or mana);
 * starved (loosely linked because it pays off on a starved hook); unread (works through a static effect the graph does not
 * link); cut (loosely linked, roleless, none of the above); unjudged (loosely linked, and no role data to tell). */
export type Bucket = "commander" | "core" | "engine" | "utility" | "starved" | "cut" | "unread" | "unjudged";

export interface EngineCard {
  name: string;
  /** Distinct deck cards this card links to over non-generic links, either direction. */
  partners: number;
  /** Every link in or out, generic ones included: the deck graph's degree. */
  degree: number;
  roles: string[];
  bucket: Bucket;
  reason?: string;
}

export interface RoleCheck {
  role: string;
  count: number;
  target: number;
  /** Over: the role's own cards, fewest partners first. */
  trims?: { name: string; partners: number }[];
}

/** Every hook some deck card pays off on, with the deck cards that feed it. Starved hooks are the subset with at least two
 * payoffs and more payoffs than enablers. */
export interface Mechanic { hook: string; payoffs: string[]; enablers: string[] }

export interface Diagnosis {
  commanders: string[];
  colorIdentity: string[];
  mechanics: Mechanic[];
  starved: Starved[];
  engine: EngineCard[];
  /** The lower quartile of partners among nonland, non-commander cards. At or below it is "low". */
  lowPartners: number;
  roles?: { source: string; over: RoleCheck[]; under: RoleCheck[] };
}

export interface DiagnoseOptions {
  /** Role targets; without them (or without role data on the deck graph) the role section is left out. */
  targets?: RoleTargets;
  /** How many outside enablers to list per starved hook (default 10). */
  top?: number;
}

const selfOnly = (l: Listen) => l.sel.any.length > 0 && l.sel.any.every((a) => a.self);
const selfOnlySel = (s: Selector) => s.any.length > 0 && s.any.every((a) => a.self);
const opponentOnly = (l: Listen) => l.sel.any.length > 0 && l.sel.any.every((a) => a.controller === "opponent" || a.player === "Opponent");
/** Events only the player named can make happen: an opponent casting, drawing or playing a land. */
const ACTOR_HOOKS = new Set(["SpellCast", "CardDrawn", "LandPlayed"]);
/** An opponent-only listen is a payoff the deck feeds only when it watches an opponent as a player (Mindcrank: an opponent
 * losing life, which your drains cause). One watching an opponent's cards (Yahenni: an opponent's creature dying) is fed by
 * removal, which is never counted as the deck's engine (makesOwn), so it would always read as starved. */
const opponentFed = (l: Listen) => opponentOnly(l) && (ACTOR_HOOKS.has(l.hook) || l.sel.any.some((a) => a.player === undefined));
/** Costs no deck card feeds in a way worth counting: a {T} cost is refilled by the untap step, and paying life is not
 * built up by gaining it (Toxic Deluge is not a lifegain payoff). */
const UNFED_COSTS = new Set(["Tap", "LifeLoss"]);

/** A listen that makes its card a payoff another deck card has to feed. */
function isPayoff(l: Listen): boolean {
  return !offProfile(l.hook) && !GAME_FED.has(l.hook) && !UNFED_COSTS.has(l.consumed ?? "") && !selfOnly(l) && !opponentFed(l);
}

const MANA_HOOKS = new Set(["ManaAdded", "ManaPaid", "Tap"]);
/** Ability kinds that can fire again: you activate it, or it applies, whenever you like. Spells, keywords (Exploit,
 * Bargain), chapters and mana abilities happen once or are not an outlet. Triggered abilities depend on the trigger. */
const AGAIN = new Set(["activated", "mana", "static", "replacement"]);
/** A trigger on the card itself doing one of these happens once per time it is played (Fleshbag Marauder entering, Yukora
 * leaving); a trigger on the card attacking or on anything else can repeat. */
const ONCE_SELF = new Set(["ETB", "SpellCast", "LTB", "Dies"]);

/** Card `i` makes `hook` happen to your own cards: a cost it pays, its own casting or entering, or an effect aimed at
 * your cards or a player. "Destroy target creature" is aimed at an opponent's, so removal is not a sacrifice outlet (the
 * profile's rule). `repeatable` when it can do so again and again: an activated, static or replacement ability, or a
 * trigger on something other than the card itself being cast or entering (Braids at each upkeep yes, Fleshbag Marauder
 * entering no), and never when it only sacrifices itself. */
function makesOwn(idx: InteractionIndex, i: number, hook: string): { own: boolean; repeatable: boolean } {
  let own = false, repeatable = false;
  const abilities = idx.cards[i].graph.abilities;
  for (const e of idx.emitsOf(i)) {
    if (e.hook !== hook) continue;
    const ok = e.by !== "effect" || e.sel.any.some((a) => a.self || a.player !== undefined || a.controller === "you" || a.props.includes("EquippedBy") || (hook === "ETB" && a.controller === "any"));
    if (!ok) continue;
    own = true;
    if (e.ability === undefined || selfOnlySel(e.sel)) continue;
    const ab = abilities[e.ability];
    if (!ab) continue;
    if (AGAIN.has(ab.kind)) repeatable = true;
    else if (ab.kind === "triggered") {
      const once = ab.relations.some((r) => r.relation === "triggers_on" && ONCE_SELF.has(r.hook) && selfOnlySel(r.selector));
      if (!once) repeatable = true;
    }
  }
  return { own, repeatable };
}

/** Card `i` has a static effect on other cards, keyword grants included (Fervor's haste, Mass Hysteria, a lord): the
 * graph links none of them yet (ISA Out of Scope, known gap). */
export function worksThroughStatic(idx: InteractionIndex, i: number): boolean {
  return idx.cards[i].graph.abilities.some((a) => a.relations.some((r) => r.relation === "modifies" && !selfOnlySel(r.selector)));
}

/** Every hook the given cards pay off on, with the cards that pay off on it (index positions). */
export function payoffsOf(idx: InteractionIndex, cards: Iterable<number>): Map<string, Set<number>> {
  const payoffs = new Map<string, Set<number>>();
  for (const i of cards) for (const l of idx.listensOf(i)) if (isPayoff(l)) (payoffs.get(l.hook) ?? payoffs.set(l.hook, new Set()).get(l.hook)!).add(i);
  return payoffs;
}

/** Cards outside the deck that make `hook` happen to your own cards for at least one of `payoffs` (deck cards paying off
 * on it), over links that are not generic, each with the payoffs it feeds and whether it can do so again and again
 * (makesOwn). Only cards `eligible` accepts are read. The engine gap's outlets to try (diagnose) and the shortlist's
 * engine partners for a gap both read this. */
export function outsideFeeders(idx: InteractionIndex, ctx: DeckContext, hook: string, payoffs: Iterable<number>, eligible: (i: number) => boolean): Map<number, { feeds: Set<string>; repeatable: boolean }> {
  const feeds = new Map<number, { feeds: Set<string>; repeatable: boolean }>();
  const ok = new Map<number, boolean>();
  for (const pi of payoffs) for (const l of idx.linksTo(pi)) {
    if (l.hook !== hook || ctx.generic(l)) continue;
    const from = idx.indexOf(l.from);
    if (ctx.members.has(from)) continue;
    let pass = ok.get(from);
    if (pass === undefined) ok.set(from, (pass = eligible(from) && makesOwn(idx, from, hook).own));
    if (!pass) continue;
    let f = feeds.get(from);
    if (!f) feeds.set(from, (f = { feeds: new Set(), repeatable: makesOwn(idx, from, hook).repeatable }));
    f.feeds.add(idx.cards[pi].name);
  }
  return feeds;
}

/** Which deck links count toward engine partners, and which are generic, for one deck. */
export interface DeckContext {
  members: Set<number>;
  nameIdx: Map<string, number>;
  /** A link a card makes just for being cast or entering, into a card that accepts at least a third of the pool that way. */
  generic: (l: Link) => boolean;
  /** A link that counts toward engine partners: not a mana or keyword hook, not generic. */
  counts: (l: Link) => boolean;
}

// Which of a card's (hook, cost) pairs accept a third of the pool just for being cast or entering, pooling the card's
// listens on the same pair as the graph's ranking does (a two-color "red or white spell" trigger is two listens). It
// depends on the index alone, never on a deck, so it is worked out once per card and pair for the index's lifetime.
const BROAD_MEMO = new WeakMap<InteractionIndex, Map<number, Map<string, boolean>>>();

function isBroad(idx: InteractionIndex, i: number, key: string): boolean {
  let byCard = BROAD_MEMO.get(idx);
  if (!byCard) BROAD_MEMO.set(idx, (byCard = new Map()));
  let keys = byCard.get(i);
  if (!keys) byCard.set(i, (keys = new Map()));
  let broad = keys.get(key);
  if (broad === undefined) {
    const ls = idx.listensOf(i).filter((l) => `${l.hook}|${l.consumed ?? ""}` === key);
    let n: number;
    if (ls.length === 1) n = idx.castFeederCount(ls[0]);
    else {
      const from = new Set<number>();
      for (const l of ls) for (const f of idx.castFeeders(l)) from.add(f);
      n = from.size;
    }
    keys.set(key, (broad = n / idx.cards.length >= BROAD));
  }
  return broad;
}

export function deckContext(idx: InteractionIndex, g: DeckGraph): DeckContext {
  const members = new Set(g.cards.map((c) => idx.indexOf(c.name)));
  const nameIdx = new Map([...members].map((i) => [idx.cards[i].name, i]));
  const byName = (name: string) => nameIdx.get(name) ?? idx.indexOf(name);
  const generic = (l: Link) => l.emittedBy === "card" && isBroad(idx, byName(l.to), `${l.hook}|${l.consumed ?? ""}`);
  const counts = (l: Link) => !offProfile(l.hook) && !generic(l);
  return { members, nameIdx, generic, counts };
}

export function diagnose(idx: InteractionIndex, g: DeckGraph, opts: DiagnoseOptions = {}, ctx: DeckContext = deckContext(idx, g)): Diagnosis {
  const top = opts.top ?? 10;
  const { members, nameIdx, counts } = ctx;
  const commanders = new Set(g.commanders);
  const ci = new Set(commanders.size
    ? g.commanders.flatMap((c) => idx.cards[nameIdx.get(c)!].colorIdentity)
    : [...members].flatMap((i) => idx.cards[i].colorIdentity));
  const inColor = (i: number) => idx.cards[i].colorIdentity.every((x) => ci.has(x));

  // Engine partners.
  const partners = new Map<string, Set<string>>();
  for (const l of g.links) if (counts(l)) for (const [a, b] of [[l.from, l.to], [l.to, l.from]]) (partners.get(a) ?? partners.set(a, new Set()).get(a)!).add(b);
  const p = (name: string) => partners.get(name)?.size ?? 0;

  const nonland = g.cards.filter((c) => !c.isLand);
  const ranked = nonland.filter((c) => !commanders.has(c.name)).map((c) => p(c.name)).sort((a, b) => a - b);
  const lowPartners = ranked.length ? ranked[Math.floor((ranked.length - 1) / 4)] : 0;
  /** Without role data a roleless card cannot be told from a role card, so nothing is named a cut. */
  const rolesKnown = !!g.roles;
  const manaOnly = (i: number) => { const rels = idx.cards[i].graph.abilities.flatMap((a) => a.relations); return rels.length > 0 && rels.every((r) => MANA_HOOKS.has(r.hook)); };
  const ownMemo = new Map<string, { own: boolean; repeatable: boolean }>();
  const own = (i: number, hook: string) => { const k = `${i}|${hook}`; let v = ownMemo.get(k); if (!v) { v = makesOwn(idx, i, hook); ownMemo.set(k, v); } return v; };

  // Starved hooks and their enablers from outside the deck.
  const payoffs = payoffsOf(idx, nonland.map((c) => nameIdx.get(c.name)!));
  const enablers = new Map<string, Set<string>>();
  for (const l of g.links) {
    const to = nameIdx.get(l.to);
    if (to === undefined || !payoffs.get(l.hook)?.has(to) || !own(nameIdx.get(l.from)!, l.hook).own) continue;
    (enablers.get(l.hook) ?? enablers.set(l.hook, new Set()).get(l.hook)!).add(l.from);
  }
  const names = (s: Iterable<string>) => [...s].sort(byteOrder);
  const mechanics: Mechanic[] = [...payoffs].map(([hook, ps]) => ({ hook, payoffs: names([...ps].map((i) => idx.cards[i].name)), enablers: names(enablers.get(hook) ?? []) }))
    .sort((a, b) => b.payoffs.length - a.payoffs.length || byteOrder(a.hook, b.hook));
  const starved: Starved[] = [];
  for (const [hook, ps] of payoffs) {
    const es = enablers.get(hook) ?? new Set();
    if (ps.size < 2 || ps.size <= es.size) continue;
    const feeds = outsideFeeders(idx, ctx, hook, ps, inColor);
    // Most payoffs fed, then repeatable (an outlet you can use every turn) before one-shot, then EDHREC rank.
    const rep = (i: number) => (feeds.get(i)!.repeatable ? 0 : 1);
    const candidates = [...feeds].filter(([, f]) => f.feeds.size >= 2)
      .sort(([a, x], [b, y]) => y.feeds.size - x.feeds.size || rep(a) - rep(b) || (idx.cards[a].edhrecRank ?? Infinity) - (idx.cards[b].edhrecRank ?? Infinity) || byteOrder(idx.cards[a].name, idx.cards[b].name))
      .slice(0, top).map(([i, f]) => ({ name: idx.cards[i].name, feeds: names(f.feeds), repeatable: f.repeatable }));
    starved.push({ hook, payoffs: names([...ps].map((i) => idx.cards[i].name)), enablers: names(es), ratio: `${ps.size}:${es.size}`, candidates });
  }
  starved.sort((a, b) => b.payoffs.length / Math.max(1, b.enablers.length) - a.payoffs.length / Math.max(1, a.enablers.length) || byteOrder(a.hook, b.hook));
  /** The starved hook a deck card pays off on, if any. */
  const starvedOf = new Map<string, Starved>();
  for (const s of starved) for (const name of s.payoffs) if (!starvedOf.has(name)) starvedOf.set(name, s);

  const engine: EngineCard[] = nonland.map((c) => {
    const i = nameIdx.get(c.name)!;
    const roles = (c.roles ?? []).map((r) => r.role);
    const base = { name: c.name, partners: p(c.name), degree: c.degree, roles };
    if (commanders.has(c.name)) return { ...base, bucket: "commander" as const };
    const low = base.partners <= lowPartners;
    if (!low) return { ...base, bucket: roles.length ? "core" as const : "engine" as const };
    if (roles.length) return { ...base, bucket: "utility" as const, reason: `fills ${roles.join(" and ")}, so few links is fine` };
    if (manaOnly(i)) return { ...base, bucket: "utility" as const, reason: "only makes mana: a ramp slot, not a plan card" };
    if (worksThroughStatic(idx, i)) return { ...base, bucket: "unread" as const, reason: "works through a static effect (a lord, an anthem, a cost or trigger change) the graph does not link yet" };
    // A payoff of a starved hook is loosely linked because the deck feeds it too little: the gap is the problem, not the card.
    const s = starvedOf.get(c.name);
    if (s) return { ...base, bucket: "starved" as const, reason: `waits on ${hookPhrase(s.hook)}, which only ${s.enablers.length} card${s.enablers.length === 1 ? "" : "s"} in the deck make happen` };
    if (!rolesKnown) return { ...base, bucket: "unjudged" as const, reason: "loosely linked, but there is no role data, so it may fill a role this run cannot see" };
    const why = base.partners === 0 && c.degree > 0
      ? `its ${c.degree} links all come from cards that care about any spell or any creature, so any card would make them`
      : `links to ${base.partners} card${base.partners === 1 ? "" : "s"} in the deck, in the bottom quarter (${lowPartners} or fewer)`;
    return { ...base, bucket: "cut" as const, reason: `${why}, and it fills none of the roles` };
  }).sort((a, b) => b.partners - a.partners || byteOrder(a.name, b.name));

  // Roles against their targets, with trims for a role over its target.
  let roles: Diagnosis["roles"];
  if (g.roles && opts.targets) {
    const over: RoleCheck[] = [], under: RoleCheck[] = [];
    for (const [role, target] of Object.entries(opts.targets.targets)) {
      const count = g.roles.counts[role];
      if (count === undefined || count === target) continue;
      if (count > target) {
        const trims = engine.filter((e) => e.roles.includes(role) && e.bucket !== "commander").map((e) => ({ name: e.name, partners: e.partners }))
          .sort((a, b) => a.partners - b.partners || byteOrder(a.name, b.name));
        over.push({ role, count, target, trims });
      } else under.push({ role, count, target });
    }
    roles = { source: opts.targets.source, over, under };
  }

  return { commanders: g.commanders, colorIdentity: ["W", "U", "B", "R", "G"].filter((x) => ci.has(x)), mechanics, starved, engine, lowPartners, ...(roles ? { roles } : {}) };
}

/** Hooks in a player's words: what happens, as a noun phrase. */
const HOOK_WORDS: Record<string, string> = {
  Dies: "a creature dying", ETB: "something entering the battlefield", LTB: "something leaving the battlefield", SpellCast: "casting a spell",
  CardDrawn: "drawing a card", TokenCreated: "making a token", LifeGain: "gaining life", LifeLoss: "losing life", Sacrifice: "sacrificing a permanent",
  Discard: "discarding a card", PutIntoGraveyard: "a card going to the graveyard", Mill: "milling", SpellCountered: "countering a spell",
  Untap: "untapping", Tap: "tapping", CounterPlaced: "putting a counter on something", "CounterPlaced:P1P1": "putting a +1/+1 counter on something",
  CounterRemoved: "removing a counter", Exile: "exiling something", Bounce: "returning a permanent to hand", Scry: "scrying", Surveil: "surveilling",
  GainControl: "taking control of something", Destroy: "destroying something", Regrowth: "returning a card from the graveyard to hand",
};
const COUNTER_WORDS: Record<string, string> = { P1P1: "+1/+1", M1M1: "-1/-1" };
export const hookPhrase = (hook: string): string => {
  if (HOOK_WORDS[hook]) return HOOK_WORDS[hook];
  const [base, sub] = hook.split(":");
  const kind = sub ? (COUNTER_WORDS[sub] ?? sub.toLowerCase()) : "";
  if (sub && base === "CounterPlaced") return `putting a ${kind} counter on something`;
  if (sub && base === "CounterRemoved") return `removing a ${kind} counter`;
  const words = base.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return sub ? `${words} (${kind})` : words;
};
