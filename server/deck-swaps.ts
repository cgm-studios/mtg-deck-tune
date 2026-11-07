// The swap lever (Card Galaxy deck builder, 2026-11-06): map a decklist onto Regions, score each card against
// the commander's plan, and list swap candidates: in-color Card Space neighbors that keep the card's role and fit the
// plan better. Candidates come with reasons; the player makes every call.
// Data: Card Space, Tagger-derived Regions and Scryfall only (EDHREC is
// never read by product code).

import { fitsIdentity } from "./color-identity";
import { eligible, type Method, type Space, type SpaceCard } from "./deck-pool";

// ---------- the plan ----------
// What the commander rewards, read from its own text and shown to the player before any swap (they can override it).
export type Plan = { spellPips: string | null; tribe: string | null };
const COLOR = { white: "W", blue: "U", black: "B", red: "R", green: "G" } as const;

export function readPlan(commander: SpaceCard): Plan {
  const t = commander.meta?.text ?? "";
  const pip = t.match(/noncreature spell with one or more (white|blue|black|red|green) mana symbols/i);
  const tribe = t.match(/number of (\w+) you control|other (\w+) you control|(\w+) creature tokens/i);
  const name = tribe?.slice(1).find(Boolean) ?? null;
  return { spellPips: pip ? COLOR[pip[1].toLowerCase() as keyof typeof COLOR] : null, tribe: name && /^[A-Z]/.test(name) ? name : null };
}

export type Weights = { tokens: number; tribe: number; payoff: number };
export const WEIGHTS: Weights = { tokens: 1, tribe: 2, payoff: 2 };

export type PlanScore = { tokens: number; tribe: number; payoff: number; score: number };
export function planScore(c: SpaceCard, plan: Plan, w: Weights = WEIGHTS): PlanScore {
  const m = c.meta!;
  const pipRe = plan.spellPips ? new RegExp(`\\{[^}]*${plan.spellPips}[^}]*\\}`, "g") : null;
  const tokens = pipRe && !/Creature/.test(m.type) ? (m.cost.match(pipRe) ?? []).length : 0;
  const tribe = plan.tribe && new RegExp(`\\b${plan.tribe}\\b`).test(m.type) ? 1 : 0;
  const ownText = m.text.split(c.name).join("CARDNAME");
  const payoff = (plan.tribe && new RegExp(`\\b${plan.tribe}\\b`, "i").test(ownText)) ||
    /whenever (you cast|a player casts) (a|an|your first|your second|their second) (spell|noncreature|instant|sorcery)/i.test(ownText) ? 1 : 0;
  return { tokens, tribe, payoff, score: w.tokens * tokens + w.tribe * tribe + w.payoff * payoff };
}

// ---------- swaps ----------
// Ranking knobs (the hill-climb varies these; defaults are the version a player rated 12/12 on 2026-11-06):
//   minGain   a candidate needs plan gain >= minGain (default: any gain, i.e. strictly better on plan; 0 admits ties)
//   tieFloor  added to the gain before weighting by similarity, so plan ties still rank by similarity
//   cmcPenalty  subtracted per mana value the candidate costs above the card
//   reverse   also take candidates that list this card as a neighbor (kNN is one-way), at their stored similarity
//   colorIdentity  the commander color identity; a candidate outside it is never proposed (ISC-4 for swaps)
export type SwapOptions = { colorIdentity?: string[]; reverse?: boolean; method?: Method; maxCmcUp?: number; perCard?: number; weights?: Weights; sameRegion?: boolean; minGain?: number; tieFloor?: number; cmcPenalty?: number };
export const SWAP_DEFAULTS = { method: "leidenHi" as Method, maxCmcUp: 1, perCard: 3, weights: WEIGHTS, sameRegion: true, minGain: 1e-9, tieFloor: 0, cmcPenalty: 0, reverse: true };

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
export type Swap = { out: SpaceCard; in: SpaceCard; sim: number; gain: number; rank: number; why: string[] };

