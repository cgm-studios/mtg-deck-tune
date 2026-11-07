// Strategy profiles, ported from mtg-graph-api src/strategy.ts (branch rework/ts-card-graph; its ISA F4): a theme name
// such as "Tokens" or "Aristocrats" becomes a hook profile, mined from the commanders' EDHREC data. The graph read the
// commander pages from a sibling checkout; this port reads the same facts from the card store (commanders,
// commander_themes, themes, commander_cards), so an installed plugin needs nothing else.
//
// How it is mined (unchanged from the graph):
//   1. Each commander gives its deck count, its EDHREC theme tags with deck counts, and its recommended cards with a
//      synergy score (how much more often this commander's decks run the card than other decks in its colors). A deck
//      can carry several tags, so a theme's share of a commander is its tag count over the commander's total tag
//      mentions (every tag count added up), not over a count of tagged decks.
//   2. A theme's commanders are those where the theme is at least `minShare` of the tag mentions and at least
//      `minThemeDecks` decks. Each counts with weight = that share. Fewer than `minCommanders` of them and the theme is
//      refused (ThinThemeError): a handful of commanders is those commanders' decks, not the theme.
//   3. Within a commander a card counts with weight = its synergy, when positive and seen in at least `minCardDecks`
//      decks. Staples have synergy near zero, so what is left is what that commander's decks do.
//   4. Every card is reduced to the hooks it makes (its effects and paid costs, through closure) and the hooks it spends
//      (its triggers and replacements, and the cost a consumes pays). What a card does just by being cast or entering is
//      left out, and so are the hooks a profile never carries (`offProfile`: mana, keywords).
//   5. For each (hook, side), T = the share of the theme's weighted card mass that carries it, B = the same share over
//      every commander's cards pooled, each weighted by its synergy. A hook enters the profile when T / B >= `minLift`
//      and at least `minCards` different cards carry it, with score T * ln(T / B), spread over the cards that carried
//      it, so the profile's evidence lists the theme's heaviest cards for that hook.
// What changed in the port: the data source; pages in the graph's file-name order (slug + ".json"), cards within a
// commander in store id order (float sums can differ in the last bits, below the 3-place rounding); names sort by byte
// order; a miss lists the closest themes by edit distance, not substring only; refusals are typed errors the tools
// return as tool errors (UnknownThemeError, ThinThemeError).
import type { Database } from "bun:sqlite";
import { editDistance, ToolInputError } from "../deck-tools";
import type { Graph } from "./store-graph";
import { byteOrder, normalizeProfile, offProfile, type HookProfile, type ProfileEntry } from "./profile";

export interface StrategyOptions {
  /** A commander joins the theme when the theme is at least this share of its tag mentions. */
  minShare?: number;
  /** ...and at least this many of its decks carry the tag. */
  minThemeDecks?: number;
  /** A recommended card counts only when at least this many of the commander's decks run it. */
  minCardDecks?: number;
  /** A hook enters the profile only when the theme carries it at least this many times as often as all commanders do. */
  minLift?: number;
  /** A hook enters the profile only when at least this many different cards carry it in the theme. */
  minCards?: number;
  /** A theme needs at least this many qualifying commanders, or it is refused (the graph's judgment call: 10). */
  minCommanders?: number;
  /** Hooks kept in the profile. */
  top?: number;
  /** Evidence cards kept per hook and side. */
  evidence?: number;
}

export const STRATEGY_DEFAULTS = { minShare: 0.15, minThemeDecks: 20, minCardDecks: 3, minLift: 1.25, minCards: 3, minCommanders: 10, top: 25, evidence: 12 } as const;

/** An EDHREC theme, as listed by `listThemes`. */
export interface Theme {
  slug: string;
  name: string;
  /** Decks carrying the tag across every commander. */
  decks: number;
  /** Commanders that list the tag at all. */
  commanders: number;
  /** Commanders that pass the default selection, so `strategyProfile` with defaults uses this many. */
  qualifying: number;
  /** `qualifying` reaches `minCommanders`: `strategyProfile` builds this theme rather than refuse it. */
  usable: boolean;
}

/** A theme name the data does not know (ISA ISC-43). `closest` holds the nearest known theme names, closest first. */
export class UnknownThemeError extends ToolInputError {
  constructor(readonly theme: string, readonly closest: string[]) {
    super(`no theme named "${theme}" in the commander data${closest.length ? `; closest known themes: ${closest.join(", ")}` : ""}`);
  }
}

