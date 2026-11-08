// DT-6.16: what a session sees. The tool functions return their full results (tests, and every other caller, read
// those); the MCP returns them through these views, which keep every fact a reply needs and drop repetition and detail
// nobody read: text said once instead of once per card, link lists counted instead of spelled out, numbers that follow
// from others left out, a long list of same-shaped records as a table (`columns` named once, then one row per record).
// Each view is a pure function of the full result, so the same deck, plan and inputs still give the same answer byte
// for byte (ISA Constraints), and `detail: true` on a tool returns the full result itself, so nothing is out of reach
// (mcp.ts says how in each tool's description). accept_swap and reject_swap answer with receipts of at most 300
// characters (ISC-103).

import { basename } from "node:path";
import { z } from "zod";
import type { CardFact, CardResult, DeckStats, FindCardsResult, FoundCard } from "./deck-tools";
import type { DiagnoseResult } from "./diagnose";
import type { ShortlistCard, ShortlistLink, ShortlistResult } from "./shortlist";
import type { AcceptSwapResult, Candidate, RejectSwapResult, StatsDelta, SwapCandidatesResult } from "./swap-tools";

export const detailFlag = z.boolean().optional().describe("true = the full result, every field (see the tool description for what the default leaves out)");

// ---------- tables ----------
/** Records as a table: the column names once, then each record's values in column order (null where a record has none). */
export type Table = { columns: string[]; rows: unknown[][] };
export function table<T extends object>(columns: readonly (keyof T & string)[], records: T[]): Table {
  return { columns: [...columns], rows: records.map((r) => columns.map((c) => (r[c] === undefined ? null : r[c]))) };
}

// ---------- find_cards and card ----------
const FOUND_COLUMNS = ["name", "manaCost", "manaValue", "typeLine", "colorIdentity", "power", "toughness", "keywords", "usd"] as const;

/** The page as a table with every field of every card (oracleText last, when asked for). */
export function compactFindCards(r: FindCardsResult) {
  const columns: (keyof FoundCard)[] = [...FOUND_COLUMNS, ...(r.cards.some((c) => c.oracleText !== undefined) ? ["oracleText" as const] : [])];
  return { total: r.total, offset: r.offset, cards: table(columns, r.cards) };
}

/** One card's printed facts, its Tagger tag labels and its role names; the store ids, the type line split into parts, tag
 * weights and the tags behind each role are in the full result. A field with nothing in it (no power on a sorcery, no
 * keywords) drops. */
export function compactCard(r: CardResult) {
  const c = r.card;
  return {
    matchedBy: r.matchedBy, ...(r.alternatives.length && { alternatives: r.alternatives }),
    card: {
      name: c.name, manaCost: c.manaCost, manaValue: c.manaValue, typeLine: c.typeLine, oracleText: c.oracleText,
      ...(c.power !== null && { power: c.power, toughness: c.toughness }), ...(c.keywords.length && { keywords: c.keywords }),
      colorIdentity: c.colorIdentity, usd: c.usd, tags: c.tags.map((t) => t.label), roles: c.roles.map((h) => h.role),
      ...(c.incidentalRoles.length && { incidentalRoles: c.incidentalRoles.map((h) => h.role) }),
    },
  };
}

// ---------- card facts (ISC-92) ----------
const FACT_COLUMNS = ["name", "manaValue", "typeLine", "oracleText"] as const;
export const cardFactsTable = (facts: CardFact[]) => table<CardFact>(FACT_COLUMNS, facts);

// ---------- deck_stats ----------
// The deck's numbers; its card facts only when asked (`cardFacts: true`, here or on diagnose), so a session gets every
// card's rules text once, when it asks, and not again on each later deck_stats or diagnose call.

export function compactDeckStats(r: DeckStats, opts: { cardFacts?: boolean }) {
  const { cardFacts, ...rest } = r;
  return opts.cardFacts ? { ...rest, cardFacts: cardFactsTable(cardFacts) } : rest;
}