export function swapsFor(space: Space, card: SpaceCard, deck: Set<string>, plan: Plan, opts: SwapOptions = {}): Swap[] {
  const o = { ...SWAP_DEFAULTS, ...opts };
  const me = space.cards.get(card.id)!, mine = planScore(me, plan, o.weights), reg = me.r[o.method] ?? -1;
  const out: Swap[] = [];
  const cand = new Map<string, number>(me.nb.map((id, x) => [id, me.ns[x]]));
  if (o.reverse) for (const [id, v] of reverseOf(space).get(me.id) ?? []) if (!cand.has(id)) cand.set(id, v);
  for (const [id, sim0] of cand) {
    const c = space.cards.get(id);
    if (!c?.meta || deck.has(id) || !c.inSpace || !c.legal || c.land) continue;
    if (o.colorIdentity && !fitsIdentity(c, o.colorIdentity)) continue;
    if (o.sameRegion && (reg < 0 || (c.r[o.method] ?? -1) !== reg)) continue;
    const p = planScore(c, plan, o.weights);
    if (p.score - mine.score < o.minGain || c.meta.cmc > me.meta!.cmc + o.maxCmcUp) continue;
    const why = [
      p.tokens > mine.tokens && `${p.tokens} token${p.tokens > 1 ? "s" : ""} per cast vs ${mine.tokens}`,
      p.tribe > mine.tribe && `is a ${plan.tribe}`,
      p.payoff > mine.payoff && "plan payoff",
    ].filter((s): s is string => !!s);
    const sim = sim0, gain = p.score - mine.score;
    const rank = (gain + o.tieFloor) * sim - o.cmcPenalty * Math.max(0, c.meta.cmc - me.meta!.cmc);
    out.push({ out: me, in: c, sim, gain, rank, why });
  }
  return out.sort((a, b) => b.rank - a.rank || b.sim - a.sim || (a.in.name < b.in.name ? -1 : 1)).slice(0, o.perCard);
}

export type DeckReport = {
  plan: Plan; cards: SpaceCard[];
  profile: { region: number; n: number; lift: number; cards: string[] }[];
  scores: Map<string, PlanScore>; offPlan: SpaceCard[];
  perCard: Map<string, Swap[]>; top: Swap[];
};

// `space` should be the commander's in-color Space (spaceFor). `top` holds the best swap per card, each incoming card
// used once, ranked by plan gain × similarity.
export function deckSwaps(space: Space, commander: SpaceCard, deckIds: string[], plan: Plan, opts: SwapOptions = {}): DeckReport {
  const o = { ...SWAP_DEFAULTS, ...opts };
  const deck = new Set(deckIds);
  const cards = [...new Set(deckIds)].map((id) => space.cards.get(id)!).filter((c) => c && c.inSpace && !c.land && c.id !== commander.id)
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const reg = (c: SpaceCard) => c.r[o.method] ?? -1;
  const pool = space.order.map((id) => space.cards.get(id)!).filter((c) => eligible(c, commander));
  const pc = new Map<number, number>(), dc = new Map<number, string[]>();
  for (const c of pool) pc.set(reg(c), (pc.get(reg(c)) ?? 0) + 1);
  for (const c of cards) dc.set(reg(c), [...(dc.get(reg(c)) ?? []), c.name]);
  const profile = [...dc].map(([region, names]) => ({ region, n: names.length, lift: names.length / cards.length / ((pc.get(region) ?? 1) / pool.length), cards: names }))
    .sort((a, b) => b.n - a.n || b.lift - a.lift || a.region - b.region);
  const scores = new Map(cards.map((c) => [c.id, planScore(c, plan, o.weights)]));
  const perCard = new Map(cards.map((c) => [c.id, swapsFor(space, c, deck, plan, { ...o, colorIdentity: commander.ci })]));
  const used = new Set<string>(), top: Swap[] = [];
  for (const s of [...perCard.values()].flat().sort((a, b) => b.rank - a.rank || b.sim - a.sim || (a.in.name < b.in.name ? -1 : 1))) {
    if (top.some((t) => t.out.id === s.out.id) || used.has(s.in.id)) continue;
    used.add(s.in.id); top.push(s);
  }
  return { plan, cards, profile, scores, offPlan: cards.filter((c) => scores.get(c.id)!.score === 0), perCard, top };
}