/**
 * A theme the data knows but cannot profile: too few commanders play it as a main theme, or their cards carry no hook
 * that stands out (ISA ISC-77). `commanders` is how many commanders qualified. The skill answers this case by asking
 * the player for a few keystone cards and building a priority-card plan from them (ISC-78).
 */
export class ThinThemeError extends ToolInputError {
  constructor(readonly theme: string, readonly commanders: number, detail: string) {
    super(`the theme "${theme}" is known but has too little data to build a profile: ${detail}; ` +
      "name a few keystone cards of the deck instead and plan from those");
  }
}

export interface Page { cardId: number; slug: string; name: string; decks: number; tagMentions: number; tags: Map<string, number> }
interface Pages { pages: Page[]; themeNames: Map<string, string> }

const PAGES = new WeakMap<Database, Pages>();

function loadPages(db: Database): Pages {
  const hit = PAGES.get(db);
  if (hit) return hit;
  const rows = db.query(`SELECT cm.card_id, cm.edhrec_slug, cm.decks, c.name FROM commanders cm JOIN cards c ON c.id = cm.card_id
    WHERE cm.decks > 0`).all() as { card_id: number; edhrec_slug: string; decks: number; name: string }[];
  // The graph read the page files in sorted file-name order; keep it, so float sums add up in the same order.
  rows.sort((a, b) => byteOrder(`${a.edhrec_slug}.json`, `${b.edhrec_slug}.json`));
  const pages: Page[] = rows.map((r) => ({ cardId: r.card_id, slug: r.edhrec_slug, name: r.name, decks: r.decks, tagMentions: 0, tags: new Map() }));
  if (!pages.length) throw new Error("the card store has no commander data (commanders is empty)");
  const byId = new Map(pages.map((p) => [p.cardId, p]));
  for (const t of db.query(`SELECT ct.commander_id, t.slug, ct.decks FROM commander_themes ct JOIN themes t ON t.id = ct.theme_id
    WHERE ct.decks > 0 ORDER BY ct.commander_id, t.slug`).all() as { commander_id: number; slug: string; decks: number }[]) {
    const p = byId.get(t.commander_id);
    if (!p) continue; // a commander with no decks: never chosen, and the graph skipped its page too
    p.tags.set(t.slug, t.decks);
    p.tagMentions += t.decks;
  }
  const themeNames = new Map((db.query("SELECT slug, name FROM themes ORDER BY slug").all() as { slug: string; name: string }[]).map((t) => [t.slug, t.name]));
  const out = { pages, themeNames };
  PAGES.set(db, out);
  return out;
}

/** A theme's share of a commander: its tag count over all the commander's tag counts added up. */
export const share = (p: Page, slug: string) => (p.tagMentions ? (p.tags.get(slug) ?? 0) / p.tagMentions : 0);

function qualifies(p: Page, slug: string, minShare: number, minThemeDecks: number): boolean {
  return (p.tags.get(slug) ?? 0) >= minThemeDecks && share(p, slug) >= minShare;
}

