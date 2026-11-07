// MV-16: the deck MCP's swap tools as plain functions over the card store, beside deck-tools.ts (app/mcp.ts wraps
// them). swap_candidates proposes swaps for one card or the whole deck under a lever; every candidate is a card from
// the store inside the commander's color identity, comes with its reason, and shows the deck numbers before and after
// (ISA ISC-7 to 11, ISC-21). Same inputs, same answer, card for card. SQL is fixed fragments with bound values.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ciMask, fitsIdentity } from "./color-identity";
import { parseDecklist, withGraph, type DeckEntry, type Space, type SpaceCard } from "./deck-pool";
import { swapsFor } from "./deck-swaps";
import {
  deckNumbers, deckPath, readDeck, resolveCard, resolveCommander, ToolInputError, unresolvedLines,
  type DeckNumbers, type DeckStats, type Store,
} from "./deck-tools";
import { planContext, type PlanContext, type PlanEcho } from "./plan";
import { planShape } from "./plan-input";
import { rolesOf } from "./roles";

// ---------- the commander's in-color Card Space ----------
// The store keeps one neighbor list per card over every identity; a commander's in-color list for a card is the first
// 30 rows whose neighbor fits the commander's identity (card-store.md), the same lists MV-10's in-color graph holds.
// Built once per identity and kept for the store's lifetime (1 to 2.5 s each).
const IN_COLOR_K = 30;
type InColor = { space: Space; reverse: Map<string, { from: string; rank: number; sim: number }[]> };
const IN_COLOR = new WeakMap<Store, Map<number, InColor>>();

function inColor(store: Store, mask: number): InColor {
  let byMask = IN_COLOR.get(store);
  if (!byMask) IN_COLOR.set(store, (byMask = new Map()));
  const hit = byMask.get(mask);
  if (hit) return hit;
  const rows = store.db.query(`SELECT n.card_id AS a, n.neighbor_id AS b, n.score AS s FROM neighbors n
    JOIN cards x ON x.id = n.card_id JOIN cards y ON y.id = n.neighbor_id
    WHERE (x.ci_mask & ~?) = 0 AND (y.ci_mask & ~?) = 0 ORDER BY n.card_id, n.rank`).all(mask, mask) as { a: number; b: number; s: number }[];
  const lists = new Map<string, { nb: string[]; ns: number[] }>();
  const reverse: InColor["reverse"] = new Map();
  for (const r of rows) {
    const from = store.names[r.a - 1].oracleId;
    let l = lists.get(from);
    if (!l) lists.set(from, (l = { nb: [], ns: [] }));
    if (l.nb.length >= IN_COLOR_K) continue;
    const to = store.names[r.b - 1].oracleId;
    l.nb.push(to); l.ns.push(r.s);
    (reverse.get(to) ?? reverse.set(to, []).get(to)!).push({ from, rank: l.nb.length, sim: r.s });
  }
  const built = { space: withGraph(store.space, lists), reverse };
  byMask.set(mask, built);
  return built;
}

// ---------- per-card facts ----------
const STORE_ID = new WeakMap<Store, Map<string, number>>();
function storeId(store: Store, oracleId: string): number {
  let m = STORE_ID.get(store);
  if (!m) STORE_ID.set(store, (m = new Map(store.names.map((n) => [n.oracleId, n.id]))));
  const id = m.get(oracleId);
  if (id === undefined) throw new Error(`card store is inconsistent: oracle id ${oracleId} has no store id`);
  return id;
}

const TAGS = new WeakMap<Store, Map<string, string[]>>();
function directTags(store: Store, oracleId: string): string[] {
  let m = TAGS.get(store);
  if (!m) TAGS.set(store, (m = new Map()));
  let tags = m.get(oracleId);
  if (!tags) {
    tags = (store.db.query("SELECT t.label FROM card_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.card_id = ? ORDER BY t.label")
      .all(storeId(store, oracleId)) as { label: string }[]).map((r) => r.label);
    m.set(oracleId, tags);
  }
  return tags;
}

const countedRoles = (store: Store, c: SpaceCard) => rolesOf(store.roles, c.id).roles;

// ---------- role targets ----------
// A proposal, not settled (ISA fog): app/role-targets.json gives one target count per role; a call may replace any of
// them. Under = count below target, over = count above, at = equal.
const TARGETS_PATH = new URL("./role-targets.json", import.meta.url).pathname;
export type RoleStatus = { role: string; count: number; target: number; status: "under" | "at" | "over" };

export function loadTargets(roleNames: string[], path = TARGETS_PATH): Record<string, number> {
  const file = JSON.parse(readFileSync(path, "utf8")) as { targets?: Record<string, unknown> };
  const t = file.targets;
  if (!t || typeof t !== "object") throw new Error(`${path}: no "targets" table`);
  const problems = [
    ...roleNames.filter((r) => !(r in t)).map((r) => `missing role "${r}"`),
    ...Object.keys(t).filter((r) => !roleNames.includes(r)).map((r) => `unknown role "${r}"`),
    ...Object.entries(t).filter(([, v]) => !Number.isInteger(v) || (v as number) < 0).map(([r]) => `"${r}" is not a whole number of cards`),
  ];
  if (problems.length) throw new Error(`${path}: ${problems.join("; ")}`);
  return t as Record<string, number>;
}

