// The player's plan (DT-6.3, ISA ISC-41 to 44, 77). The plan comes from the player, never from parsing the commander's
// text: after the commander read, Claude turns the player's words ("tall stompy") into named themes, priority cards and
// themes to avoid, the player confirms it, and every later tool call carries it, so the tools stay deterministic (the
// same deck and the same plan give the same answer). This module resolves a plan, from the card store alone, into the
// profile shape the diagnose and shortlist tools score against.
//
// One shape for both intent forms (ISC-44): a PlanProfile is the card graph's hook profile (graph/profile.ts: the hooks
// the plan makes and spends, heaviest first, each with its evidence cards) plus a tag profile (the Tagger tags the plan
// leans on, heaviest first), so plans built on static effects and keywords, which the graph does not link, still read.
//   theme      hooks: graph/strategy.ts strategyProfile (ported from mtg-graph-api). tags: the share-weighted mean of
//              the theme's commanders' Tagger Deck vectors, kept where it is at least minLift times the all-commander
//              mean, scored T * ln(T / B) as the hooks are. (New here: the graph has no tag side.)
//   cards      hooks: graph/profile.ts cardProfile over the commander and the priority cards. tags: the sum of their
//              Tagger Card vectors, the commander counted double as its hooks are (COMMANDER_WEIGHT).
// Weights are 0 to 1 (the heaviest is 1), rounded to 3 places; at most 25 hooks and 25 tags.
//
// Errors are ToolInputError, so a tool returns them as tool errors the skill can act on: an unknown theme lists the
// closest known themes (UnknownThemeError, ISC-43); a known theme under the data floor says so with its commander count
// (ThinThemeError, ISC-77), the case where the skill asks the player for keystone cards instead (ISC-78).

import { z } from "zod";
import { resolveCard, resolveCommander, type Store } from "./deck-tools";
import { ToolInputError } from "./errors";
import { planShape } from "./plan-input";
import { byteOrder, cardProfile, COMMANDER_WEIGHT, hookWords, profileFit, profileMatcher, type HookProfile } from "./graph/profile";
import { graphOf, type Graph } from "./graph/store-graph";
import { STRATEGY_DEFAULTS, strategyProfile, themeCommanders } from "./graph/strategy";

export { ThinThemeError, UnknownThemeError } from "./graph/strategy";

const TOP_TAGS = 25;

export { planShape, type PlanInput } from "./plan-input";

const resolvePlanInput = z.object({
  commander: z.string().min(1),
  plan: planShape,
}).strict();
export type ResolvePlanInput = z.input<typeof resolvePlanInput>;

/** One Tagger tag the plan leans on. */
export type ProfileTag = { tag: string; weight: number };
/** The one profile shape every plan part resolves to: the graph's hook profile plus a tag profile. */
export type PlanProfile = HookProfile & { tags: ProfileTag[] };

export type ResolvedPlan = {
  commander: { id: number; name: string; colorIdentity: string };
  /** One profile per named theme, in the order given. */
  themes: PlanProfile[];
  /** The priority cards, by exact store name, in the order given. */
  priorities: string[];
  /** The commander and the priority cards as one card profile; null when the plan names no priority card. */
  cards: PlanProfile | null;
  /** One profile per avoided theme, in the order given. */
  avoid: PlanProfile[];
};

// ---------- Tagger vectors ----------
// Packed in the store as n float32 weights then n uint16 tag ids, little-endian, strongest first (store.ts).
type Vector = [tagId: number, weight: number][];

function unpack(blob: Uint8Array): Vector {
  if (blob.byteLength % 6 !== 0) throw new Error(`Tagger vector of ${blob.byteLength} bytes is not n float32 + n uint16`);
  const n = blob.byteLength / 6;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out: Vector = [];
  for (let i = 0; i < n; i++) out.push([view.getUint16(n * 4 + i * 2, true), view.getFloat32(i * 4, true)]);
  return out;
}

// Tag labels and the all-commander mean Tagger Deck weight per tag, once per store. Commander vectors are read again per
// theme (a theme has at most a few hundred commanders) rather than kept: all of them unpacked would hold 1.4M entries.
type TagData = { labels: Map<number, string>; meanDeck: Map<number, number> };
const TAGS = new WeakMap<Store, TagData>();

function tagData(store: Store): TagData {
  const hit = TAGS.get(store);
  if (hit) return hit;
  const labels = new Map((store.db.query("SELECT id, label FROM tags").all() as { id: number; label: string }[]).map((t) => [t.id, t.label]));
  const sum = new Map<number, number>();
  let n = 0;
  for (const r of store.db.query("SELECT tagger_deck FROM commanders WHERE decks > 0 ORDER BY card_id").iterate() as Iterable<{ tagger_deck: Uint8Array }>) {
    n++;
    for (const [t, w] of unpack(r.tagger_deck)) sum.set(t, (sum.get(t) ?? 0) + w);
  }
  const meanDeck = new Map([...sum].map(([t, s]) => [t, s / n]));
  const out = { labels, meanDeck };
  TAGS.set(store, out);
  return out;
}

