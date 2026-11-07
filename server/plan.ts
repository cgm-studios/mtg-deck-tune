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
import { resolveCard, resolveCommander, ToolInputError, type Store } from "./deck-tools";
import { cardProfile, byteOrder, COMMANDER_WEIGHT, type HookProfile } from "./graph/profile";
import { graphOf, type Graph } from "./graph/store-graph";
import { STRATEGY_DEFAULTS, strategyProfile, themeCommanders } from "./graph/strategy";

export { ThinThemeError, UnknownThemeError } from "./graph/strategy";

const MAX_THEMES = 3;
const MAX_PRIORITIES = 6; // the graph's card-plan limit (graph/profile.ts planCards)
const MAX_AVOID = 5;
const TOP_TAGS = 25;

export const planShape = z.object({
  themes: z.array(z.string().min(1)).max(MAX_THEMES).optional()
    .describe(`EDHREC themes the deck is built around, by name (e.g. ["Aristocrats"]), at most ${MAX_THEMES}`),
  priorities: z.array(z.string().min(1)).max(MAX_PRIORITIES).optional()
    .describe(`Keystone cards the plan is about, exact card names inside the commander's color identity, at most ${MAX_PRIORITIES}`),
  avoid: z.array(z.string().min(1)).max(MAX_AVOID).optional()
    .describe(`EDHREC themes the player does not want (e.g. ["Tokens"] for a deck that should not go wide), at most ${MAX_AVOID}`),
}).strict();
export type PlanInput = z.input<typeof planShape>;

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

type TagData = { labels: Map<number, string>; deck: Map<number, Vector>; meanDeck: Map<number, number> };
const TAGS = new WeakMap<Store, TagData>();

function tagData(store: Store): TagData {
  const hit = TAGS.get(store);
  if (hit) return hit;
  const labels = new Map((store.db.query("SELECT id, label FROM tags").all() as { id: number; label: string }[]).map((t) => [t.id, t.label]));
  const deck = new Map<number, Vector>();
  const sum = new Map<number, number>();
  const rows = store.db.query("SELECT card_id, tagger_deck FROM commanders WHERE decks > 0 ORDER BY card_id").all() as { card_id: number; tagger_deck: Uint8Array }[];
  for (const r of rows) {
    const v = unpack(r.tagger_deck);
    deck.set(r.card_id, v);
    for (const [t, w] of v) sum.set(t, (sum.get(t) ?? 0) + w);
  }
  const meanDeck = new Map([...sum].map(([t, s]) => [t, s / rows.length]));
  const out = { labels, deck, meanDeck };
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
  const { deck, meanDeck } = tagData(store);
  const t = new Map<number, number>();
  let total = 0;
  for (const { page, share } of chosen) {
    total += share;
    for (const [tag, w] of deck.get(page.cardId) ?? []) t.set(tag, (t.get(tag) ?? 0) + share * w);
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