function targetsFor(store: Store, own: Record<string, number> | undefined): Record<string, number> {
  const names = store.roles.roleNames;
  for (const r of Object.keys(own ?? {})) if (!names.includes(r)) {
    throw new ToolInputError(`unknown role "${r}" in targets; roles: ${names.join(", ")}`);
  }
  return { ...loadTargets(names), ...own };
}

const roleStatus = (store: Store, counts: Record<string, number>, targets: Record<string, number>): RoleStatus[] =>
  store.roles.roleNames.map((role) => {
    const count = counts[role], target = targets[role];
    return { role, count, target, status: count < target ? "under" : count > target ? "over" : "at" };
  });

// ---------- numbers before and after ----------
// The deck_stats numbers that move when one card changes, for the before side (once per answer) and each candidate's
// after side; `delta` is after minus before, listing only what changed.
export type SwapStats = Pick<DeckNumbers, "cards" | "nonland" | "averageManaValue" | "curve" | "roleCounts" | "pipLoad"> & { onPlan: number | null; planOf: number | null }; // null without a plan
export type StatsDelta = {
  cards: number; averageManaValue: number; onPlan: number | null;
  curve: Record<string, number>; roleCounts: Record<string, number>; pipLoad: Record<string, number>;
};

const swapStats = (n: DeckNumbers): SwapStats => ({
  cards: n.cards, nonland: n.nonland, averageManaValue: n.averageManaValue, curve: n.curve, roleCounts: n.roleCounts, pipLoad: n.pipLoad,
  onPlan: n.planFit?.onPlan ?? null, planOf: n.planFit?.of ?? null,
});

function changed(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if ((b[k] ?? 0) !== (a[k] ?? 0)) out[k] = (b[k] ?? 0) - (a[k] ?? 0);
  return out;
}
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const statsDelta = (a: SwapStats, b: SwapStats): StatsDelta => ({
  cards: b.cards - a.cards, averageManaValue: round3(b.averageManaValue - a.averageManaValue), onPlan: a.onPlan === null || b.onPlan === null ? null : b.onPlan - a.onPlan,
  curve: changed(a.curve, b.curve), roleCounts: changed(a.roleCounts, b.roleCounts), pipLoad: changed(a.pipLoad, b.pipLoad),
});

// The list with one copy of `out` taken away and one `in` added (either may be absent: a cut or an add).
function applySwap(entries: DeckEntry[], out: SpaceCard | null, inCard: SpaceCard | null): DeckEntry[] {
  const next: DeckEntry[] = [];
  let taken = !out;
  for (const e of entries) {
    if (!taken && e.card?.id === out!.id) {
      taken = true;
      if (e.qty > 1) next.push({ ...e, qty: e.qty - 1 });
      continue;
    }
    next.push(e);
  }
  if (!taken) throw new Error(`applySwap: ${out!.name} is not in the list`);
  if (inCard) next.push({ line: 0, qty: 1, text: inCard.name, card: inCard });
  return next;
}

// ---------- swap_candidates ----------
export const LEVERS = ["plan", "cheaper", "budget", "roles", "redundancy"] as const;
export type Lever = (typeof LEVERS)[number];

export const swapCandidatesShape = {
  commander: z.string().min(1).describe("The commander's exact name or front-face name (case and punctuation ignored)"),
  deckFile: z.string().min(1).optional().describe("Path to a `1 Card Name` decklist file, absolute or relative to the project directory"),
  decklist: z.string().min(1).optional().describe("The decklist text itself, `1 Card Name` per line; give this or deckFile"),
  lever: z.enum(LEVERS).describe(
    "plan: in-color Card Space neighbors in the same Region that fit the player's plan better (needs `plan`), at most 1 mana value more; " +
    "cheaper: lower mana value; budget: lower Scryfall USD price; " +
    "roles: per-role counts against targets, and cards that fill roles under target; " +
    "redundancy: roles over target, and deck cards that could be cut"),
  card: z.string().min(1).optional().describe("One card in the deck to replace (plan, cheaper and budget levers); omit for the whole deck"),
  limit: z.number().int().min(1).max(50).optional().describe("Most candidates to return (default 5 for one card, 15 for the whole deck)"),
  targets: z.record(z.string(), z.number().int().min(0)).optional().describe(
    "Role target counts, replacing the defaults for the roles named (e.g. {\"ramp\": 9}): the roles and redundancy levers " +
    "measure the deck against them, and every lever's belowTarget flag reads them; the defaults are a proposal (role-targets.json)"),
  plan: planShape.optional().describe("The player's confirmed plan (themes, priority cards, themes to avoid). The plan lever needs it; with it, " +
    "every lever reports plan fit before and after, and ties among cuts and fills go to the card that fits the plan"),
};
const swapCandidatesInput = z.object(swapCandidatesShape).strict();
export type SwapCandidatesInput = z.input<typeof swapCandidatesInput>;

