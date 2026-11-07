// Hook profiles, ported from mtg-graph-api src/profile.ts (branch rework/ts-card-graph; its ISA F4): a plan stated as
// priority cards or as a strategy name becomes one shape, the hooks the plan makes and spends, ranked. Both intent forms
// build ProfileEntry lists and pass them through normalizeProfile, so they share one shape by construction (graph ISA
// ISC-18). Card profiles: cardProfile (graph ISA ISC-16). Strategy profiles: strategy.ts (graph ISA ISC-17). The graph's
// ranking (its src/rank.ts) is not ported; the diagnose and shortlist tools read a profile through profileMatcher and
// profileFit. What changed in the port: names sort by byte order, not localeCompare (locale collation can differ between
// machines, and the tools answer the same everywhere); Plan is declared here.

import type { Selector } from "./grammar";
import type { Emit, InteractionIndex, Listen, Me } from "./interact";

/** A card plan: the commander and its priority cards, by graph (store) card name. */
export interface Plan { commander: string; priorities: string[] }

/** Byte order of two strings (UTF-16 code units), the same on every machine. */
export const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export type Side = "makes" | "spends" | "both";

/** One hook the plan runs on. */
export interface ProfileHook {
  /** A hook name from the grammar, after closure (ETB, Dies, SpellCast, TokenCreated, CounterPlaced:P1P1…). */
  hook: string;
  /** Whether the plan makes this hook happen, cashes it in, or both. */
  side: Side;
  /** 0–1, the heaviest hook in the profile is 1. */
  weight: number;
  /** The cards that put this hook in the profile, heaviest first: plan cards for a card profile, sample cards for a strategy. */
  evidence: string[];
  /** Set when the plan spends a hook nothing in it makes ("unmade") or makes one nothing in it spends ("unspent"). */
  gap?: "unmade" | "unspent";
}

export interface HookProfile {
  source: { kind: "cards"; commander: string; priorities: string[] } | { kind: "strategy"; theme: string; commanders: number };
  /** Heaviest first. */
  hooks: ProfileHook[];
}

/** Raw evidence for one hook from one card, before normalizing. */
export interface ProfileEntry { hook: string; side: "makes" | "spends"; weight: number; card: string }

/** Merge raw entries into ranked profile hooks: sum weights per hook, merge sides, normalize to the heaviest = 1. */
export function normalizeProfile(source: HookProfile["source"], entries: ProfileEntry[], { top = 25, gaps = true } = {}): HookProfile {
  const by = new Map<string, { makes: number; spends: number; cards: Map<string, number> }>();
  for (const e of entries) {
    if (!(e.weight > 0)) continue;
    const h = by.get(e.hook) ?? by.set(e.hook, { makes: 0, spends: 0, cards: new Map() }).get(e.hook)!;
    h[e.side] += e.weight;
    h.cards.set(e.card, (h.cards.get(e.card) ?? 0) + e.weight);
  }
  const max = Math.max(0, ...[...by.values()].map((h) => h.makes + h.spends));
  const hooks: ProfileHook[] = [...by.entries()].map(([hook, h]) => {
    const side: Side = h.makes > 0 && h.spends > 0 ? "both" : h.makes > 0 ? "makes" : "spends";
    const gap = !gaps || side === "both" ? undefined : side === "spends" ? "unmade" : "unspent";
    return {
      hook,
      side,
      weight: max ? Math.round(((h.makes + h.spends) / max) * 1000) / 1000 : 0,
      evidence: [...h.cards.entries()].sort((a, b) => b[1] - a[1] || byteOrder(a[0], b[0])).map(([c]) => c),
      ...(gap ? { gap } : {}),
    };
  });
  hooks.sort((a, b) => b.weight - a.weight || byteOrder(a.hook, b.hook));
  return { source, hooks: hooks.slice(0, top) };
}