/** Slug form of a theme name: "+1/+1 Counters" and "plus-1-plus-1-counters" meet. */
export function themeSlug(s: string): string {
  return s.toLowerCase().replace(/\+/g, " plus ").replace(/-/g, " minus ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Every EDHREC theme in the store, most decks first, with how many commanders the default selection would use. */
export function listThemes(db: Database, opts: Pick<StrategyOptions, "minShare" | "minThemeDecks" | "minCommanders"> = {}): Theme[] {
  const { pages, themeNames } = loadPages(db);
  const minShare = opts.minShare ?? STRATEGY_DEFAULTS.minShare, minThemeDecks = opts.minThemeDecks ?? STRATEGY_DEFAULTS.minThemeDecks;
  const minCommanders = opts.minCommanders ?? STRATEGY_DEFAULTS.minCommanders;
  const by = new Map<string, Theme>();
  for (const p of pages) for (const [slug, count] of p.tags) {
    const t = by.get(slug) ?? by.set(slug, { slug, name: themeNames.get(slug) ?? slug, decks: 0, commanders: 0, qualifying: 0, usable: false }).get(slug)!;
    t.decks += count;
    t.commanders++;
    if (qualifies(p, slug, minShare, minThemeDecks)) t.qualifying++;
  }
  for (const t of by.values()) t.usable = t.qualifying >= minCommanders;
  return [...by.values()].sort((a, b) => b.decks - a.decks || byteOrder(a.slug, b.slug));
}

/** Up to five known theme names closest to `theme`: fewest edits between slugs, a slug containing the other first among
 * equals, then the theme with more decks, then by name. Only themes within a third of the name's length in edits, or
 * one slug containing the other, are offered. */
function closestThemes(db: Database, theme: string): string[] {
  const want = themeSlug(theme);
  const budget = Math.max(2, Math.floor(want.length / 3));
  return listThemes(db)
    .map((t) => ({ t, d: editDistance(want, t.slug), sub: !!want && (t.slug.includes(want) || want.includes(t.slug)) }))
    .filter((x) => x.d <= budget || x.sub)
    .sort((a, b) => a.d - b.d || Number(b.sub) - Number(a.sub) || b.t.decks - a.t.decks || byteOrder(a.t.name, b.t.name))
    .slice(0, 5)
    .map((x) => x.t.name);
}

/** The slug of a theme named by slug or display name, in any case. Throws UnknownThemeError with the closest themes. */
export function resolveTheme(db: Database, theme: string): string {
  const data = loadPages(db);
  const want = themeSlug(theme);
  if (!want) throw new ToolInputError("a theme name is empty");
  for (const [slug, name] of data.themeNames) if (slug === want || themeSlug(name) === want || themeSlug(slug) === want) return slug;
  throw new UnknownThemeError(theme, closestThemes(db, theme));
}

/** The commanders a theme is mined from: each with its share of the theme. Throws ThinThemeError under `minCommanders`. */
export function themeCommanders(db: Database, theme: string, opts: StrategyOptions = {}): { slug: string; name: string; chosen: { page: Page; share: number }[] } {
  const o = { ...STRATEGY_DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const data = loadPages(db);
  const slug = resolveTheme(db, theme);
  const name = data.themeNames.get(slug) ?? slug;
  const chosen = data.pages.filter((p) => qualifies(p, slug, o.minShare, o.minThemeDecks));
  if (chosen.length < Math.max(1, o.minCommanders)) {
    const rule = `at least ${o.minShare} of their theme tags and ${o.minThemeDecks}+ decks`;
    if (!chosen.length) {
      const best = data.pages.filter((p) => p.tags.has(slug)).sort((a, b) => share(b, slug) - share(a, slug) || byteOrder(a.slug, b.slug))[0];
      throw new ThinThemeError(name, 0, `0 commanders play it as a main theme (${rule}; ${o.minCommanders} needed)` +
        (best ? `; the most devoted is ${best.name}, ${best.tags.get(slug)} decks, share ${share(best, slug).toFixed(2)}` : ""));
    }
    throw new ThinThemeError(name, chosen.length, `only ${chosen.length} commander${chosen.length === 1 ? "" : "s"} play it as a main theme ` +
      `(${rule}; ${o.minCommanders} needed): ${chosen.map((p) => p.name).join("; ")}`);
  }
  return { slug, name, chosen: chosen.map((page) => ({ page, share: share(page, slug) })) };
}

type Side = ProfileEntry["side"];

/** Each card's strategy-lane hook keys ("makes|Dies"), per index position, read from the index's own emit and listen
 * tables so the profile speaks the same hooks the links do. */
const FACTS = new WeakMap<Graph, string[][]>();
function cardFacts(graph: Graph): string[][] {
  const hit = FACTS.get(graph);
  if (hit) return hit;
  const idx = graph.index;
  const keys = idx.cards.map((_, i) => {
    const out = new Set<string>();
    for (const e of idx.emitsOf(i)) if (e.by !== "card" && !offProfile(e.hook)) out.add(`makes|${e.hook}`);
    for (const l of idx.listensOf(i)) {
      const hook = l.listener === "consumes" ? (l.consumed ?? l.hook) : l.hook;
      if (!offProfile(hook)) out.add(`spends|${hook}`);
    }
    return [...out].sort();
  });
  FACTS.set(graph, keys);
  return keys;
}

/** One card's strategy-lane hook keys, sorted, by store card id; empty for a card the graph could not translate. */
export function strategyFacts(graph: Graph, cardId: number): string[] {
  const i = graph.positionOf.get(cardId);
  return i === undefined ? [] : cardFacts(graph)[i];
}

/** One commander's counted cards: index position and weight (positive synergy). */
type Weighted = [card: number, weight: number][];
interface Mined { weighted: Map<string, Weighted>; baseline: Map<string, number>; baselineMass: number }
const MINED = new WeakMap<Graph, Map<number, Mined>>();

/** Each commander's weighted cards and the all-commander baseline, once per graph and minCardDecks. */
function mined(db: Database, graph: Graph, minCardDecks: number): Mined {
  const per = MINED.get(graph) ?? MINED.set(graph, new Map()).get(graph)!;
  const hit = per.get(minCardDecks);
  if (hit) return hit;
  const { pages } = loadPages(db);
  const facts = cardFacts(graph);
  const rows = new Map<number, [number, number][]>();
  for (const r of db.query(`SELECT commander_id, card_id, synergy FROM commander_cards WHERE synergy > 0 AND decks >= ?
    ORDER BY commander_id, card_id`).all(minCardDecks) as { commander_id: number; card_id: number; synergy: number }[]) {
    const i = graph.positionOf.get(r.card_id);
    if (i === undefined) continue; // a card the graph could not translate: skipped, as the graph skipped names it did not know
    (rows.get(r.commander_id) ?? rows.set(r.commander_id, []).get(r.commander_id)!).push([i, r.synergy]);
  }
  const weighted = new Map<string, Weighted>();
  const baseline = new Map<string, number>();
  let baselineMass = 0;
  for (const p of pages) {
    const w: Weighted = rows.get(p.cardId) ?? [];
    for (const [i, s] of w) {
      baselineMass += s;
      for (const k of facts[i]) baseline.set(k, (baseline.get(k) ?? 0) + s);
    }
    weighted.set(p.slug, w);
  }
  const out = { weighted, baseline, baselineMass };
  per.set(minCardDecks, out);
  return out;
}

/** A named strategy's hook profile, mined from the commanders' EDHREC data in the store. Deterministic for one store. */
export function strategyProfile(db: Database, graph: Graph, theme: string, opts: StrategyOptions = {}): HookProfile {
  const o = { ...STRATEGY_DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  if (!(o.minLift > 1)) throw new Error(`minLift must be above 1 (got ${o.minLift})`);
  const { name, chosen } = themeCommanders(db, theme, o);
  const m = mined(db, graph, o.minCardDecks);
  const keys = cardFacts(graph);
  const idx = graph.index;

  // T per (hook, side), with each card's contribution kept for the evidence lists.
  const mass = new Map<string, number>();
  const byCard = new Map<string, Map<number, number>>();
  let total = 0;
  for (const { page, share: a } of chosen) {
    for (const [i, w] of m.weighted.get(page.slug) ?? []) {
      const x = a * w;
      total += x;
      for (const k of keys[i]) {
        mass.set(k, (mass.get(k) ?? 0) + x);
        const cards = byCard.get(k) ?? byCard.set(k, new Map()).get(k)!;
        cards.set(i, (cards.get(i) ?? 0) + x);
      }
    }
  }
  if (!(total > 0)) throw new ThinThemeError(name, chosen.length, `the ${chosen.length} commanders that play it have no positive-synergy cards in the card graph`);

  const entries: ProfileEntry[] = [];
  for (const [k, tMass] of [...mass.entries()].sort((a, b) => byteOrder(a[0], b[0]))) {
    const t = tMass / total, b = (m.baseline.get(k) ?? 0) / m.baselineMass;
    // b is never 0 here: the chosen commanders are part of the baseline, so any hook they carry is in it.
    const lift = t / b;
    if (!(lift >= o.minLift) || byCard.get(k)!.size < o.minCards) continue;
    const score = t * Math.log(lift);
    const [side, hook] = k.split("|") as [Side, string];
    const top = [...byCard.get(k)!.entries()].sort((x, y) => y[1] - x[1] || byteOrder(idx.cards[x[0]].name, idx.cards[y[0]].name)).slice(0, o.evidence);
    const kept = top.reduce((s, [, c]) => s + c, 0);
    for (const [i, c] of top) entries.push({ hook, side, weight: (score * c) / kept, card: idx.cards[i].name });
  }
  if (!entries.length) throw new ThinThemeError(name, chosen.length, `no hook carried by ${o.minCards}+ of its cards is at least ${o.minLift}x as common there as across all commanders`);
  // A theme's profile is a sample of what such decks do, not a closed plan, so unmade/unspent gaps are not flagged.
  return normalizeProfile({ kind: "strategy", theme: name, commanders: chosen.length }, entries, { top: o.top, gaps: false });
}