export type SwapCard = { name: string; manaValue: number; usd: number | null; roles: string[] };
export type Evidence = {
  neighborRank: number | null; // the incoming card's place in the outgoing card's in-color neighbor list (1 = nearest)
  reverseRank: number | null; // the outgoing card's place in the incoming card's in-color list (kNN is one-way)
  similarity: number | null; // Card Space similarity, when they are neighbors either way
  sharedTags: string[]; // Tagger tags both cards carry directly
  roleTags: string[]; // roles and redundancy levers: the card's own Tagger tags that give the role it fills or relieves
  planGain: number | null; // plan fit in minus out (plan.ts planScorer); an absent side scores 0; null without a plan
  manaValueDelta: number; // in minus out; an absent side counts 0
  priceDelta: number | null; // in minus out, USD; an absent side costs $0; null when a present card is unpriced
};
export type Candidate = {
  out: SwapCard | null; in: SwapCard | null;
  reason: string;
  evidence: Evidence;
  after: SwapStats; delta: StatsDelta;
  roleDrops: { role: string; before: number; after: number }[]; // roles the swap leaves with fewer cards
  dropsRole: boolean; // ISC-21.3: some role count goes down, whether or not it stays at target
  // the roles the swap lowers to under their target: the alarming kind of drop. A drop that stays at or above target
  // (a redundancy cut, say) is in roleDrops only. A role already under target that the swap leaves alone is in neither.
  rolesBelowTarget: { role: string; after: number; target: number }[];
  belowTarget: boolean;
};
export type SwapCandidatesResult = {
  commander: { name: string; colorIdentity: string };
  lever: Lever; card: string | null;
  plan: PlanEcho | null;
  before: SwapStats;
  roles: RoleStatus[] | null; // the roles and redundancy levers: every role's count against its target
  candidates: Candidate[];
  notes: string[];
  unresolved: DeckStats["unresolved"];
};

type Ctx = {
  store: Store; commander: SpaceCard; mask: number; plan: PlanContext | null; graph: InColor;
  entries: DeckEntry[]; inDeck: Set<string>; before: SwapStats;
  targets: Record<string, number>; // every role's target, for the below-target flag under every lever
};

// A card's fit to the player's plan; 0 when the call carries no plan, so plan-fit tie-breaks fall through.
const fitOf = (ctx: Ctx, c: SpaceCard) => ctx.plan?.fit(c.id).score ?? 0;

const swapCard = (store: Store, c: SpaceCard): SwapCard =>
  ({ name: c.name, manaValue: c.meta!.cmc, usd: c.meta!.usd, roles: countedRoles(store, c).map((r) => r.role) });

const money = (x: number) => `$${x.toFixed(2)}`;
const signed = (x: number, f: (v: number) => string = String) => (x > 0 ? `+${f(x)}` : x < 0 ? `-${f(-x)}` : f(0));

// Neighbor links between two cards in the commander's in-color Card Space, both ways.
function links(ctx: Ctx, out: SpaceCard, inCard: SpaceCard) {
  const o = ctx.graph.space.cards.get(out.id)!, i = ctx.graph.space.cards.get(inCard.id)!;
  const f = o.nb.indexOf(inCard.id), r = i.nb.indexOf(out.id);
  return {
    neighborRank: f >= 0 ? f + 1 : null, reverseRank: r >= 0 ? r + 1 : null,
    similarity: f >= 0 ? o.ns[f] : r >= 0 ? i.ns[r] : null,
  };
}

const tagList = (tags: string[]) => `${tags.slice(0, 6).join(", ")}${tags.length > 6 ? ` (+${tags.length - 6})` : ""}`;

// A full candidate: links, shared tags, the mana value and price difference, the numbers after, and the role drops.
// `out` alone is a cut (the redundancy lever), `in` alone an add (a role fill with nothing left to cut).
function candidate(ctx: Ctx, out: SpaceCard | null, inCard: SpaceCard | null, why: string[], roleTags: string[] = []): Candidate {
  if (!out && !inCard) throw new Error("candidate: needs an outgoing card, an incoming card, or both");
  const { store } = ctx;
  const l = out && inCard ? links(ctx, out, inCard) : { neighborRank: null, reverseRank: null, similarity: null };
  const outTags = new Set(out ? directTags(store, out.id) : []);
  const sharedTags = inCard ? directTags(store, inCard.id).filter((t) => outTags.has(t)) : [];
  const mv = (c: SpaceCard | null) => c?.meta!.cmc ?? 0;
  const usd = (c: SpaceCard | null) => (c ? c.meta!.usd : 0); // an absent side costs nothing
  const mvDelta = mv(inCard) - mv(out);
  const inUsd = usd(inCard), outUsd = usd(out);
  const priceDelta = inUsd !== null && outUsd !== null ? round3(inUsd - outUsd) : null;
  const score = (c: SpaceCard | null) => (c ? fitOf(ctx, c) : 0);
  const planGain = ctx.plan ? Math.round((score(inCard) - score(out)) * 1000) / 1000 : null;
  const evidence: Evidence = { ...l, sharedTags, roleTags, planGain, manaValueDelta: mvDelta, priceDelta };
  const after = swapStats(deckNumbers(store, ctx.commander, applySwap(ctx.entries, out, inCard), ctx.plan));
  const roleDrops = ctx.store.roles.roleNames
    .filter((r) => after.roleCounts[r] < ctx.before.roleCounts[r])
    .map((r) => ({ role: r, before: ctx.before.roleCounts[r], after: after.roleCounts[r] }));
  const rolesBelowTarget = roleDrops.filter((d) => d.after < ctx.targets[d.role])
    .map((d) => ({ role: d.role, after: d.after, target: ctx.targets[d.role] }));
  const dropText = (d: (typeof roleDrops)[number]) => `${d.role} ${d.before} → ${d.after}, ` +
    (d.after < ctx.targets[d.role] ? `under its target ${ctx.targets[d.role]}` : `still at or above its target ${ctx.targets[d.role]}`);
  const mvText = out && inCard ? `mana value ${mv(inCard)} vs ${mv(out)} (${signed(mvDelta)})`
    : out ? `cuts mana value ${mv(out)} (${signed(mvDelta)})` : `adds mana value ${mv(inCard)} (${signed(mvDelta)})`;
  const priceText = priceDelta === null ? null
    : out && inCard ? `${money(inUsd!)} vs ${money(outUsd!)} (${signed(priceDelta, money)})`
    : `${out ? "cuts" : "adds"} ${money(out ? outUsd! : inUsd!)} (${signed(priceDelta, money)})`;
  const reason = [
    ...why,
    l.neighborRank !== null && `in-color neighbor #${l.neighborRank} of ${out!.name} (similarity ${l.similarity!.toFixed(3)})`,
    l.neighborRank === null && l.reverseRank !== null && `lists ${out!.name} as its in-color neighbor #${l.reverseRank} (similarity ${l.similarity!.toFixed(3)})`,
    sharedTags.length > 0 && `shares Tagger tags: ${tagList(sharedTags)}`,
    mvText, priceText,
    roleDrops.length > 0 && `drops ${roleDrops.map(dropText).join("; drops ")}`,
  ].filter((s): s is string => typeof s === "string" && s.length > 0).join("; ");
  return {
    out: out && swapCard(store, out), in: inCard && swapCard(store, inCard), reason, evidence,
    after, delta: statsDelta(ctx.before, after), roleDrops, dropsRole: roleDrops.length > 0,
    rolesBelowTarget, belowTarget: rolesBelowTarget.length > 0,
  };
}

