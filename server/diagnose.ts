// DT-6.4: the diagnose tool (ISA ISC-41, 45.1, 49 to 56). The deck measured against the player's confirmed plan, from
// the card store alone: engine gaps from the card graph, roles over and under targets shaped by the plan, cards off the
// plan, the cards doing the least with their links into the deck, and the cards the graph cannot read. The engine rules
// are the graph repo's (graph/diagnose.ts, ported); the plan side is new here.

import { z } from "zod";
import { readDeck, resolveCommander, ToolInputError, unresolvedLines, type DeckStats, type Store } from "./deck-tools";
import { parseDecklist } from "./deck-pool";
import { deckGraph, type DeckEntry } from "./graph/deck";
import { deckContext, diagnose as graphDiagnose, hookPhrase, worksThroughStatic, type Bucket } from "./graph/diagnose";
import { isMainHook, parseProfileHook } from "./graph/profile";
import { graphOf } from "./graph/store-graph";
import { STRATEGY_DEFAULTS, strategyFacts, themeCommanders } from "./graph/strategy";
import { planShape } from "./plan-input";
import { planEcho, planScorer, resolvePlan, strongestTags, type PlanEcho, type PlanProfile, type ResolvedPlan } from "./plan";
import { roleSheet, rolesOf } from "./roles";
import { loadTargets } from "./swap-tools";

export const diagnoseShape = {
  commander: z.string().min(1).describe("The commander's exact name or front-face name (case and punctuation ignored)"),
  deckFile: z.string().min(1).optional().describe("Path to a `1 Card Name` decklist file, absolute or relative to the project directory (e.g. decks/namor.txt)"),
  decklist: z.string().min(1).optional().describe("The decklist text itself, `1 Card Name` per line; give this or deckFile"),
  plan: planShape.describe("The player's confirmed plan (themes, priority cards, themes to avoid): the diagnosis is measured against it"),
};
const diagnoseInput = z.object(diagnoseShape).strict();
export type DiagnoseInput = z.input<typeof diagnoseInput>;

/** An engine whose payoffs outnumber the cards that feed them. */
export type EngineGap = {
  /** What the payoffs wait on, in a player's words ("a creature dying"). */
  mechanic: string;
  payoffCount: number;
  enablerCount: number;
  /** Deck cards that pay off on it. */
  payoffs: string[];
  /** Deck cards that make it happen for at least one payoff. */
  enablers: string[];
  /** In-color cards outside the deck that would feed at least two of the payoffs, most fed first; `everyTurn` when it can do so again and again. */
  toTry: { name: string; feeds: string[]; everyTurn: boolean }[];
  /** Payoffs that are loosely linked only because this gap starves them: the gap is the problem, not the card. */
  waitingOnIt: string[];
};

/** One link between a deck card and another deck card. */
export type DeckLink = {
  card: string;
  direction: "feeds" | "fed by";
  /** The event they meet on, in a player's words. */
  on: string;
  /** Made just by being cast or entering, into a card that takes a third of all cards that way: any card would make it, so it is no engine partner. */
  generic: boolean;
};

/** One nonland card of the deck as the engine reads it. */
export type EngineRead = {
  name: string;
  /** Distinct deck cards it links to over links that count (not generic, not mana or keyword grants). */
  partners: number;
  roles: string[];
  /** commander; core (well linked, has a role); engine (well linked, no role); utility (loosely linked, but a role or mana);
   * starved (loosely linked because it pays off on an engine gap); unread (loosely linked, works through a static effect);
   * cut (loosely linked, roleless, none of the above). */
  bucket: Bucket;
  reason?: string;
};

/** One role against its target. */
export type RoleRead = {
  role: string;
  /** Copies of nonland cards holding the role, as deck_stats counts them. */
  count: number;
  target: number;
  /** "plan": the plan's theme decks set the target; "default": the default table did. */
  source: "plan" | "default";
  /** Where the target came from, in words. */
  basis: string;
  /** With a plan source: how many of this deck's nonland cards the theme decks would give the role (one decimal). */
  expected?: number;
};

