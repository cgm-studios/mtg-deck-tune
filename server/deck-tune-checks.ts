// MV-17: the code stage of the deck-tune eval. Each check reads one recorded session (deck-tune-transcript.ts) and
// decides one ISA criterion without a model: ISC-13 (no swaps before the player picks a lever), ISC-22.1 (the deck's numbers
// before any swap), ISC-22.2 (ranked levers before any swap), ISC-23.1 (every card Claude names came from the session)
// and the code half of ISC-23.2 (every swap block carries the Claude's read label), plus ISC-28 (no turn offers a card
// search it did not run). Whether a quality judgment outside those labels slipped through is a reading question, left to the Assay judge stage (deck-tune-eval.ts).
//
// The checks read the two block shapes the skill (plugin/skills/deck-tune/SKILL.md) fixes: the "Levers, ranked by
// expected help" list and the "### Swap n: out → in" / "### Cut n: out" / "### Add n: in" blocks.

import { LEVERS } from "./swap-tools";
import type { ToolEvent, Transcript, TranscriptEvent } from "./deck-tune-transcript";

export type CheckResult = { pass: boolean; details: string[] };

const LEVER_SET = new Set<string>(LEVERS);
/** The lever names the player sees, one per tool lever; SKILL.md's table carries the same words (a test holds them equal). */
export const LEVER_NAMES: Record<(typeof LEVERS)[number], string> = {
  plan: "Stronger fits for the commander",
  cheaper: "Lower the curve",
  budget: "Cheaper to buy",
  roles: "Fill thin roles",
  redundancy: "Trim what's doubled up",
};
const leverByName = (title: string) =>
  (Object.entries(LEVER_NAMES).find(([, n]) => n.toLowerCase() === title.trim().toLowerCase().replace(/’/g, "'"))?.[0] ?? null);