// Cards that share the most direct Tagger tags with `out`, inside the identity, nonland, passing the lever's filter.
const TAG_MATES = 60;
const LEVER_SQL: Record<"cheaper" | "budget", string> = {
  cheaper: "c.mana_value < ?",
  budget: "c.usd_price IS NOT NULL AND c.usd_price < ?",
};
function tagMates(ctx: Ctx, out: SpaceCard, lever: "cheaper" | "budget", bound: number): SpaceCard[] {
  const id = storeId(ctx.store, out.id);
  const rows = ctx.store.db.query(`SELECT x.card_id AS id FROM card_tags me
    JOIN card_tags x ON x.tag_id = me.tag_id JOIN cards c ON c.id = x.card_id
    WHERE me.card_id = ? AND x.card_id <> ? AND c.in_card_space = 1 AND (c.ci_mask & ~?) = 0 AND ${LEVER_SQL[lever]}
    GROUP BY x.card_id ORDER BY COUNT(*) DESC, c.name, c.id LIMIT ?`).all(id, id, ctx.mask, bound, TAG_MATES) as { id: number }[];
  return rows.map((r) => ctx.store.space.cards.get(ctx.store.names[r.id - 1].oracleId)!);
}

// A proposed swap before its numbers are computed: the per-card levers rank these on cheap facts, and only the ones
// kept become full candidates (before/after numbers). `drops` is exact for a one-copy swap of a card not yet in the
// deck: a role count falls only when the outgoing card counts toward a role the incoming card does not.
type Pick = { out: SpaceCard; in: SpaceCard; why: string[]; drops: boolean; sim: number; shared: number; saving: number; planRank: number };

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const LEVER_ORDER = (a: Pick, b: Pick) => Number(a.drops) - Number(b.drops) || b.sim - a.sim || b.shared - a.shared ||
  b.saving - a.saving || byName(a.in.name, b.in.name) || byName(a.out.name, b.out.name);
const PLAN_ORDER = (a: Pick, b: Pick) => b.planRank - a.planRank || b.sim - a.sim || byName(a.in.name, b.in.name) || byName(a.out.name, b.out.name);

function pick(ctx: Ctx, out: SpaceCard, inCard: SpaceCard, why: string[], saving: number, planRank = 0): Pick {
  const outTags = new Set(directTags(ctx.store, out.id));
  const inRoles = new Set(countedRoles(ctx.store, inCard).map((r) => r.role));
  return {
    out, in: inCard, why, saving, planRank,
    drops: countedRoles(ctx.store, out).some((r) => !inRoles.has(r.role)),
    sim: links(ctx, out, inCard).similarity ?? -1,
    shared: directTags(ctx.store, inCard.id).filter((t) => outTags.has(t)).length,
  };
}

// cheaper / budget for one card: in-color neighbors both ways plus the closest tag-mates, filtered by the lever.
// Order: keeps every role first, then nearest in the Card Space, then most shared tags, then the bigger saving, then name.
function leverPicks(ctx: Ctx, out: SpaceCard, lever: "cheaper" | "budget"): Pick[] {
  const bound = lever === "cheaper" ? out.meta!.cmc : out.meta!.usd;
  if (bound === null) return [];
  const passes = (c: SpaceCard) => (lever === "cheaper" ? c.meta!.cmc < bound : c.meta!.usd !== null && c.meta!.usd < bound);
  const pool = new Map<string, SpaceCard>();
  for (const id of ctx.graph.space.cards.get(out.id)!.nb) pool.set(id, ctx.store.space.cards.get(id)!);
  for (const r of ctx.graph.reverse.get(out.id) ?? []) pool.set(r.from, ctx.store.space.cards.get(r.from)!);
  for (const c of tagMates(ctx, out, lever, bound)) pool.set(c.id, c);
  return [...pool.values()]
    .filter((c) => !c.land && c.inSpace && fitsIdentity(c, ctx.commander.ci) && !ctx.inDeck.has(c.id) && c.id !== ctx.commander.id && passes(c))
    .map((c) => pick(ctx, out, c, [], lever === "cheaper" ? out.meta!.cmc - c.meta!.cmc : out.meta!.usd! - c.meta!.usd!))
    .sort(LEVER_ORDER);
}

