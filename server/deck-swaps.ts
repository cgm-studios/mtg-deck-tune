// The swap lever's neighbor search (Card Galaxy deck builder, 2026-11-06; MV-10): for one deck card, in-color Card Space
// neighbors in the same Region that fit the player's plan better, at most a little more mana value. The plan fit comes
// from the caller (swap-tools.ts passes plan.ts planScorer, built from the player's confirmed plan); candidates come
// with their gain, and the player makes every call.

import { fitsIdentity } from "./color-identity";
import type { Method, Space, SpaceCard } from "./deck-pool";

/** A card's fit to the player's plan (plan.ts planScorer's score); higher is better, 0 is off plan. */
export type PlanFitOf = (c: SpaceCard) => number;

// Ranking knobs (the hill-climb varied these; defaults are the version a player rated 12/12 on 2026-11-06):
//   minGain   a candidate needs plan gain >= minGain (default: any gain, i.e. strictly better on plan; 0 admits ties)
//   tieFloor  added to the gain before weighting by similarity, so plan ties still rank by similarity
//   cmcPenalty  subtracted per mana value the candidate costs above the card
//   reverse   also take candidates that list this card as a neighbor (kNN is one-way), at their stored similarity
//   colorIdentity  the commander color identity; a candidate outside it is never proposed (ISC-4 for swaps)
export type SwapOptions = { colorIdentity?: string[]; reverse?: boolean; method?: Method; maxCmcUp?: number; perCard?: number; sameRegion?: boolean; minGain?: number; tieFloor?: number; cmcPenalty?: number };
export const SWAP_DEFAULTS = { method: "leidenHi" as Method, maxCmcUp: 1, perCard: 3, sameRegion: true, minGain: 1e-9, tieFloor: 0, cmcPenalty: 0, reverse: true };

// reverse neighbor index per Space: id → [(neighbor that lists it, similarity)]
const REV = new WeakMap<Space, Map<string, [string, number][]>>();
function reverseOf(space: Space) {
  let m = REV.get(space);
  if (m) return m;
  m = new Map();
  for (const id of space.order) { const c = space.cards.get(id)!; c.nb.forEach((v, x) => { const l = m!.get(v) ?? []; l.push([id, c.ns[x]]); m!.set(v, l); }); }
  REV.set(space, m);
  return m;
}
export type Swap = { out: SpaceCard; in: SpaceCard; sim: number; gain: number; rank: number };

export function swapsFor(space: Space, card: SpaceCard, deck: Set<string>, fit: PlanFitOf, opts: SwapOptions = {}): Swap[] {
  const o = { ...SWAP_DEFAULTS, ...opts };
  const me = space.cards.get(card.id)!, mine = fit(me), reg = me.r[o.method] ?? -1;
  const out: Swap[] = [];
  const cand = new Map<string, number>(me.nb.map((id, x) => [id, me.ns[x]]));
  if (o.reverse) for (const [id, v] of reverseOf(space).get(me.id) ?? []) if (!cand.has(id)) cand.set(id, v);
  for (const [id, sim] of cand) {
    const c = space.cards.get(id);
    if (!c?.meta || deck.has(id) || !c.inSpace || !c.legal || c.land) continue;
    if (o.colorIdentity && !fitsIdentity(c, o.colorIdentity)) continue;
    if (o.sameRegion && (reg < 0 || (c.r[o.method] ?? -1) !== reg)) continue;
    const gain = fit(c) - mine;
    if (gain < o.minGain || c.meta.cmc > me.meta!.cmc + o.maxCmcUp) continue;
    const rank = (gain + o.tieFloor) * sim - o.cmcPenalty * Math.max(0, c.meta.cmc - me.meta!.cmc);
    out.push({ out: me, in: c, sim, gain, rank });
  }
  return out.sort((a, b) => b.rank - a.rank || b.sim - a.sim || (a.in.name < b.in.name ? -1 : 1)).slice(0, o.perCard);
}