const READ_LABEL = /\*\*Claude[’']s read\*\*/;
const SWAP_HEADING = /^#{2,4}\s*(Swap|Cut|Add)\s+(\d+)\s*:\s*(.+?)\s*$/;
const LEVERS_HEADING = /levers,?\s+ranked by expected help/i;
const LIST_ITEM = /^\s*(\d+)\.\s+(.*)$/;
const FORMAT_LABELS = /\*\*(?:Reason \(data\):|Deck after:|Claude[’']s read)\*\*|Levers,?\s+ranked by expected help/g;

export type SwapBlock = { event: number; kind: "Swap" | "Cut" | "Add"; n: number; out: string | null; in: string | null; text: string };
export type LeverItem = { n: number; title: string; lever: string | null; text: string };
export type LeverList = { event: number; items: LeverItem[] };

const toolEvents = (t: Transcript): { i: number; e: ToolEvent }[] =>
  t.events.flatMap((e, i) => (e.kind === "tool" ? [{ i, e }] : []));
const turns = (t: Transcript, kind: "user" | "assistant"): { i: number; text: string }[] =>
  t.events.flatMap((e, i) => (e.kind === kind ? [{ i, text: e.text }] : []));
const firstIndex = (xs: { i: number }[]): number => (xs.length ? xs[0].i : Infinity);

/** Every swap, cut or add block in the assistant turns, in order. */
export function swapBlocks(t: Transcript): SwapBlock[] {
  const out: SwapBlock[] = [];
  for (const { i, text } of turns(t, "assistant")) {
    const lines = text.split("\n");
    for (let l = 0; l < lines.length; l++) {
      const m = SWAP_HEADING.exec(lines[l]);
      if (!m) continue;
      // The block is the heading and the bullet lines under it, blank lines between bullets included (the house list format
      // puts a blank line between every list item); it ends at the first other non-blank line.
      let end = l + 1;
      let bullets = false;
      for (let k = l + 1; k < lines.length; k++) {
        const line = lines[k];
        if (/^\s*[-*]\s/.test(line) || (bullets && /^\s{2,}\S/.test(line))) { bullets = true; end = k + 1; }
        else if (line.trim() !== "") break;
      }
      const kind = m[1] as SwapBlock["kind"];
      const [a, b] = m[3].split(/\s*(?:→|->)\s*/);
      out.push({
        event: i, kind, n: Number(m[2]),
        out: kind === "Add" ? null : a.trim(),
        in: kind === "Swap" ? (b ?? "").trim() || null : kind === "Add" ? a.trim() : null,
        text: lines.slice(l, end).join("\n"),
      });
    }
  }
  return out;
}

/** Every "Levers, ranked by expected help" list in the assistant turns, with its numbered items. */
export function leverLists(t: Transcript): LeverList[] {
  const out: LeverList[] = [];
  for (const { i, text } of turns(t, "assistant")) {
    const lines = text.split("\n");
    const h = lines.findIndex((l) => LEVERS_HEADING.test(l));
    if (h < 0) continue;
    const items: LeverItem[] = [];
    for (let l = h + 1; l < lines.length; l++) {
      const m = LIST_ITEM.exec(lines[l]);
      if (m) {
        const title = /\*\*(.+?)\*\*/.exec(m[2])?.[1] ?? "";
        // The lever name from SKILL.md's table; sessions recorded before 2026-11-06's "talk Magic" change named the
        // tool lever in backticks instead.
        const lever = leverByName(title) ?? [...m[2].matchAll(/`([a-z]+)`/g)].map((x) => x[1]).find((x) => LEVER_SET.has(x)) ?? null;
        items.push({ n: Number(m[1]), title, lever, text: m[2] });
      } else if (lines[l].trim() !== "") break; // blank lines between items are the house list format, not the list's end
    }
    out.push({ event: i, items });
  }
  return out;
}

/** Whether a user turn picks this lever item: its number on its own, its bold title, or its tool lever by name. */
function picks(userText: string, item: LeverItem): boolean {
  const text = userText.toLowerCase();
  if (new RegExp(`(^|[^\\d])${item.n}([^\\d]|$)`).test(text)) return true;
  if (item.title && text.includes(item.title.toLowerCase())) return true;
  return item.lever !== null && new RegExp(`\\b${item.lever}\\b`).test(text);
}

/** ISC-13: no lever produces swaps until the player picks it. Each swap_candidates call follows a user pick of a lever with
 * that tool lever from the latest levers list, and no swap block appears before the first such call. */
export function checkNoSwapsWithoutPick(t: Transcript): CheckResult {
  const violations: string[] = [];
  const lists = leverLists(t);
  const users = turns(t, "user");
  const calls = toolEvents(t).filter(({ e }) => e.name === "swap_candidates");
  for (const { i, e } of calls) {
    const list = [...lists].reverse().find((l) => l.event < i);
    if (!list) { violations.push(`event ${i}: swap_candidates (${String(e.input.lever)}) ran before any levers list`); continue; }
    const picked = users.filter((u) => u.i > list.event && u.i < i)
      .some((u) => list.items.some((item) => item.lever === e.input.lever && picks(u.text, item)));
    if (!picked) violations.push(`event ${i}: swap_candidates (${String(e.input.lever)}) ran with no user pick of that lever after the list at event ${list.event}`);
  }
  const blocks = swapBlocks(t);
  const firstCall = firstIndex(calls);
  for (const b of blocks.filter((b) => b.event < firstCall)) violations.push(`event ${b.event}: ${b.kind} ${b.n} listed before any swap_candidates call`);
  if (violations.length) return { pass: false, details: violations };
  return { pass: true, details: [`${calls.length} swap_candidates call(s), each after a pick; ${blocks.length} swap block(s), none before a call`] };
}

/** ISC-22.1: the deck's numbers (deck_stats, then an assistant turn with its average mana value and curve) come
 * before the first swap block and the first swap_candidates call. */
export function checkNumbersBeforeSwaps(t: Transcript): CheckResult {
  const stats = toolEvents(t).find(({ e }) => e.name === "deck_stats" && !e.isError);
  if (!stats) return { pass: false, details: ["no successful deck_stats call in the session"] };
  const avg = (stats.e.result as { averageManaValue?: unknown }).averageManaValue;
  if (typeof avg !== "number") return { pass: false, details: [`deck_stats at event ${stats.i} has no numeric averageManaValue`] };
  const shown = [avg.toFixed(2), avg.toFixed(3)];
  const report = turns(t, "assistant").find((a) => a.i > stats.i && shown.some((s) => a.text.includes(s)) && /\bcurve\b/i.test(a.text));
  if (!report) return { pass: false, details: [`no assistant turn after deck_stats shows the average mana value (${shown.join(" or ")}) and the curve`] };
  const firstSwap = Math.min(firstIndex(swapBlocks(t).map((b) => ({ i: b.event }))), firstIndex(toolEvents(t).filter(({ e }) => e.name === "swap_candidates")));
  const pass = report.i < firstSwap;
  return { pass, details: [`deck_stats at event ${stats.i}, numbers reported at event ${report.i}, first swap at ${firstSwap === Infinity ? "none" : `event ${firstSwap}`}`] };
}

/** ISC-22.2: a levers list ranked by expected help, at least two items each naming a tool lever, comes before the
 * first swap block and the first swap_candidates call. */
export function checkLeversBeforeSwaps(t: Transcript): CheckResult {
  const list = leverLists(t).find((l) => l.items.length >= 2 && l.items.every((x) => x.lever !== null));
  if (!list) return { pass: false, details: ["no 'Levers, ranked by expected help' list with two or more items, each naming a tool lever"] };
  const ranked = list.items.every((x, k) => x.n === k + 1);
  const firstSwap = Math.min(firstIndex(swapBlocks(t).map((b) => ({ i: b.event }))), firstIndex(toolEvents(t).filter(({ e }) => e.name === "swap_candidates")));
  const pass = ranked && list.event < firstSwap;
  return {
    pass,
    details: [`levers at event ${list.event}: ${list.items.map((x) => `${x.n}. ${x.title} (${x.lever})`).join("; ")}${ranked ? "" : " (not numbered 1..n)"}; first swap at ${firstSwap === Infinity ? "none" : `event ${firstSwap}`}`],
  };
}

function stringLeaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) stringLeaves(x, out);
  return out;
}

type CandidatePair = { out: string | null; in: string | null };
function returnedPairs(t: Transcript): CandidatePair[] {
  return toolEvents(t).filter(({ e }) => e.name === "swap_candidates" && !e.isError).flatMap(({ e }) => {
    const cands = (e.result as { candidates?: unknown }).candidates;
    if (!Array.isArray(cands)) return [];
    const name = (side: unknown) => (side && typeof side === "object" && typeof (side as { name?: unknown }).name === "string" ? (side as { name: string }).name : null);
    return cands.map((c) => ({ out: name((c as { out?: unknown }).out), in: name((c as { in?: unknown }).in) }));
  });
}

/** Where `name` occurs in `text` as a whole name: case-sensitive, not inside a longer word. */
function nameSpans(text: string, name: string): [number, number][] {
  const spans: [number, number][] = [];
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
    const before = at === 0 ? "" : text[at - 1];
    const after = text[at + name.length] ?? "";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) spans.push([at, at + name.length]);
  }
  return spans;
}