function topTags(store: Store, weights: Map<number, number>): ProfileTag[] {
  const { labels } = tagData(store);
  const max = Math.max(0, ...weights.values());
  if (!(max > 0)) return [];
  return [...weights]
    .map(([t, w]) => ({ tag: labels.get(t) ?? String(t), weight: Math.round((w / max) * 1000) / 1000 }))
    .filter((t) => t.weight > 0)
    .sort((a, b) => b.weight - a.weight || byteOrder(a.tag, b.tag))
    .slice(0, TOP_TAGS);
}

/** A theme's tags: the share-weighted mean of its commanders' Tagger Deck vectors against the all-commander mean. */
function themeTags(store: Store, chosen: { page: { cardId: number }; share: number }[]): ProfileTag[] {
  const { meanDeck } = tagData(store);
  const q = store.db.query("SELECT tagger_deck FROM commanders WHERE card_id = ?");
  const t = new Map<number, number>();
  let total = 0;
  for (const { page, share } of chosen) {
    total += share;
    const row = q.get(page.cardId) as { tagger_deck: Uint8Array } | null;
    for (const [tag, w] of row ? unpack(row.tagger_deck) : []) t.set(tag, (t.get(tag) ?? 0) + share * w);
  }
  const scored = new Map<number, number>();
  for (const [tag, mass] of t) {
    const tw = mass / total, b = meanDeck.get(tag) ?? 0;
    if (!(b > 0)) continue;
    const lift = tw / b;
    if (lift >= STRATEGY_DEFAULTS.minLift) scored.set(tag, tw * Math.log(lift));
  }
  return topTags(store, scored);
}

/** A card plan's tags: the plan cards' Tagger Card vectors added up, the commander counted double. */
function cardTags(store: Store, ids: number[]): ProfileTag[] {
  const q = store.db.query("SELECT vector FROM card_tagger WHERE card_id = ?");
  const sum = new Map<number, number>();
  ids.forEach((id, k) => {
    const row = q.get(id) as { vector: Uint8Array } | null;
    for (const [tag, w] of row ? unpack(row.vector) : []) sum.set(tag, (sum.get(tag) ?? 0) + (k === 0 ? COMMANDER_WEIGHT : 1) * w);
  });
  return topTags(store, sum);
}

// ---------- resolving ----------

function themeProfile(store: Store, graph: Graph, theme: string): PlanProfile {
  const hooks = strategyProfile(store.db, graph, theme);
  return { ...hooks, tags: themeTags(store, themeCommanders(store.db, theme).chosen) };
}

/** A priority card by exact or front-face name; a fuzzy guess would change what the plan means. */
function priorityCard(store: Store, name: string): { id: number; name: string } {
  const r = resolveCard(store, name);
  const hit = store.names[r.id - 1].name;
  if (r.matchedBy !== "exact" && r.matchedBy !== "face") {
    throw new ToolInputError(`priority card "${name}" is not an exact card name; candidates: ${[hit, ...r.alternatives].join("; ")}`);
  }
  return { id: r.id, name: hit };
}

function cardsProfile(store: Store, graph: Graph, commander: { id: number; name: string }, priorities: { id: number; name: string }[]): PlanProfile {
  for (const c of [commander, ...priorities]) {
    if (!graph.positionOf.has(c.id)) throw new ToolInputError(`${c.name} has no card graph data (its card script could not be read), so it cannot anchor a plan; name another card`);
  }
  let hooks: HookProfile;
  try {
    hooks = cardProfile(graph.index, { commander: commander.name, priorities: priorities.map((p) => p.name) });
  } catch (e) {
    // planCards' checks (at most 6, all different, inside the commander's identity) are the caller's to fix
    if (e instanceof Error && !(e instanceof ToolInputError)) throw new ToolInputError(e.message);
    throw e;
  }
  return { ...hooks, tags: cardTags(store, [commander.id, ...priorities.map((p) => p.id)]) };
}

/** Resolve a confirmed plan for a commander into profiles, from the card store alone. Same inputs, same profiles. */
export function resolvePlan(store: Store, input: ResolvePlanInput): ResolvedPlan {
  const f = resolvePlanInput.parse(input);
  const themes = f.plan.themes ?? [], names = f.plan.priorities ?? [], avoid = f.plan.avoid ?? [];
  if (!themes.length && !names.length) throw new ToolInputError("a plan needs at least one theme or one priority card");
  const { card } = resolveCommander(store, f.commander);
  const commander = { id: store.names.findIndex((n) => n.oracleId === card.id) + 1, name: card.name };
  const graph = graphOf(store.db);
  const priorities = names.map((n) => priorityCard(store, n));
  return {
    commander: { ...commander, colorIdentity: card.ci.join("") },
    themes: themes.map((t) => themeProfile(store, graph, t)),
    priorities: priorities.map((p) => p.name),
    cards: priorities.length ? cardsProfile(store, graph, commander, priorities) : null,
    avoid: avoid.map((t) => themeProfile(store, graph, t)),
  };
}