// ---------- diagnose ----------
// Each role's count and target once (over and under name the roles), the words for where targets come from once per
// source, an off-plan or unread reason once for all the cards it covers, the links table and the card facts as tables.
// Per off-plan card, what it makes happen and its strongest tags are in the full result (its rules text is in
// cardFacts); per card of the links table, its roles are in deck_stats.

/** Items grouped by a shared string, groups in order of first appearance, items in their order. */
function groupBy<T, U>(items: T[], key: (t: T) => string, item: (t: T) => U): { key: string; items: U[] }[] {
  const groups = new Map<string, U[]>();
  for (const t of items) {
    const k = key(t);
    const g = groups.get(k);
    if (g) g.push(item(t));
    else groups.set(k, [item(t)]);
  }
  return [...groups].map(([k, v]) => ({ key: k, items: v }));
}

export function compactDiagnosis(r: DiagnoseResult, opts: { cardFacts?: boolean }) {
  return {
    commander: r.commander,
    plan: r.plan,
    engineGaps: r.engineGaps,
    roles: r.roles.map(({ basis: _, ...role }) => role),
    targetBasis: Object.fromEntries(groupBy(r.roles, (x) => x.basis, (x) => x.role).map((g) => [g.key, g.items])),
    over: r.over.map((o) => ({ role: o.role, trims: o.trims })),
    under: r.under.map((u) => u.role),
    offPlan: groupBy(r.offPlan, (o) => o.reason, (o) => ({ name: o.name, roles: o.roles, ...(o.fitsAvoided.length && { fitsAvoided: o.fitsAvoided }) }))
      .map((g) => ({ reason: g.key, cards: g.items })),
    doingLeast: r.doingLeast,
    unread: groupBy(r.unread, (u) => u.reason, (u) => u.name).map((g) => ({ reason: g.key, cards: g.items })),
    cards: table(["name", "partners", "bucket", "reason"], r.cards),
    lowPartners: r.lowPartners,
    noGraphData: r.noGraphData,
    ...(opts.cardFacts && { cardFacts: cardFactsTable(r.cardFacts) }),
    unresolved: r.unresolved,
  };
}

// ---------- shortlist and swap_candidates ----------
/** The numbers a swap or an add moves that a reply quotes: average mana value, plan fit and role counts. The card count,
 * curve and pip changes follow from the card itself and are in the full result. */
const deltaOf = (d: StatsDelta) => ({ averageManaValue: d.averageManaValue, onPlan: d.onPlan, roleCounts: d.roleCounts });

/** A card's links into the deck counted by event, in words ("feeds 3 on drawing a card; fed by 10 on ..."); null when none count. */
const linkWords = (links: ShortlistLink[]) => links.length
  ? links.map((l) => [l.feeds.length && `feeds ${l.feeds.length}`, l.fedBy.length && `fed by ${l.fedBy.length}`].filter(Boolean).join(" and ") + ` on ${l.on}`).join("; ")
  : null;

const SHORTLIST_COLUMNS = [
  "name", "manaValue", "usd", "typeLine", "roles", "labels", "commanderSynergy", "taggerFit", "edhrecRank", "partners", "planPartners",
  "planFit", "priorityLinks", "feeds", "links", "genericLinks", "noLinks", "delta", "after", "planGain",
] as const;
type ShortlistRow = Record<(typeof SHORTLIST_COLUMNS)[number], unknown>;

/** The shortlist's cards as a table: the evidence flattened into columns, the plan fit as its score (what matched is in
 * the full result), links counted by event (the deck cards on each are in the full result). `feeds` (an engine gap's
 * payoffs) and `noLinks` show when some card has them; `after` and `planGain` when the call names a card to swap out. */