/** The card names named in `text`. A name seen only inside a longer name ("Study" in "Rhystic Study") is not counted. */
function namedCards(text: string, names: string[]): string[] {
  const found = names.map((n) => ({ n, spans: nameSpans(text, n) })).filter((f) => f.spans.length > 0);
  const inside = ([a, b]: [number, number], self: string) =>
    found.some((f) => f.n !== self && f.n.length > self.length && f.spans.some(([c, d]) => c <= a && b <= d));
  return found.filter((f) => f.spans.some((s) => !inside(s, f.n))).map((f) => f.n);
}

/** The names the scanner looks for: each card's full name and each face of a multi-face card. A one-word name under
 * five letters (Opt, Cut, Fog) reads as an ordinary word too often to count; swap headings still catch those. */
export function scannableNames(cardNames: string[]): string[] {
  const names = new Set<string>();
  for (const full of cardNames) for (const n of [full, ...(full.includes(" // ") ? full.split(" // ") : [])]) {
    if (!n.includes(" ") && n.length < 5) continue;
    names.add(n);
  }
  return [...names];
}

/** ISC-23.1: every card Claude proposes came back from a tool in the session. Two halves: each swap block's pair is
 * a candidate pair some swap_candidates call returned, and every card name in an assistant turn appears in a tool
 * result, a file read or a user turn of the same session. `names` comes from scannableNames over the card store. */
export function checkProposalsFromTools(t: Transcript, names: string[]): CheckResult {
  const details: string[] = [];
  const pairs = returnedPairs(t);
  const blocks = swapBlocks(t);
  const unreturned = blocks.filter((b) => !pairs.some((p) => p.out === b.out && p.in === b.in));
  for (const b of unreturned) details.push(`${b.kind} ${b.n} (event ${b.event}): ${b.out ?? "∅"} → ${b.in ?? "∅"} is not a pair any swap_candidates call returned`);
  const sources: string[] = t.events.flatMap((e: TranscriptEvent) =>
    e.kind === "tool" ? (e.isError ? [] : stringLeaves(e.result)) : e.kind === "read" ? [e.content] : e.kind === "user" ? [e.text] : []);
  const sourceText = sources.join("\n");
  // The block labels are the skill's own words, not card names ("Reason" is also a card face).
  const said = turns(t, "assistant").map((a) => a.text.replace(FORMAT_LABELS, " ")).join("\n");
  const named = namedCards(said, names);
  const outside = named.filter((n) => !sourceText.includes(n));
  for (const n of outside) details.push(`"${n}" is named by Claude but appears in no tool result, file read or user turn of the session`);
  if (details.length === 0) details.push(`${blocks.length} swap block(s), all returned pairs; ${named.length} card names in Claude's turns, all from the session`);
  return { pass: unreturned.length === 0 && outside.length === 0, details };
}