/** A card in the deck with no hook or tag in the plan's profile. */
export type OffPlanCard = {
  name: string;
  reason: string;
  /** What the card makes happen and waits on, as the card graph reads it (none for a card it could not read). */
  does: string[];
  /** Its strongest Tagger tags. */
  tags: string[];
  /** The deck roles it holds: an off-plan card with a role (removal, ramp) is a role slot, not dead weight. */
  roles: string[];
  /** Avoided themes whose profile the card does fit. */
  fitsAvoided: string[];
};

export type DiagnoseResult = {
  commander: { name: string; colorIdentity: string };
  /** The plan as resolved, and what it leans on: the main hooks and tags of its profiles, the ones off-plan cards lack. */
  plan: PlanEcho & { leansOn: { hooks: string[]; tags: string[] } };
  engineGaps: EngineGap[];
  /** Every role, in the role map's order. */
  roles: RoleRead[];
  /** Roles above target, with the role's own cards as trims, fewest links into the deck first. */
  over: (RoleRead & { trims: { name: string; partners: number; /** Works through a static effect, so its partners undercount it. */ unread?: true }[] })[];
  /** Roles below target. */
  under: RoleRead[];
  /** Nonland cards other than the commander with no hook or tag in the plan's profile. */
  offPlan: OffPlanCard[];
  /** The cards doing the least: roleless, not the commander, at or below the lower quartile of partners, and none of
   * unread, starved or mana-only; each with every link it has into the deck. */
  doingLeast: { name: string; partners: number; links: DeckLink[]; reason: string }[];
  /** Every nonland card working through a static effect on other cards (a lord, an anthem, a keyword grant, a cost or
   * trigger change), which the graph does not link: never judged by its links, whatever its bucket. */
  unread: { name: string; reason: string }[];
  /** Every nonland card, most partners first. */
  cards: EngineRead[];
  /** The lower quartile of partners among nonland cards other than the commander: at or below it is loosely linked. */
  lowPartners: number;
  /** Cards the card graph could not read at all (no card script): in the role counts, outside every engine reading. */
  noGraphData: string[];
  unresolved: DeckStats["unresolved"];
};