// plan for one card: the MV-10 swap lever (deck-swaps.ts swapsFor, its defaults: same leidenHi Region, a strict plan
// gain, at most 1 mana value more, reverse neighbors on) run on the commander's in-color Space built from the store,
// with the player's plan as the fit (plan.ts planScorer). Its order is kept: plan gain × similarity.
function planPicks(ctx: Ctx, out: SpaceCard, limit: number): Pick[] {
  const plan = ctx.plan;
  if (!plan) throw new Error("planPicks: the plan lever runs only with a plan (swapCandidates checks)");
  const deck = new Set([...ctx.inDeck, ctx.commander.id]);
  return swapsFor(ctx.graph.space, out, deck, (c) => plan.fit(c.id).score, { colorIdentity: ctx.commander.ci, perCard: limit })
    .map((s) => pick(ctx, out, ctx.store.space.cards.get(s.in.id)!, [planWhy(plan, s.in, out, s.gain)], 0, s.rank));
}

// What the incoming card fits in the plan, and its fit against the outgoing card's.
function planWhy(plan: PlanContext, inCard: SpaceCard, out: SpaceCard, gain: number): string {
  const f = plan.fit(inCard.id);
  const parts = [f.hooks.length > 0 && `works on ${f.hooks.slice(0, 4).join(", ")}`, f.tags.length > 0 && `plan tags: ${tagList(f.tags)}`].filter(Boolean);
  return `plan: ${parts.join("; ")} (plan fit ${f.score} vs ${plan.fit(out.id).score}, ${signed(Math.round(gain * 1000) / 1000)})`;
}

const picksFor = (ctx: Ctx, out: SpaceCard, lever: "plan" | "cheaper" | "budget", limit: number) =>
  (lever === "plan" ? planPicks(ctx, out, limit) : leverPicks(ctx, out, lever).slice(0, limit));

// The whole deck under a per-card lever: each nonland card's top 3, then the best swap per outgoing card with each
// incoming card used once (deck-swaps deckSwaps' rule), in the lever's order.
const PER_CARD_IN_DECK = 3;
function deckPicks(ctx: Ctx, lever: "plan" | "cheaper" | "budget", limit: number): Pick[] {
  const outs = [...new Map(ctx.entries.flatMap((e) => (e.card && !e.card.land && e.card.inSpace && e.card.id !== ctx.commander.id ? [[e.card.id, e.card] as const] : []))).values()]
    .sort((a, b) => byName(a.name, b.name));
  const all = outs.flatMap((c) => picksFor(ctx, c, lever, PER_CARD_IN_DECK)).sort(lever === "plan" ? PLAN_ORDER : LEVER_ORDER);
  const usedOut = new Set<string>(), usedIn = new Set<string>(), top: Pick[] = [];
  for (const p of all) {
    if (usedOut.has(p.out.id) || usedIn.has(p.in.id)) continue;
    usedOut.add(p.out.id); usedIn.add(p.in.id); top.push(p);
    if (top.length === limit) break;
  }
  return top;
}

// redundancy: deck cards that count toward a role over its target and whose removal leaves every role it counts toward
// at or above its target (so a cut never opens a new gap). Order: relieves the most over-target roles, then lowest
// plan score (off plan first), then highest mana value, then name.
type Cut = { card: SpaceCard; relieves: RoleStatus[]; tags: string[]; planScore: number };
function cuts(ctx: Ctx, status: RoleStatus[]): Cut[] {
  const by = new Map(status.map((s) => [s.role, s]));
  const seen = new Set<string>(), out: Cut[] = [];
  for (const e of ctx.entries) {
    const c = e.card;
    if (!c || c.land || c.id === ctx.commander.id || seen.has(c.id)) continue;
    seen.add(c.id);
    const roles = countedRoles(ctx.store, c);
    const relieves = roles.map((r) => by.get(r.role)!).filter((s) => s.status === "over");
    if (!relieves.length || roles.some((r) => by.get(r.role)!.count - 1 < by.get(r.role)!.target)) continue;
    const tags = [...new Set(roles.filter((r) => relieves.some((s) => s.role === r.role)).flatMap((r) => r.tags))].sort();
    out.push({ card: c, relieves, tags, planScore: fitOf(ctx, c) });
  }
  return out.sort((a, b) => b.relieves.length - a.relieves.length || a.planScore - b.planScore ||
    b.card.meta!.cmc - a.card.meta!.cmc || byName(a.card.name, b.card.name));
}

const cutWhy = (ctx: Ctx, cut: Cut) => [
  ...cut.relieves.map((s) => `${s.role} ${s.count} over target ${s.target}`),
  `gives it through Tagger tags: ${tagList(cut.tags)}`,
  "removing it keeps every role at or above target",
  ...(ctx.plan ? [cut.planScore === 0 ? "off the player's plan" : `plan fit ${cut.planScore}`] : []),
];