/** Problems with a profile, empty when it is well formed (graph ISA ISC-18). */
export function validateProfile(p: HookProfile): string[] {
  const out: string[] = [];
  if (!p || typeof p !== "object") return ["not an object"];
  if (p.source?.kind !== "cards" && p.source?.kind !== "strategy") out.push("source.kind must be cards or strategy");
  if (!Array.isArray(p.hooks) || !p.hooks.length) out.push("hooks must be a non-empty array");
  for (const [i, h] of (p.hooks ?? []).entries()) {
    if (typeof h.hook !== "string" || !h.hook) out.push(`hooks[${i}].hook missing`);
    if (!["makes", "spends", "both"].includes(h.side)) out.push(`hooks[${i}].side invalid`);
    if (!(h.weight >= 0 && h.weight <= 1)) out.push(`hooks[${i}].weight outside 0–1`);
    if (!Array.isArray(h.evidence) || !h.evidence.length) out.push(`hooks[${i}].evidence empty`);
    if (i > 0 && h.weight > p.hooks[i - 1].weight) out.push(`hooks[${i}] heavier than hooks[${i - 1}]`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Card profiles (graph ISA ISC-16) and reading a profile against a card (graph ISA ISC-49).


/** Hooks a profile never carries: mana is a role the Galaxy fills (graph ISA Decisions 2026-11-06), keywords are grants, not events. */
export function offProfile(hook: string): boolean {
  return hook === "ManaAdded" || hook === "ManaPaid" || hook.startsWith("Keyword:");
}

/** A profile hook's name: the grammar hook, with "[token]" or "[nontoken]" when the plan's side of it is only tokens or only cards. */
export function profileHookKey(hook: string, token: boolean | null): string {
  return token === null || hook === "TokenCreated" ? hook : `${hook}[${token ? "token" : "nontoken"}]`;
}

/** The grammar hook and token condition in a profile hook's name. A plain hook name (a strategy profile's) has no condition. */
export function parseProfileHook(key: string): { hook: string; token: boolean | null } {
  const m = /^(.+)\[(token|nontoken)\]$/.exec(key);
  return m ? { hook: m[1], token: m[2] === "token" } : { hook: key, token: null };
}

/** A profile hook in words: "token ETB", "Dies". */
export function hookWords(key: string): string {
  const { hook, token } = parseProfileHook(key);
  return token === null ? hook : `${token ? "token" : "nontoken"} ${hook}`;
}

/** One hook a card makes or spends, from its abilities (never from just being cast or entering). */
interface Touch {
  card: number; hook: string; side: "makes" | "spends"; sel: Selector; me: Me;
  /** The grammar relation this came from ("ability.relation"): one relation is one fact about the card. */
  source: string;
  /** On the makes side: the emit. */
  emit?: Emit;
  /** On the spends side: what the card waits on for it (a cost's supply listens: ETB for a Sacrifice cost). */
  listens?: Listen[];
}

/**
 * What a card's abilities make and spend, the same meaning strategy.ts uses (graph ISA ISC-18). Makes: every hook it emits,
 * after closure (a paid cost included: an outlet makes Sacrifice and Dies). Spends: the hooks it triggers on or replaces,
 * and the cost a consumes pays (an outlet spends Sacrifice, not the ETB that feeds it). A card's own casting and entering
 * are left out: every card does that, so it says nothing about a plan (graph ISA Decisions 2026-11-07). Mana and keyword hooks
 * are left out.
 */
function touches(idx: InteractionIndex, i: number): Touch[] {
  const me = idx.cards[i];
  const src = (x: Emit | Listen) => ({ source: `${x.ability}.${x.relation}` });
  const out: Touch[] = [];
  for (const e of idx.emitsOf(i)) if (e.by !== "card" && !offProfile(e.hook)) out.push({ card: i, hook: e.hook, side: "makes", sel: e.sel, me, ...src(e), emit: e });
  const costs = new Map<string, Touch>();
  for (const l of idx.listensOf(i)) {
    if (l.listener !== "consumes") { if (!offProfile(l.hook)) out.push({ card: i, hook: l.hook, side: "spends", sel: l.sel, me, ...src(l), listens: [l] }); continue; }
    const hook = l.consumed ?? l.hook;
    if (offProfile(hook)) continue;
    const k = `${hook}|${l.sel.raw}`;
    const t = costs.get(k);
    if (t) t.listens!.push(l);
    else { const n: Touch = { card: i, hook, side: "spends", sel: l.sel, me, ...src(l), listens: [l] }; costs.set(k, n); out.push(n); }
  }
  return out;
}

/** true when every alternative is a token, false when every one is a nontoken card (a Self side is), null otherwise. */
function tokenness(sel: Selector): boolean | null {
  if (!sel.any.length) return null;
  const v = sel.any.map((a) => (a.self ? false : a.token));
  return v.every((x) => x === true) ? true : v.every((x) => x === false) ? false : null;
}

/** The plan card indexes, commander first, after the same checks rank() makes. */
export function planCards(idx: InteractionIndex, plan: Plan): number[] {
  if (plan.priorities.length > 6) throw new Error(`at most 6 priority cards (got ${plan.priorities.length})`);
  const out = [plan.commander, ...plan.priorities].map((n) => idx.indexOf(n));
  if (new Set(out).size !== out.length) throw new Error("the commander and priority cards must all be different cards");
  const cmd = idx.cards[out[0]];
  for (const p of out.slice(1)) {
    const c = idx.cards[p];
    if (!c.colorIdentity.every((x) => cmd.colorIdentity.includes(x))) throw new Error(`${c.name} is outside ${cmd.name}'s color identity`);
  }
  return out;
}

/**
 * A plan's hook profile (graph ISA ISC-16): the hooks its commander and priority cards make and spend, after closure
 * (TokenCreated → ETB, Sacrifice → Dies), a consumes spending the cost it pays. Each plan card touching a hook adds 1, so a hook several plan cards touch
 * outranks one only one card touches; a hook where one plan card's output is what another waits for counts double,
 * because that is the plan's engine. A hook named with [token] or [nontoken] is one the plan makes only that way
 * (Krenko makes Goblin tokens entering, so the plan's ETB reads "token ETB"). The plan cards' own casting and entering
 * are left out (incidental). Gaps: a hook the plan spends but nothing in it makes is "unmade", and the reverse "unspent".
 */
export function cardProfile(idx: InteractionIndex, plan: Plan): HookProfile {
  const planIdx = planCards(idx, plan);
  const byHook = new Map<string, Touch[]>();
  for (const p of planIdx) for (const t of touches(idx, p)) (byHook.get(t.hook) ?? byHook.set(t.hook, []).get(t.hook)!).push(t);
  const planMakes = [...byHook.values()].flat().filter((t) => t.side === "makes");
  const entries: ProfileEntry[] = [];
  for (const [hook, ts] of byHook) {
    const makers = ts.filter((t) => t.side === "makes"), spenders = ts.filter((t) => t.side === "spends");
    // The plan's engine: another plan card makes what this hook's spender waits on (Krenko's tokens entering feed
    // Ashnod's Altar's Sacrifice cost, so Sacrifice is engine; Ashnod's sacrifice feeds Skullclamp, so Dies is).
    const engine = spenders.some((s) => s.listens!.some((l) => planMakes.some((m) => m.card !== s.card && m.hook === l.hook && feeds(idx, m, s, l))));
    const deciding = (makers.length ? makers : spenders).map((t) => tokenness(t.sel));
    const token = deciding.every((x) => x === true) ? true : deciding.every((x) => x === false) ? false : null;
    const key = profileHookKey(hook, token);
    for (const card of new Set(ts.map((t) => t.card))) {
      const sides = [...new Set(ts.filter((t) => t.card === card).map((t) => t.side))];
      // The commander is in every game, so the hooks it runs on count double.
      const w = (engine ? 2 : 1) * (card === planIdx[0] ? COMMANDER_WEIGHT : 1);
      for (const side of sides) entries.push({ hook: key, side, weight: w / sides.length, card: idx.cards[card].name });
    }
  }
  const names = planIdx.map((i) => idx.cards[i].name);
  return normalizeProfile({ kind: "cards", commander: names[0], priorities: names.slice(1) }, entries);
}

/** How much more the commander's hooks count than a priority card's. */
export const COMMANDER_WEIGHT = 2;

/** The interaction rule between one plan card's output and what another waits on. */
function feeds(idx: InteractionIndex, m: Touch, s: Touch, l: Listen): boolean {
  if (l.onlyEmitted && m.emit!.emitted !== l.onlyEmitted) return false;
  return idx.selectorsMeet(m.sel, m.emit!.me ?? m.me, l.sel, s.me, m.hook);
}

/** A main hook weighs more than half the heaviest. Namor's plan makes tokens at exactly half its SpellCast weight, and
 * those tokens are its output, not what it runs on. */
export function isMainHook(h: ProfileHook): boolean {
  return h.weight > 0.5;
}

/** One main profile hook a card makes or spends. */
export interface ProfileMatch {
  /** The profile hook's name, as in the profile ("ETB[token]"). */
  hook: string;
  side: "makes" | "spends";
  weight: number;
  /** The hook's evidence cards: for a card profile, the plan cards that run on it. */
  cards: string[];
  /** The relation that matches ("ability.relation"); a card's own casting or entering is "own". Each counts once per side. */
  source: string;
  /** The card's own reading of the hook when its token condition differs from the profile's: a maker of nontoken
   * creatures entering matches the plan's token ETB, because the plan's payoffs take any creature, and reads "ETB". */
  as?: string;
}

/**
 * Reads a profile against cards (graph ISA ISC-49): which of its main hooks a card's abilities make or spend. A card matches a
 * hook when it makes or waits on that grammar hook with a selector that meets what the hook's evidence cards do on it,
 * under the hook's token condition. Works the same for a card profile and a strategy profile, since both name their
 * evidence cards. Not matches: a card's own casting or entering, abilities only about itself ("when this enters",
 * "sacrifice this"), and selectors that could be anything.
 */
export function profileMatcher(idx: InteractionIndex, profile: HookProfile): (i: number) => ProfileMatch[] {
  const main = profile.hooks.filter(isMainHook).map((h) => {
    const { hook, token } = parseProfileHook(h.hook);
    const evidence: Record<Touch["side"], { sel: Selector; me: Me }[]> = { makes: [], spends: [] };
    for (const name of h.evidence) {
      let j: number;
      try { j = idx.indexOf(name); } catch { continue; }
      for (const t of touches(idx, j)) if (t.hook === hook) evidence[t.side].push({ sel: t.sel, me: t.me });
    }
    // The token condition describes the side that set it: the plan's makers when it has any (cardProfile). A payoff
    // is held to it (Purphoros must take Krenko's tokens); a maker held to the plan's payoffs is held to what they take.
    const definer: Touch["side"] = evidence.makes.length ? "makes" : "spends";
    for (const side of ["makes", "spends"] as const) {
      if (side !== definer) continue;
      evidence[side] = evidence[side].flatMap((e) => { const sel = onSide(e.sel, token); return sel ? [{ sel, me: e.me }] : []; });
    }
    // A card that makes the hook is held to what the evidence spends on it, and a card that spends it to what the
    // evidence makes (Purphoros wants creatures entering, and Krenko's Goblin tokens are that). On a one-sided hook it is
    // held to the side there is, so a second payoff for a hook the plan only spends still counts.
    const against = (side: Touch["side"]) => {
      const otherSide = side === "makes" ? "spends" : "makes";
      const use = evidence[otherSide].length ? otherSide : side;
      return { envelope: evidence[use], qualified: use === definer };
    };
    return { key: h.hook, hook, token, weight: h.weight, cards: h.evidence, makes: against("makes"), spends: against("spends") };
  });
  return (i) => {
    const out = new Map<string, ProfileMatch>();
    for (const t of touches(idx, i)) for (const h of main) {
      if (t.hook !== h.hook) continue;
      const sel = t.side === "makes" ? yours(t.sel, t.hook) : notSelf(t.sel);
      const { envelope, qualified } = h[t.side];
      if (!sel || (qualified && !onSide(sel, h.token))) continue;
      if (envelope.length && !envelope.some((e) => idx.selectorsMeet(sel, t.me, e.sel, e.me, h.hook))) continue;
      const k = `${h.key}|${t.side}|${t.source}`;
      // Held to the side the token condition binds, the card meets it; otherwise say what the card itself makes.
      const own = qualified ? h.key : profileHookKey(h.hook, tokenness(sel));
      if (!out.has(k)) out.set(k, { hook: h.key, side: t.side, weight: h.weight, cards: h.cards, source: t.source, ...(own !== h.key ? { as: own } : {}) });
    }
    return [...out.values()];
  };
}

/**
 * How much of the profile's main hooks a card works on (graph ISA ISC-49), and the matches that count. Each relation of the card
 * counts once per side and each (hook, side) once, so one sacrifice cost is not counted again as the Dies it implies,
 * while the cost and the effect it pays for (Goblin Warrens: sacrifice Goblins, make Goblin tokens) are two facts that
 * both count. The pairing of relations to hooks is the one with the largest total. Among equal totals, the first in
 * hook-name order wins.
 */
export function profileFit(matches: ProfileMatch[]): { score: number; counted: ProfileMatch[] } {
  const order = [...matches].sort((a, b) => byteOrder(a.hook, b.hook) || byteOrder(a.side, b.side) || byteOrder(a.source, b.source));
  const slot = (m: ProfileMatch) => `${m.hook}|${m.side}`;
  const slots = [...new Set(order.map(slot))];
  const unit = (m: ProfileMatch) => `${m.source}|${m.side}`;
  const units = [...new Set(order.map(unit))].sort();
  if (slots.length > 30) throw new Error(`profileFit: ${slots.length} hook sides is more than the search handles`);
  // Best total for units[k..] given the slots already used (a bitmask over `slots`). Main hooks are few, so exact search is cheap.
  const memo = new Map<string, { total: number; picks: ProfileMatch[] }>();
  const best = (k: number, used: number): { total: number; picks: ProfileMatch[] } => {
    if (k === units.length) return { total: 0, picks: [] };
    const key = `${k}|${used}`;
    const hit = memo.get(key);
    if (hit) return hit;
    let out = best(k + 1, used);
    for (const m of order) {
      if (unit(m) !== units[k]) continue;
      const bit = 1 << slots.indexOf(slot(m));
      if (used & bit) continue;
      const rest = best(k + 1, used | bit);
      if (rest.total + m.weight > out.total + 1e-9) out = { total: rest.total + m.weight, picks: [m, ...rest.picks] };
    }
    memo.set(key, out);
    return out;
  };
  const { total, picks } = best(0, 0);
  return { score: Math.round(total * 1000) / 1000, counted: [...picks].sort((a, b) => b.weight - a.weight || byteOrder(a.hook, b.hook) || byteOrder(a.side, b.side)) };
}

/** The alternatives that can be on the hook's token side, tokenness fixed to it; null when none can. */
function onSide(sel: Selector, token: boolean | null): Selector | null {
  if (token === null || !sel.any.length) return sel;
  const any = sel.any.filter((a) => a.player !== undefined || ((a.self ? false : a.token) ?? token) === token)
    .map((a) => (a.player !== undefined || a.self ? a : { ...a, token }));
  return any.length ? { any, raw: sel.raw } : null;
}

/** The alternatives that are not the card itself; null when nothing is left or the selector could be anything. */
/** The alternatives that happen to your own cards (or name a player); null when none do. Making the plan's hook means
 * making it happen to your own cards: "destroy target creature" is aimed at an opponent's, so it does not make the plan's Dies. */
function yours(sel: Selector, hook: string): Selector | null {
  // A card your effect puts onto the battlefield enters under your control unless the effect says otherwise (CR 110.2).
  const mine = (a: Selector["any"][number]) => a.controller === "you" || a.props.includes("EquippedBy") || (hook === "ETB" && a.controller === "any");
  const any = sel.any.filter((a) => !a.self && (a.player !== undefined || mine(a)));
  return any.length ? { any, raw: sel.raw } : null;
}

function notSelf(sel: Selector): Selector | null {
  const any = sel.any.filter((a) => !a.self);
  return any.length ? { any, raw: sel.raw } : null;
}
