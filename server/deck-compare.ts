// DT-6.17: the deck compare page (ISA ISC-129 to 140, ISC-109). Two calls. With no triggers the tool lists the deck's events
// from the card graph, so Claude can pick the ones that drive the plan. With triggers it writes one self-contained HTML file
// (compare-page.ts): the deck's numbers before and after, the swaps, and a map of which cards cause each trigger and which pay
// it off. The numbers and connections are data; which triggers to show, what to drop and anything added by hand are Claude's
// judgment, and the page labels them so. The before deck is rebuilt from the deck file's own change log (accept_swap writes
// it), so a later session can ask for the page and nobody has to remember what changed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { z } from "zod";
import { comparePage, connections, PAGE_GENERATOR, type PageCard, type PageChange, type PageData, type PageNumbers, type PageRow, type PageTrigger } from "./compare-page";
import { parseDecklist, type SpaceCard } from "./deck-pool";
import { cardFacts, deckNumbers, deckPath, readDeck, resolveCommander, ToolInputError, type Store } from "./deck-tools";
import { deckOnGraph } from "./diagnose";
import { hookPhrase } from "./graph/diagnose";
import { byteOrder } from "./graph/profile";
import { planShape } from "./plan-input";
import { planContext, type PlanContext, type PlanEcho } from "./plan";
import { DECK_ROOT } from "./paths";

const placed = z.object({
  card: z.string().min(1).describe("Exact name of a card in the deck, before or after the swaps"),
  note: z.string().min(1).max(160).optional().describe("Why it belongs here, in plain Magic terms; shown as my read. Required for a card the data did not list under this trigger"),
  conditional: z.boolean().optional().describe("true = it connects only under a condition (drawn dashed)"),
}).strict();

const trigger = z.object({
  name: z.string().min(1).max(40).describe("The trigger as a player would say it, e.g. \"A creature dies\""),
  about: z.string().min(1).max(200).optional().describe("One line on what it does for this deck"),
  event: z.string().min(1).optional().describe("An event from this tool's list: the card data fills in the cards that cause it and pay it off. Omit for a trigger the data cannot read, and list its cards by hand"),
  causes: z.array(placed).max(40).optional().describe("Cards to add under causes, or notes on cards the data already listed"),
  payoffs: z.array(placed).max(40).optional().describe("Cards to add under payoffs, or notes on cards the data already listed"),
  keep: z.array(z.string().min(1)).max(60).optional().describe("For a broad event: only these of the cards the data listed stay (cards added by hand are not affected)"),
  drop: z.array(z.string().min(1)).max(60).optional().describe("Cards the data listed that are noise for this deck"),
}).strict();

export const deckCompareShape = {
  commander: z.string().min(1).describe("The commander's exact name or front-face name, as the deck stands now"),
  deckFile: z.string().min(1).optional().describe("Path to the deck file, absolute or relative to the project directory. Its change log gives the before deck"),
  decklist: z.string().min(1).optional().describe("The decklist text itself; give this or deckFile"),
  plan: planShape.optional().describe("The player's confirmed plan; adds plan fit and names the plan on the page"),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD: compare only against changes logged on or after this date (default: every logged change)"),
  summary: z.string().min(1).max(300).optional().describe("One line on how the deck wins, in plain Magic terms; shown as my read"),
  triggers: z.array(trigger).min(1).max(8).optional().describe("The triggers that drive this plan, at most 8. Omit to list the deck's events and write nothing"),
  outFile: z.string().regex(/\.html$/i).optional().describe("Where to save the page (default: beside the deck file, or in the project directory for a pasted list)"),
};
const deckCompareInput = z.object(deckCompareShape).strict();
export type DeckCompareInput = z.input<typeof deckCompareInput>;

// ---------- the change log ----------
export type LoggedChange = { date: string; out?: string; in?: string; commander?: true; promoted?: "stays" | "left" };