export function compactShortlist(r: ShortlistResult) {
  const rows: ShortlistRow[] = r.cards.map((c: ShortlistCard) => ({
    name: c.name, manaValue: c.manaValue, usd: c.usd, typeLine: c.typeLine, roles: c.roles, labels: c.labels,
    commanderSynergy: c.evidence.commanderSynergy, taggerFit: c.evidence.taggerFit, edhrecRank: c.evidence.edhrecRank,
    partners: c.evidence.partners, planPartners: c.evidence.planPartners, planFit: c.evidence.planFit.score,
    priorityLinks: c.evidence.priorityLinks, feeds: c.evidence.feeds, links: linkWords(c.links), genericLinks: c.genericLinks,
    noLinks: c.noLinks, delta: deltaOf(c.delta), after: c.after, planGain: c.planGain,
  }));
  const swap = r.out !== null;
  const columns = SHORTLIST_COLUMNS.filter((col) =>
    col === "after" || col === "planGain" ? swap : col === "feeds" || col === "noLinks" ? rows.some((x) => x[col] !== undefined) : true);
  return { ...r, cards: table(columns, rows) };
}

/** A candidate with its reason (which states the evidence in words), the average mana value and plan fit after (the
 * change is the difference from `before`), and the role counts it moves (when it moves some); the evidence numbers and the
 * rest of the numbers after are in the full result. Role drops show only when there are some. */
function compactCandidate(c: Candidate) {
  return {
    out: c.out, in: c.in, reason: c.reason,
    after: { averageManaValue: c.after.averageManaValue, onPlan: c.after.onPlan },
    ...(Object.keys(c.delta.roleCounts).length && { delta: { roleCounts: c.delta.roleCounts } }),
    ...(c.roleDrops.length && { roleDrops: c.roleDrops }), ...(c.rolesBelowTarget.length && { rolesBelowTarget: c.rolesBelowTarget }),
  };
}

export const compactSwapCandidates = (r: SwapCandidatesResult) => ({ ...r, candidates: r.candidates.map(compactCandidate) });

// ---------- receipts (ISC-103) ----------
export const RECEIPT_MAX = 300;

export type AcceptReceipt = { verdict: "accept"; file: string; changeLog: string; changed: Record<string, [number, number]> };
export type RejectReceipt = { verdict: "reject"; out?: string; in?: string; lever?: string };

/**
 * What an accept changed, in at most 300 characters: the change-log line written to the deck file (the date, the lever
 * and the swap itself), the file's name, and the deck numbers that moved (average mana value, then each role count, as
 * [before, after]). Over the limit, the numbers go first (last role first), then the file name keeps its end; the
 * change-log line always stays (two of the longest card names leave room for it).
 */
export function acceptReceipt(r: AcceptSwapResult): AcceptReceipt {
  const changed: [string, [number, number]][] = [];
  if (r.before.averageManaValue !== r.after.averageManaValue) changed.push(["averageManaValue", [r.before.averageManaValue, r.after.averageManaValue]]);
  for (const role of Object.keys(r.after.roleCounts)) {
    const was = r.before.roleCounts[role] ?? 0, is = r.after.roleCounts[role];
    if (was !== is) changed.push([role, [was, is]]);
  }
  const build = (file: string, n: number): AcceptReceipt => ({ verdict: "accept", file, changeLog: r.changeLog, changed: Object.fromEntries(changed.slice(0, n)) });
  const size = (x: AcceptReceipt) => JSON.stringify(x).length;
  const file = basename(r.deckFile);
  for (let n = changed.length; n >= 0; n--) if (size(build(file, n)) <= RECEIPT_MAX) return build(file, n);
  const chars = [...file];
  for (let keep = chars.length - 1; keep >= 1; keep--) {
    const short = build(`…${chars.slice(-keep).join("")}`, 0);
    if (size(short) <= RECEIPT_MAX) return short;
  }
  throw new Error(`accept receipt: the change-log line alone is over ${RECEIPT_MAX} characters: ${r.changeLog}`);
}

/** What a reject logged: the verdict and the pair, with the lever when the call named one (the note stays in the label file). */
export function rejectReceipt(r: RejectSwapResult): RejectReceipt {
  const l = r.label;
  return { verdict: "reject", ...(l.out !== null && { out: l.out }), ...(l.in !== null && { in: l.in }), ...(l.lever !== null && { lever: l.lever }) };
}