// roles: cards that fill a role under its target, from every nonland store card inside the identity that counts toward
// the role and is not in the deck. Order within a role: Card Space neighbor of the most deck cards (in-color lists), then
// the nearest such link, then plan score, then lowest mana value, then name. Roles take turns, the biggest gap first;
// pairCuts below gives each fill its cut, or leaves it as an add when no safe cut is left.
type Fill = { card: SpaceCard; status: RoleStatus; tags: string[]; affinity: number; nearest: { from: SpaceCard; rank: number; sim: number } | null; planScore: number };
const PER_ROLE = 3;
function fills(ctx: Ctx, status: RoleStatus[]): Fill[] {
  const near = new Map<string, { n: number; best: { from: SpaceCard; rank: number; sim: number } }>();
  const deckCards = [...new Map(ctx.entries.flatMap((e) => (e.card && !e.card.land ? [[e.card.id, e.card] as const] : []))).values()]
    .sort((a, b) => byName(a.name, b.name));
  for (const d of deckCards) {
    const g = ctx.graph.space.cards.get(d.id)!;
    g.nb.forEach((id, i) => {
      const hit = near.get(id);
      if (!hit) near.set(id, { n: 1, best: { from: d, rank: i + 1, sim: g.ns[i] } });
      else { hit.n++; if (g.ns[i] > hit.best.sim) hit.best = { from: d, rank: i + 1, sim: g.ns[i] }; }
    });
  }
  const pool = [...ctx.store.space.cards.values()]
    .filter((c) => !c.land && c.inSpace && fitsIdentity(c, ctx.commander.ci) && !ctx.inDeck.has(c.id) && c.id !== ctx.commander.id)
    .map((c) => ({ c, roles: countedRoles(ctx.store, c) }))
    .filter((x) => x.roles.length > 0);
  const gaps = status.filter((s) => s.status === "under").sort((a, b) => (b.target - b.count) - (a.target - a.count));
  const perRole = gaps.map((s) => pool
    .flatMap(({ c, roles }) => {
      const hit = roles.find((r) => r.role === s.role);
      return hit ? [{ card: c, status: s, tags: hit.tags, affinity: near.get(c.id)?.n ?? 0, nearest: near.get(c.id)?.best ?? null, planScore: fitOf(ctx, c) }] : [];
    })
    .sort((a, b) => b.affinity - a.affinity || (b.nearest?.sim ?? -1) - (a.nearest?.sim ?? -1) || b.planScore - a.planScore ||
      a.card.meta!.cmc - b.card.meta!.cmc || byName(a.card.name, b.card.name))
    .slice(0, PER_ROLE * 4)); // spare picks for cards that fill two gaps
  const used = new Set<string>(), out: Fill[] = [];
  for (let turn = 0; turn < PER_ROLE; turn++) for (const list of perRole) {
    const next = list.find((f) => !used.has(f.card.id));
    if (next) { used.add(next.card.id); out.push(next); }
  }
  return out;
}

// The cut for each fill, chosen by how its roles relate to the deck's targets, never by list position:
//   1. Never undo the fill: a deck card that counts toward the fill's gap role is not a cut for it.
//   2. Never open a gap: a role the swap lowers (the cut counts toward it, the fill does not) must keep a count at or
//      above its target. The counts are tracked across the pairs, so taking every pairing together keeps it true too.
//   3. First choice, a card from an over-target role: the swap lowers one or more roles, every one over target. Among
//      these the least-needed goes first: the biggest surplus (count left minus target) on its tightest lowered role,
//      then the most over-target roles relieved.
//   4. Second choice, a card that costs no role: it counts toward none, or only toward roles the fill also gives.
//   5. Ties: lowest plan score (off plan first), then highest mana value, then name. Each deck card is cut at most once.
// No card passes 1 and 2: the fill stands as an add.
type Pairing = { card: SpaceCard; lowered: RoleStatus[]; roles: string[] };
function pairCuts(ctx: Ctx, list: Fill[], status: RoleStatus[]): (Pairing | null)[] {
  const by = new Map(status.map((s) => [s.role, s]));
  const left = new Map(status.map((s) => [s.role, s.count]));
  const deck = [...new Map(ctx.entries.flatMap((e) => (e.card && !e.card.land && e.card.id !== ctx.commander.id ? [[e.card.id, e.card] as const] : []))).values()]
    .map((card) => ({ card, roles: countedRoles(ctx.store, card).map((r) => r.role), planScore: fitOf(ctx, card) }));
  const used = new Set<string>();
  return list.map((f) => {
    const fillRoles = new Set(countedRoles(ctx.store, f.card).map((r) => r.role));
    const options = deck.flatMap((d) => {
      if (used.has(d.card.id) || d.roles.includes(f.status.role)) return []; // rule 1
      const lowered = d.roles.filter((r) => !fillRoles.has(r)).map((r) => by.get(r)!);
      if (lowered.some((s) => left.get(s.role)! - 1 < s.target)) return []; // rule 2
      const surplus = lowered.length ? Math.min(...lowered.map((s) => left.get(s.role)! - s.target)) : 0;
      return [{ ...d, lowered, surplus }];
    }).sort((a, b) => Number(b.lowered.length > 0) - Number(a.lowered.length > 0) || // rule 3 before rule 4
      b.surplus - a.surplus || b.lowered.length - a.lowered.length ||
      a.planScore - b.planScore || b.card.meta!.cmc - a.card.meta!.cmc || byName(a.card.name, b.card.name)); // rule 5
    const best = options[0];
    if (!best) return null;
    used.add(best.card.id);
    for (const s of best.lowered) left.set(s.role, left.get(s.role)! - 1);
    return { card: best.card, lowered: best.lowered, roles: best.roles };
  });
}

const cutText = (cut: Pairing) => `cut ${cut.card.name}: ${
  cut.lowered.length ? cut.lowered.map((s) => `${s.role} ${s.count} over target ${s.target}`).join(", ")
  : cut.roles.length ? `its roles (${cut.roles.join(", ")}) stay level, the fill gives them too`
  : "counts toward no role"}`;