/** The accepted changes a deck file records, oldest first: the lines accept_swap appends (swap-tools.ts). */
export function loggedChanges(text: string): LoggedChange[] {
  const changes: LoggedChange[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const promoted = line.match(/^# (\d{4}-\d{2}-\d{2}) commander promoted: (.+); (.+) (stays|left)$/);
    if (promoted) {
      changes.push({ date: promoted[1], in: promoted[2], out: promoted[3], commander: true, promoted: promoted[4] as "stays" | "left" });
      continue;
    }
    const m = line.match(/^# (\d{4}-\d{2}-\d{2}) (accepted swap(?: \([^)]*\))?|changed commander): (.+)$/);
    if (!m) continue;
    const both = m[3].match(/^-1 (.+), \+1 (.+)$/), out = m[3].match(/^-1 (.+)$/), add = m[3].match(/^\+1 (.+)$/);
    const pair = both ? { out: both[1], in: both[2] } : out ? { out: out[1] } : add ? { in: add[1] } : null;
    if (pair) changes.push({ date: m[1], ...pair, ...(m[2] === "changed commander" && { commander: true as const }) });
  }
  return changes;
}

/** The deck with these changes undone, newest first, as list text, and the commander it had then. Notes a change the list no longer shows. */
function undo(store: Store, text: string, changes: LoggedChange[], commander: SpaceCard): { text: string; commander: SpaceCard; notes: string[] } {
  const qty = new Map<string, number>();
  for (const e of parseDecklist(store.space, text).entries) {
    const name = e.card?.name ?? e.text;
    qty.set(name, (qty.get(name) ?? 0) + e.qty);
  }
  const notes: string[] = [];
  let was = commander;
  const add = (name: string) => qty.set(name, (qty.get(name) ?? 0) + 1);
  for (const c of [...changes].reverse()) {
    if (c.commander) was = resolveCommander(store, c.out!).card;
    if (c.promoted) {
      if (c.promoted === "left") add(c.out!);
      continue;
    }
    if (c.in) {
      const n = qty.get(c.in) ?? 0;
      if (n === 0) notes.push(`${c.in} was logged as added but is no longer in the list, so the before deck may be off by that card`);
      else if (n === 1) qty.delete(c.in);
      else qty.set(c.in, n - 1);
    }
    if (c.out) add(c.out);
  }
  return { text: [...qty].map(([name, n]) => `${n} ${name}`).join("\n"), commander: was, notes };
}

// ---------- one version of the deck ----------
type EventCards = { causes: Set<string>; payoffs: Set<string> };
type Version = { numbers: PageNumbers; events: Map<string, EventCards>; names: Set<string>; cards: Map<string, PageCard> };

function readVersion(store: Store, commander: SpaceCard, text: string, plan: PlanContext | null): Version {
  const deck = parseDecklist(store.space, text);
  const n = deckNumbers(store, commander, deck.entries, plan);
  const { g, ctx } = deckOnGraph(store, commander, text);
  const events = new Map<string, EventCards>();
  let links = 0;
  for (const l of g.links) {
    if (!ctx.counts(l) || l.from === l.to) continue;
    links++;
    const key = hookPhrase(l.hook);
    const e = events.get(key) ?? events.set(key, { causes: new Set(), payoffs: new Set() }).get(key)!;
    e.causes.add(l.from);
    e.payoffs.add(l.to);
  }
  const facts = cardFacts(store, commander, deck.entries);
  return {
    numbers: {
      averageManaValue: n.averageManaValue, lands: n.lands, curve: n.curve, roleCounts: n.roleCounts, pipLoad: n.pipLoad, links,
      onPlan: n.planFit ? { onPlan: n.planFit.onPlan, of: n.planFit.of } : null,
    },
    events, names: new Set(facts.map((f) => f.name)),
    cards: new Map(facts.map((f) => [f.name, { manaValue: f.manaValue, typeLine: f.typeLine, oracleText: f.oracleText }])),
  };
}

// ---------- triggers ----------
const norm = (s: string) => s.trim().toLowerCase();

function buildTrigger(t: z.output<typeof trigger>, after: Version, before: Version | null, known: Map<string, string>): PageTrigger {
  if (t.event === undefined && !t.causes?.length && !t.payoffs?.length) throw new ToolInputError(`trigger "${t.name}" needs an event or at least one card`);
  const nameOf = (card: string) => {
    const n = known.get(norm(card));
    if (!n) throw new ToolInputError(`${card} (in trigger "${t.name}") is in neither version of this deck`);
    return n;
  };
  const event = t.event === undefined ? undefined : norm(t.event);
  if (event !== undefined && !after.events.has(event) && !before?.events.has(event)) {
    const list = [...new Set([...after.events.keys(), ...(before?.events.keys() ?? [])])].sort(byteOrder);
    throw new ToolInputError(`this deck has no event "${t.event}"; its events are: ${list.join("; ")}`);
  }
  const side = (key: "causes" | "payoffs"): PageRow[] => {
    const rows = new Map<string, PageRow>();
    if (event !== undefined) {
      for (const [v, version] of [[after, "after"], [before, "before"]] as const) {
        for (const card of v?.events.get(event)?.[key] ?? []) {
          const row = rows.get(card) ?? rows.set(card, { card, mine: false, before: false, after: false }).get(card)!;
          row[version] = true;
        }
      }
    }
    if (t.keep) {
      const kept = new Set(t.keep.map(nameOf));
      for (const card of [...rows.keys()]) if (!kept.has(card)) rows.delete(card);
    }
    for (const p of t[key] ?? []) {
      const card = nameOf(p.card);
      const row = rows.get(card);
      if (row) {
        if (p.note) row.note = p.note;
        if (p.conditional) row.conditional = true;
        continue;
      }
      if (!p.note) throw new ToolInputError(`${card} is not listed under "${t.name}" by the card data, so it needs a note saying why it belongs`);
      rows.set(card, { card, note: p.note, ...(p.conditional && { conditional: true }), mine: true, before: before?.names.has(card) ?? false, after: after.names.has(card) });
    }
    for (const d of t.drop ?? []) rows.delete(nameOf(d));
    return [...rows.values()].sort((a, b) => byteOrder(a.card, b.card));
  };
  return { name: t.name, ...(t.about && { about: t.about }), causes: side("causes"), payoffs: side("payoffs") };
}

function planLine(plan: PlanEcho): string {
  const parts = [
    plan.themes.length ? plan.themes.join(" and ") : "",
    plan.priorities.length ? `built around ${plan.priorities.join(", ")}` : "",
    plan.avoid.length ? `staying away from ${plan.avoid.join(" and ")}` : "",
  ].filter(Boolean);
  return parts.join(", ");
}

/** Where the page goes: the path asked for, beside the deck file, or in the project for a pasted list. */
function targetPath(f: { outFile?: string; deckFile?: string }, commander: string): string {
  if (f.outFile) return deckPath(f.outFile);
  if (f.deckFile) {
    const path = deckPath(f.deckFile);
    return `${path.slice(0, path.length - extname(path).length)}-compare.html`;
  }
  return join(DECK_ROOT, `${commander.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-compare.html`);
}

function writePage(path: string, html: string): void {
  if (existsSync(path) && !readFileSync(path, "utf8").includes(`<meta name="generator" content="${PAGE_GENERATOR}">`)) {
    throw new ToolInputError(`${path} already exists and is not a page this tool wrote, so it was left alone; pass another outFile`);
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, html);
  } catch (e) {
    throw new ToolInputError(`cannot save the page to ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export type DeckCompareListing = {
  compared: boolean;
  changes: PageChange[];
  /** The deck's events, most connected first; cards as the deck stands, counts for the before deck when there is one. */
  events: { event: string; causes: string[]; payoffs: string[]; before?: { causes: number; payoffs: number } }[];
  notes: string[];
};
export type DeckCompareWritten = {
  written: string;
  compared: boolean;
  changes: number;
  /** Each trigger's connections as [before, after], or [after] with no before deck. */
  triggers: { name: string; connections: number[] }[];
  notes: string[];
};

export function deckCompare(store: Store, input: DeckCompareInput): DeckCompareListing | DeckCompareWritten {
  const f = deckCompareInput.parse(input);
  const text = readDeck(f);
  const { card: commander } = resolveCommander(store, f.commander);
  const plan = planContext(store, commander.name, f.plan);
  const changes = loggedChanges(text).filter((c) => !f.since || c.date >= f.since);
  const compared = changes.length > 0;
  const undone = compared ? undo(store, text, changes, commander) : null;
  const after = readVersion(store, commander, text, plan);
  const before = undone ? readVersion(store, undone.commander, undone.text, plan) : null;
  const notes = [...new Set(undone?.notes ?? [])];
  const shown: PageChange[] = changes.map((c) => ({ ...(c.out && { out: c.out }), ...(c.in && { in: c.in }), ...(c.commander && { commander: true }) }));

  if (!f.triggers) {
    const events = [...new Set([...after.events.keys(), ...(before?.events.keys() ?? [])])].map((event) => {
      const a = after.events.get(event), b = before?.events.get(event);
      return {
        event, causes: [...(a?.causes ?? [])].sort(byteOrder), payoffs: [...(a?.payoffs ?? [])].sort(byteOrder),
        ...(before && { before: { causes: b?.causes.size ?? 0, payoffs: b?.payoffs.size ?? 0 } }),
      };
    }).sort((x, y) => y.causes.length + y.payoffs.length - x.causes.length - x.payoffs.length || byteOrder(x.event, y.event));
    return { compared, changes: shown, events, notes };
  }

  const known = new Map<string, string>();
  for (const name of [...after.names, ...(before?.names ?? [])]) {
    known.set(norm(name), name);
    known.set(norm(name.split(" // ")[0]), name);
  }
  const triggers = f.triggers.map((t) => buildTrigger(t, after, before, known));
  const data: PageData = {
    commander: commander.name, plan: plan ? planLine(plan.plan) || null : null, summary: f.summary ?? null, compare: compared, changes: shown,
    added: before ? [...after.names].filter((n) => !before.names.has(n)).sort(byteOrder) : [], cut: before ? [...before.names].filter((n) => !after.names.has(n)).sort(byteOrder) : [],
    numbers: { before: before?.numbers ?? null, after: after.numbers }, triggers,
    cards: Object.fromEntries([...new Map([...(before?.cards ?? []), ...after.cards])].sort(([a], [b]) => byteOrder(a, b))),
  };
  const path = targetPath(f, commander.name);
  writePage(path, comparePage(data));
  return {
    written: path, compared, changes: shown.length,
    triggers: triggers.map((t) => ({ name: t.name, connections: compared ? [connections(t, "before"), connections(t, "after")] : [connections(t, "after")] })),
    notes,
  };
}