export function diagnose(store: Store, input: DiagnoseInput): DiagnoseResult {
  const f = diagnoseInput.parse(input);
  const text = readDeck(f);
  const { card: commander } = resolveCommander(store, f.commander);
  const plan = resolvePlan(store, { commander: commander.name, plan: f.plan });
  const graph = graphOf(store.db);
  const idx = graph.index;
  const deck = parseDecklist(store.space, text);

  // The deck as graph members, by the index's own spelling; a card the graph could not translate has no position.
  const idOf = new Map(store.names.map((n) => [n.oracleId, n.id]));
  const counts = new Map<number, number>();
  const noGraphData = new Set<string>();
  for (const e of deck.entries) {
    if (!e.card) continue;
    const pos = graph.positionOf.get(idOf.get(e.card.id)!);
    if (pos !== undefined) counts.set(pos, (counts.get(pos) ?? 0) + e.qty);
    else noGraphData.add(e.card.name);
  }
  const commanderPos = graph.positionOf.get(plan.commander.id);
  if (commanderPos === undefined) throw new ToolInputError(`${commander.name} has no card graph data (its card script could not be read), so the deck's engine cannot be read around it`);
  if (!counts.has(commanderPos)) counts.set(commanderPos, 1);
  const entries: DeckEntry[] = [...counts].map(([pos, count]) => ({ name: idx.cards[pos].name, count }));
  const g = deckGraph(idx, entries, [idx.cards[commanderPos].name], store.roles);
  // Role counts are deck_stats' (every resolved nonland card, graph data or not), so a count quoted from either tool agrees.
  const sheet = roleSheet(store.roles, deck.entries.map((e) => ({ ...e, card: e.card && { id: e.card.id, name: e.card.name, land: e.card.land } })));
  g.roles = { counts: sheet.counts, unroled: sheet.unroled };
  const nonland = sheet.cards.reduce((n, c) => n + c.qty, 0);
  const targets = roleTargets(store, plan, commander.ci, nonland);
  const ctx = deckContext(idx, g);
  const d = graphDiagnose(idx, g, { targets: { targets: Object.fromEntries(targets.map((t) => [t.role, t.target])), source: "plan" } }, ctx);
  const roles: RoleRead[] = targets.map((t) => ({ role: t.role, count: sheet.counts[t.role] ?? 0, target: t.target, source: t.source, basis: t.basis, ...(t.expected !== undefined ? { expected: t.expected } : {}) }));
  const read = new Map(roles.map((r) => [r.role, r]));
  const isStatic = (name: string) => worksThroughStatic(idx, idx.indexOf(name));
  const linksOf = (name: string): DeckLink[] => {
    const seen = new Set<string>();
    return g.links.filter((l) => l.from === name || l.to === name).map((l) => ({
      card: l.from === name ? l.to : l.from, direction: l.from === name ? "feeds" as const : "fed by" as const, on: hookPhrase(l.hook), generic: ctx.generic(l),
    })).filter((l) => { const k = `${l.card}|${l.direction}|${l.on}|${l.generic}`; return !seen.has(k) && !!seen.add(k); })
      .sort((a, b) => (a.card < b.card ? -1 : a.card > b.card ? 1 : 0) || (a.direction < b.direction ? -1 : a.direction > b.direction ? 1 : 0) || (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
  };
  const nonlandCards = [...new Map(deck.entries.filter((e) => e.card && !e.card.land).map((e) => [e.card!.id, { id: idOf.get(e.card!.id)!, oracleId: e.card!.id, name: e.card!.name }])).values()];
  // A starved card waits on the first gap it pays off on, in the gaps' order (the graph's own assignment).
  const gapOf = new Map<string, string>();
  for (const s of d.starved) for (const name of s.payoffs) if (!gapOf.has(name)) gapOf.set(name, s.hook);
  const leansOn = mainParts([...plan.themes, ...(plan.cards ? [plan.cards] : [])]);

  return {
    commander: { name: commander.name, colorIdentity: commander.ci.join("") },
    plan: { ...planEcho(plan), leansOn },
    engineGaps: d.starved.map((s) => ({
      mechanic: hookPhrase(s.hook),
      payoffCount: s.payoffs.length,
      enablerCount: s.enablers.length,
      payoffs: s.payoffs,
      enablers: s.enablers,
      toTry: s.candidates.map((c) => ({ name: c.name, feeds: c.feeds, everyTurn: c.repeatable })),
      waitingOnIt: d.engine.filter((e) => e.bucket === "starved" && gapOf.get(e.name) === s.hook).map((e) => e.name),
    })),
    roles,
    over: (d.roles?.over ?? []).map((o) => ({ ...read.get(o.role)!, trims: (o.trims ?? []).map((t) => (isStatic(t.name) ? { ...t, unread: true as const } : t)) })),
    under: (d.roles?.under ?? []).map((u) => read.get(u.role)!),
    offPlan: offPlanCards(store, plan, nonlandCards.filter((c) => c.id !== plan.commander.id), leansOn),
    doingLeast: d.engine.filter((e) => e.bucket === "cut").map((e) => ({ name: e.name, partners: e.partners, links: linksOf(e.name), reason: e.reason! })),
    unread: d.engine.filter((e) => isStatic(e.name)).map((e) => ({
      name: e.name,
      reason: "works through a static effect (a lord, an anthem, a keyword grant, a cost or trigger change) the graph does not link yet, so its links undercount it" +
        (e.bucket === "unread" ? "" : `; it still reads as ${e.bucket} from the links it does have`),
    })),
    cards: d.engine.map(({ degree: _d, ...e }) => e),
    lowPartners: d.lowPartners,
    noGraphData: [...noGraphData].sort(),
    unresolved: unresolvedLines(store, deck.unresolved),
  };
}

// ---------- role targets (ISC-51) ----------
// A role target comes from the plan when the plan's theme data covers it, from the default table otherwise:
//   theme decks   for each theme the plan names, the commanders it is mined from (graph/strategy.ts themeCommanders: at
//                 least 0.15 of their theme tags, 20+ decks), each weighted by its share of the theme times how much of
//                 its color identity it shares with this deck (shared colors over all colors of the two; a colorless
//                 commander shares fully only with a colorless deck). In each commander's card list (the EDHREC page's
//                 cards, store commander_cards), a role's share is the decks running its nonland role cards over the
//                 decks running any nonland card; the weighted mean share times this deck's nonland copies is the
//                 role's expected count, and its rounding is the target. The list is the page's most-played cards, so
//                 shares lean toward staples; they are shares of slots, comparable across roles.
//   covered       a theme covers this deck's roles when at least STRATEGY_DEFAULTS.minCommanders (10) of its commanders
//                 share a color with it: the theme floor, applied to the decks that speak for these colors. A covered
//                 theme sets every role, including to 0 (Aristocrats decks run no counterspells). Several covered
//                 themes: the mean of their expected counts.
//   default       no covered theme: server/role-targets.json. A plan of priority cards alone is read under the theme they
//                 fit best (plan.ts inferTheme, DT-6.12), which then sets the targets if it is covered; the basis says so.
// This derivation is the builder's proposal for the open ISA question of how plan-shaped targets are derived (theme-deck
// role shares, the commander's own page, or the owner's own numbers), to be checked against real lists.

type ThemeRoles = { name: string; commanders: { ci: string[]; weight: number; shares: Map<string, number> }[] };
const THEME_ROLES = new WeakMap<Store, Map<string, ThemeRoles>>();

/** Each of a theme's commanders with its share of the theme and its role shares of listed nonland slots, once per store. */
function themeRoles(store: Store, theme: string): ThemeRoles {
  const per = THEME_ROLES.get(store) ?? THEME_ROLES.set(store, new Map()).get(store)!;
  const { name, chosen } = themeCommanders(store.db, theme);
  const hit = per.get(name);
  if (hit) return hit;
  const rows = store.db.query("SELECT cc.card_id, cc.decks FROM commander_cards cc JOIN cards c ON c.id = cc.card_id WHERE cc.commander_id = ? AND c.is_land = 0 ORDER BY cc.card_id");
  const commanders = chosen.map(({ page, share }) => {
    const cmd = store.space.cards.get(store.names[page.cardId - 1].oracleId)!;
    let total = 0;
    const mass = new Map<string, number>();
    for (const r of rows.all(page.cardId) as { card_id: number; decks: number }[]) {
      total += r.decks;
      for (const h of rolesOf(store.roles, store.names[r.card_id - 1].oracleId).roles) mass.set(h.role, (mass.get(h.role) ?? 0) + r.decks);
    }
    return { ci: cmd.ci, weight: share, shares: new Map([...mass].map(([role, m]) => [role, total ? m / total : 0])) };
  });
  const out = { name, commanders };
  per.set(name, out);
  return out;
}

/** Shared colors over all colors of two identities; two colorless identities share fully. */
function colorOverlap(a: readonly string[], b: readonly string[]): number {
  const all = new Set([...a, ...b]);
  if (!all.size) return 1;
  return a.filter((c) => b.includes(c)).length / all.size;
}

function roleTargets(store: Store, plan: ResolvedPlan, deckCi: readonly string[], nonland: number): Omit<RoleRead, "count">[] {
  const defaults = loadTargets(store.roles.roleNames);
  const covered: { name: string; sharing: number; of: number; expected: Map<string, number> }[] = [];
  const thin: string[] = [];
  for (const theme of plan.themes) {
    if (theme.source.kind !== "strategy") continue;
    const t = themeRoles(store, theme.source.theme);
    const weighted = t.commanders.map((c) => ({ ...c, w: c.weight * colorOverlap(c.ci, deckCi) })).filter((c) => c.w > 0);
    if (weighted.length < STRATEGY_DEFAULTS.minCommanders) {
      thin.push(`only ${weighted.length} of ${t.name}'s ${t.commanders.length} commanders share a color with this deck (${STRATEGY_DEFAULTS.minCommanders} needed)`);
      continue;
    }
    const sum = weighted.reduce((s, c) => s + c.w, 0);
    const expected = new Map(store.roles.roleNames.map((role) => [role, (nonland * weighted.reduce((s, c) => s + c.w * (c.shares.get(role) ?? 0), 0)) / sum]));
    covered.push({ name: t.name, sharing: weighted.length, of: t.commanders.length, expected });
  }
  return store.roles.roleNames.map((role) => {
    if (covered.length) {
      const expected = Math.round((covered.reduce((s, c) => s + c.expected.get(role)!, 0) / covered.length) * 10) / 10;
      const inferred = plan.inference?.theme ? ", the theme inferred from the priority cards" : "";
      const basis = covered.map((c) => `${c.name} decks${inferred} (${c.sharing} of its ${c.of} commanders share a color with this deck)`).join("; ");
      return { role, target: Math.round(expected), source: "plan" as const, basis, expected };
    }
    const why = thin.length ? thin.join("; ") : "the plan names no theme";
    return { role, target: defaults[role], source: "default" as const, basis: `default table: ${why}` };
  });
}

// ---------- off-plan cards (ISC-53) ----------
// A card is off the plan when plan.ts planScorer gives it 0: no main hook of any plan profile among what its abilities
// make or spend, and no main tag of any plan profile in its Tagger Card vector (the one plan fit deck_stats reads too).
// The reason says what the card does instead, and whether it fits a theme the plan avoids.

const hookWordsOf = (key: string) => {
  const { hook, token } = parseProfileHook(key);
  return token === null ? hookPhrase(hook) : `${hookPhrase(hook)} (${token ? "tokens" : "nontokens"})`;
};

/** The main hooks (in a player's words) and main tags of some plan profiles, heaviest first, each once. */
function mainParts(profiles: PlanProfile[]): { hooks: string[]; tags: string[] } {
  const hooks = profiles.flatMap((p) => p.hooks.filter(isMainHook).map((h) => hookWordsOf(h.hook)));
  const tags = profiles.flatMap((p) => p.tags.filter((t) => t.weight > 0.5).map((t) => t.tag));
  return { hooks: [...new Set(hooks)], tags: [...new Set(tags)] };
}

const TAGS_SHOWN = 5;

function offPlanCards(store: Store, plan: ResolvedPlan, cards: { id: number; oracleId: string; name: string }[], leansOn: { hooks: string[]; tags: string[] }): OffPlanCard[] {
  const fit = planScorer(store, plan);
  const avoid = plan.avoid.map((p) => ({ name: p.source.kind === "strategy" ? p.source.theme : p.source.commander, fit: planScorer(store, { ...plan, themes: [p], cards: null }) }));
  const graph = graphOf(store.db);
  const name = planEcho(plan);
  const planName = [...name.themes, ...(name.priorities.length ? [`${plan.commander.name} with ${name.priorities.join(", ")}`] : [])].join(" and ") +
    (name.inferred?.theme ? ` read under ${name.inferred.theme}, the theme those cards fit best` : "");
  const leaning = [...leansOn.hooks, ...leansOn.tags].slice(0, 6).join(", ");
  return cards.filter((c) => fit(c.oracleId).score === 0).map((c) => {
    const does = strategyFacts(graph, c.id).map((k) => {
      const [side, hook] = k.split("|");
      return `${side === "makes" ? "makes happen" : "waits on"}: ${hookPhrase(hook)}`;
    });
    const fitsAvoided = avoid.filter((a) => a.fit(c.oracleId).score > 0).map((a) => a.name);
    const reason = `nothing it does is something the ${planName} plan leans on (${leaning})` +
      (fitsAvoided.length ? `, and it fits ${fitsAvoided.join(" and ")}, which the plan avoids` : "");
    return { name: c.name, reason, does, tags: strongestTags(store, c.id, TAGS_SHOWN), roles: rolesOf(store.roles, c.oracleId).roles.map((r) => r.role), fitsAvoided };
  }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