/** ISC-23.2, code half: every swap, cut or add block carries the Claude's read label. */
export function checkReadsLabeled(t: Transcript): CheckResult {
  const blocks = swapBlocks(t);
  const missing = blocks.filter((b) => !READ_LABEL.test(b.text));
  return {
    pass: missing.length === 0,
    details: missing.length ? missing.map((b) => `${b.kind} ${b.n} (event ${b.event}) has no **Claude's read** line`) : [`${blocks.length} swap block(s), each with a **Claude's read** line`],
  };
}

// A turn that offers a search instead of running it ("I can run it whenever you want", "want me to search"). The
// offer is the miss: the store answers that search, so the turn should already hold its result.
const SEARCH_OFFER = /\b(?:(?:I|we)\s+(?:can|could)\s+(?:run|search|pull|look)|want me to\s+(?:run|search|pull|look)|whenever you (?:want|like)|if you(?:'d| would)? like,? I (?:can|could))\b/i;
const SEARCH_WORD = /find_cards|\btags?\b|search|look(?:\s+|-)?up/i;

/** ISC-28: a turn never offers a card search it could run. Each assistant turn that offers one must have a find_cards
 *  call since the user turn before it. */
export function checkSearchesNotDeferred(t: Transcript): CheckResult {
  const details: string[] = [];
  let since: string[] = [];
  let offers = 0;
  t.events.forEach((e, i) => {
    if (e.kind === "user") since = [];
    else if (e.kind === "tool") since.push(e.name);
    else if (e.kind === "assistant") {
      for (const sentence of e.text.split(/(?<=[.!?])\s+|\n+/)) {
        if (!SEARCH_OFFER.test(sentence) || !SEARCH_WORD.test(sentence)) continue;
        offers++;
        if (!since.includes("find_cards")) details.push(`event ${i} offers a search it did not run: "${sentence.trim().slice(0, 160)}"`);
      }
      since = [];
    }
  });
  if (details.length === 0) details.push(`${offers} search offer(s), each with its find_cards call in the same turn`);
  return { pass: !details[0].startsWith("event"), details };
}

// Tool and code vocabulary a reply to the player never carries (SKILL.md "Talk Magic, not tools"). Each entry is a name the
// MCP or the repo uses and a player would not: tool names, tool arguments and JSON fields, file paths, tag talk, search
// match counts and the plumbing words.
const TOOL_TALK: [string, RegExp][] = [
  ["tool name", /\b(?:deck_stats|swap_candidates|find_cards|accept_swap|reject_swap)\b/],
  ["tool lever in backticks", new RegExp("`(?:" + LEVERS.join("|") + ")`")],
  ["tool argument or field", /\b(?:belowTarget|dropsRole|deckFile|decklist|colorIdentity|manaValue)\b|`(?:card|targets|tags|neighbors)`/],
  ["file path", /(?:^|[\s(`])(?:app|labels|evals|data)\/\S+|\S+\.(?:json|jsonl|ts|yaml)\b/],
  ["tag talk", /\b(?:Tagger|tags?)\b/i],
  ["match count", /\b\d+\s+match(?:es|ed)?\b/i],
  ["plumbing word", /\b(?:MCP|Card Space|similarity|neighbou?r (?:rank|#\d+))\b/i],
];

/** ISC-29: no reply to the player carries tool or code vocabulary. Every assistant turn is scanned against TOOL_TALK. */
export function checkNoToolTalk(t: Transcript): CheckResult {
  const details: string[] = [];
  for (const { i, text } of turns(t, "assistant")) {
    for (const line of text.split("\n")) {
      for (const [kind, re] of TOOL_TALK) {
        const m = re.exec(line);
        if (m) details.push(`event ${i}: ${kind} "${m[0].trim()}" in: ${line.trim().slice(0, 120)}`);
      }
    }
  }
  return { pass: details.length === 0, details: details.length ? details : ["no tool or code vocabulary in any reply"] };
}