const fillWhy = (f: Fill, cut: Pairing | null) => [
  `fills ${f.status.role} ${f.status.count} → ${f.status.count + 1} (target ${f.status.target})`,
  `gives it through Tagger tags: ${tagList(f.tags)}`,
  f.nearest ? `in-color neighbor of ${f.affinity} deck card${f.affinity > 1 ? "s" : ""} (nearest: #${f.nearest.rank} of ${f.nearest.from.name}, similarity ${f.nearest.sim.toFixed(3)})`
    : "not a Card Space neighbor of any deck card",
  ...(cut ? [cutText(cut)] : []),
];

export function swapCandidates(store: Store, input: SwapCandidatesInput): SwapCandidatesResult {
  const f = swapCandidatesInput.parse(input);
  const text = readDeck(f);
  const { card: commander } = resolveCommander(store, f.commander);
  const deck = parseDecklist(store.space, text);
  const mask = ciMask(commander.ci);
  if (f.lever === "plan" && f.plan === undefined) {
    throw new ToolInputError("the plan lever scores cards against the player's plan; pass plan (the confirmed themes or priority cards)");
  }
  const plan = planContext(store, commander.name, f.plan);
  const before = swapStats(deckNumbers(store, commander, deck.entries, plan));
  const targets = targetsFor(store, f.targets);
  const ctx: Ctx = {
    store, commander, mask, plan, graph: inColor(store, mask), entries: deck.entries,
    inDeck: new Set(deck.entries.flatMap((e) => (e.card ? [e.card.id] : []))), before, targets,
  };
  const notes: string[] = [];
  let picks: Pick[] = [];
  let card: SpaceCard | null = null;
  if (f.card !== undefined) {
    if (f.lever === "roles" || f.lever === "redundancy") throw new ToolInputError(`the ${f.lever} lever works on the whole deck; leave card out`);
    const r = resolveCard(store, f.card);
    card = store.space.cards.get(store.names[r.id - 1].oracleId)!;
    if (!ctx.inDeck.has(card.id)) throw new ToolInputError(`${card.name} is not in the deck`);
    if (card.land) throw new ToolInputError(`${card.name} is a land; swap candidates cover nonland cards`);
    if (card.id === commander.id) throw new ToolInputError(`${card.name} is the commander`);
    if (f.lever === "budget" && card.meta!.usd === null) notes.push(`${card.name} has no Scryfall price, so no card is cheaper in dollars`);
    picks = picksFor(ctx, card, f.lever, f.limit ?? 5);
  } else if (f.lever === "plan" || f.lever === "cheaper" || f.lever === "budget") {
    picks = deckPicks(ctx, f.lever, f.limit ?? 15);
  }
  const roles = f.lever === "roles" || f.lever === "redundancy" ? roleStatus(store, before.roleCounts, targets) : null;
  let candidates = picks.map((p) => candidate(ctx, p.out, p.in, p.why));
  if (f.lever === "redundancy") {
    const list = cuts(ctx, roles!);
    for (const s of roles!) if (s.status === "over" && !list.some((c) => c.relieves.includes(s))) {
      notes.push(`${s.role} is over target (${s.count} vs ${s.target}), but every card giving it also gives a role that would fall below target`);
    }
    candidates = list.slice(0, f.limit ?? 15).map((c) => candidate(ctx, c.card, null, cutWhy(ctx, c), c.tags));
  }
  if (f.lever === "roles") {
    const list = fills(ctx, roles!).slice(0, f.limit ?? 15);
    const paired = pairCuts(ctx, list, roles!);
    const adds = paired.filter((p) => p === null).length;
    if (adds) notes.push(`${adds} fill${adds > 1 ? "s have" : " has"} no cut that keeps every role at target, so ${adds > 1 ? "they are adds" : "it is an add"} (the deck grows by one each); pick a cut`);
    if (!roles!.some((s) => s.status === "under")) notes.push("no role is under its target");
    candidates = list.map((x, i) => candidate(ctx, paired[i]?.card ?? null, x.card, fillWhy(x, paired[i]), x.tags));
  }
  return {
    commander: { name: commander.name, colorIdentity: commander.ci.join("") },
    lever: f.lever, card: card?.name ?? null, plan: plan?.plan ?? null, before, roles,
    candidates, notes,
    unresolved: unresolvedLines(store, deck.unresolved),
  };
}

// ---------- accept_swap / reject_swap (ISC-24) ----------
// The player's verdicts. accept_swap rewrites the deck file: the outgoing card's line becomes the incoming card's line (or
// loses one copy), every other line is left byte for byte, and a dated `# ...` change-log line is appended (decklist
// parsing skips it). Both tools append one row to the label log, a per-user JSONL file (paths.ts: the repo in development, the plugin data folder when installed; never committed).
// Writes take exact (or front-face) names only: a fuzzy guess must never edit a deck.
export { LABELS_PATH } from "./paths";
import { LABELS_PATH } from "./paths";
export type VerdictOptions = { labelsPath?: string; today?: string }; // tests point these elsewhere; the MCP uses the defaults
export type Label = {
  date: string; verdict: "accept" | "reject"; commander: string; out: string | null; in: string | null;
  lever: Lever | null; deckFile: string | null; note: string | null;
};