// ---------- plan fit of one card ----------
// How well a card fits the plan, read against each plan profile (each theme, and the card profile) and taking the best:
//   hooks  the graph's profileFit over profileMatcher (graph/profile.ts): the main hooks (weight above half the heaviest)
//          the card's own abilities make or spend, never its own casting or entering; 0 for a card the graph could not
//          translate
//   tags   the summed weights of the profile's main tags (weight above half the heaviest, the same bar as main hooks)
//          that the card's Tagger Card vector carries (its kept tags with their parents), so a card the graph cannot
//          read (a counterspell, an anthem) still fits a plan that leans on it
// score = hooks + tags, rounded to 3 places; a card with score 0 has no hook or tag in any plan profile (off plan).
// This is the one plan fit the tools read (deck_stats planFit, the swap lever's plan gain); themes to avoid do not
// enter it. Each part names what matched, heaviest first, for the reason text.
export type PlanFit = { score: number; hooks: string[]; tags: string[] };
/** A main tag weighs more than half the heaviest, as a main hook does (graph/profile.ts isMainHook). */
const MAIN = 0.5;
export type PlanScorer = (cardOracleId: string) => PlanFit;

export function planScorer(store: Store, plan: ResolvedPlan): PlanScorer {
  const graph = graphOf(store.db);
  const { labels } = tagData(store);
  const profiles = [...plan.themes, ...(plan.cards ? [plan.cards] : [])].map((p) => ({
    match: profileMatcher(graph.index, p),
    tags: new Map(p.tags.filter((t) => t.weight > MAIN).map((t) => [t.tag, t.weight])),
  }));
  const vector = store.db.query("SELECT vector FROM card_tagger WHERE card_id = ?");
  const idOf = new Map(store.names.map((n) => [n.oracleId, n.id]));
  const memo = new Map<string, PlanFit>();
  return (oracleId) => {
    const hit = memo.get(oracleId);
    if (hit) return hit;
    const id = idOf.get(oracleId);
    if (id === undefined) throw new Error(`planScorer: no card with oracle id ${oracleId} in the store`);
    const i = graph.positionOf.get(id);
    const row = vector.get(id) as { vector: Uint8Array } | null;
    const cardTagSet = new Set((row ? unpack(row.vector) : []).map(([t]) => labels.get(t)));
    let best: PlanFit = { score: 0, hooks: [], tags: [] };
    for (const p of profiles) {
      const fit = i === undefined ? { score: 0, counted: [] } : profileFit(p.match(i));
      const tags = [...p.tags].filter(([t]) => cardTagSet.has(t));
      const score = Math.round((fit.score + tags.reduce((s, [, w]) => s + w, 0)) * 1000) / 1000;
      if (score > best.score) best = { score, hooks: [...new Set(fit.counted.map((c) => `${c.side} ${hookWords(c.hook)}`))], tags: tags.map(([t]) => t) };
    }
    memo.set(oracleId, best);
    return best;
  };
}

/** The plan as the tools echo it back: theme names as the data spells them, priority cards by exact name. */
export type PlanEcho = { themes: string[]; priorities: string[]; avoid: string[] };
/** What a tool needs to read plan fit: the confirmed plan as resolved, and its scorer. */
export type PlanContext = { plan: PlanEcho; fit: PlanScorer };

const themeName = (p: PlanProfile) => (p.source.kind === "strategy" ? p.source.theme : p.source.commander);

/** A resolved plan as the tools echo it back. */
export function planEcho(resolved: ResolvedPlan): PlanEcho {
  return { themes: resolved.themes.map(themeName), priorities: resolved.priorities, avoid: resolved.avoid.map(themeName) };
}

/** A card's strongest Tagger tags (its Tagger Card vector, strongest first), at most n; none for a card with no kept tags. */
export function strongestTags(store: Store, cardId: number, n: number): string[] {
  const row = store.db.query("SELECT vector FROM card_tagger WHERE card_id = ?").get(cardId) as { vector: Uint8Array } | null;
  const { labels } = tagData(store);
  return (row ? unpack(row.vector) : []).slice(0, n).map(([t]) => labels.get(t) ?? String(t));
}

/** The plan context for a tool call, or null when the call carries no plan. Throws the plan's ToolInputErrors. */
export function planContext(store: Store, commander: string, plan: PlanInput | undefined): PlanContext | null {
  if (plan === undefined) return null;
  const resolved = resolvePlan(store, { commander, plan });
  return { plan: planEcho(resolved), fit: planScorer(store, resolved) };
}