const verdictFields = {
  commander: z.string().min(1).describe("The commander's exact name or front-face name"),
  out: z.string().min(1).optional().describe("Exact name of the card leaving the deck (omit for an add)"),
  in: z.string().min(1).optional().describe("Exact name of the card joining the deck (omit for a cut)"),
  lever: z.enum(LEVERS).optional().describe("The lever that proposed the swap, for the label"),
  note: z.string().min(1).max(500).optional().describe("The player's reason, in their words, kept with the label"),
};
export const acceptSwapShape = {
  ...verdictFields,
  deckFile: z.string().min(1).describe("Path to the `1 Card Name` deck file to rewrite, absolute or relative to the project directory"),
};
export const rejectSwapShape = {
  ...verdictFields,
  deckFile: z.string().min(1).optional().describe("The deck file the swap was proposed for, kept with the label (never written)"),
};
const acceptSwapInput = z.object(acceptSwapShape).strict();
const rejectSwapInput = z.object(rejectSwapShape).strict();
export type AcceptSwapInput = z.input<typeof acceptSwapInput>;
export type RejectSwapInput = z.input<typeof rejectSwapInput>;
export type AcceptSwapResult = { deckFile: string; changeLog: string; label: Label; before: SwapStats; after: SwapStats };
export type RejectSwapResult = { label: Label };

const localDate = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in the machine's time zone

function exactCard(store: Store, name: string): SpaceCard {
  const r = resolveCard(store, name);
  const hit = store.names[r.id - 1].name;
  if (r.matchedBy !== "exact" && r.matchedBy !== "face") {
    throw new ToolInputError(`"${name}" is not an exact card name; candidates: ${[hit, ...r.alternatives].join("; ")}`);
  }
  return store.space.cards.get(store.names[r.id - 1].oracleId)!;
}

function pairOf(store: Store, f: { out?: string; in?: string }): { out: SpaceCard | null; inCard: SpaceCard | null } {
  if (f.out === undefined && f.in === undefined) throw new ToolInputError("give out, in or both");
  return { out: f.out !== undefined ? exactCard(store, f.out) : null, inCard: f.in !== undefined ? exactCard(store, f.in) : null };
}

function appendLabel(label: Label, path: string) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(label)}\n`);
}

export function acceptSwap(store: Store, input: AcceptSwapInput, opts: VerdictOptions = {}): AcceptSwapResult {
  const f = acceptSwapInput.parse(input);
  const { card: commander } = resolveCommander(store, f.commander);
  const { out, inCard } = pairOf(store, f);
  const path = deckPath(f.deckFile);
  const text = readDeck({ deckFile: path });
  const deck = parseDecklist(store.space, text);
  const outEntry = out ? deck.entries.find((e) => e.card?.id === out.id) : undefined;
  if (out && !outEntry) throw new ToolInputError(`${out.name} is not in the deck`);
  if (inCard) {
    if (!fitsIdentity(inCard, commander.ci)) throw new ToolInputError(`${inCard.name} is outside the commander's color identity`);
    if (deck.entries.some((e) => e.card?.id === inCard.id) && !/\bBasic\b/.test(inCard.meta!.type)) throw new ToolInputError(`${inCard.name} is already in the deck`);
  }

  // edit by line: entries carry their 1-based line number in the text split on \n (a \r stays on its line)
  const hadFinalNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (hadFinalNewline) lines.pop();
  const cr = text.includes("\r\n") ? "\r" : "";
  const inLine = inCard ? `1 ${inCard.name}${cr}` : null;
  if (outEntry) {
    const i = outEntry.line - 1;
    const rest = outEntry.qty > 1 ? [lines[i].replace(/^(\s*)(\d+)/, (_, sp: string, q: string) => `${sp}${+q - 1}`)] : [];
    lines.splice(i, 1, ...rest, ...(inLine ? [inLine] : []));
  } else {
    const last = Math.max(0, ...deck.entries.map((e) => e.line));
    lines.splice(last, 0, inLine!);
  }
  const date = opts.today ?? localDate();
  const changeLog = `# ${date} accepted swap${f.lever ? ` (${f.lever})` : ""}: ${[out && `-1 ${out.name}`, inCard && `+1 ${inCard.name}`].filter(Boolean).join(", ")}`;
  lines.push(`${changeLog}${cr}`);
  const next = lines.join("\n") + (hadFinalNewline ? "\n" : "");

  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, path);
  const label: Label = { date, verdict: "accept", commander: commander.name, out: out?.name ?? null, in: inCard?.name ?? null, lever: f.lever ?? null, deckFile: f.deckFile, note: f.note ?? null };
  appendLabel(label, opts.labelsPath ?? LABELS_PATH);
  return {
    deckFile: path, changeLog, label,
    before: swapStats(deckNumbers(store, commander, deck.entries)),
    after: swapStats(deckNumbers(store, commander, parseDecklist(store.space, next).entries)),
  };
}

export function rejectSwap(store: Store, input: RejectSwapInput, opts: VerdictOptions = {}): RejectSwapResult {
  const f = rejectSwapInput.parse(input);
  const { card: commander } = resolveCommander(store, f.commander);
  const { out, inCard } = pairOf(store, f);
  const label: Label = {
    date: opts.today ?? localDate(), verdict: "reject", commander: commander.name, out: out?.name ?? null, in: inCard?.name ?? null,
    lever: f.lever ?? null, deckFile: f.deckFile ?? null, note: f.note ?? null,
  };
  appendLabel(label, opts.labelsPath ?? LABELS_PATH);
  return { label };
}
