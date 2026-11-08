// MV-17, DT-6.7: the code stage of the deck-tune eval. Each check reads one recorded session (deck-tune-transcript.ts) and
// decides one ISA criterion without a model. Six checks, the ones a program can decide from what a session recorded:
//
//   ISC-111  accept_swap and reject_swap run only on the player's own word for that swap
//   ISC-91   a card's cost, type or stats stated in a reply comes from a tool result that returned that card
//   ISC-68   every incoming card in a swap block came back from a shortlist, swap_candidates or find_cards call
//   ISC-29   no reply names a tool, argument, tag label, match count, file path or other code vocabulary
//   ISC-108  every swap block carries the "my read" label, and "Claude's read" appears in no reply
//   ISC-110  a mana curve chart's rows equal the curve of a deck_stats result from the session
//
// The one structure a check relies on is the judgment block the player saw and kept: "### Swap n: out → in" (also
// "### Cut n: out" and "### Add n: in"), then bullets. ISC-83 (product code names no card or commander) lives below as
// helpers for its test. What needs a reader (ISC-84, 87, 107) is the judge stage (deck-tune-eval.ts, evals/deck-tune.yaml).

import { LEVERS } from "./swap-tools";
import type { ToolEvent, Transcript } from "./deck-tune-transcript";

export type CheckResult = { pass: boolean; details: string[] };

/** The label on an own-knowledge claim: "**My read**:", "**My read:**", any capitals (ISC-108). */
const READ_LABEL = /\*\*\s*my read\s*:?\s*\*\*/i;
/** The label ISC-108 retired. */
const OLD_READ_LABEL = /Claude[’']s\s+read/i;
const SWAP_HEADING = /^#{2,4}\s*(Swap|Cut|Add)\s+(\d+)\s*:\s*(.+?)\s*$/i;
const FORMAT_LABELS = /\*\*\s*(?:Reason \(data\)|Deck after|my read|Claude[’']s read)\s*:?\s*\*\*/gi;


export type SwapBlock = { event: number; kind: "Swap" | "Cut" | "Add"; n: number; out: string | null; in: string | null; text: string };

/** A tool's own name: a Claude Code log names it "mcp__plugin_<plugin>_mtg-deck__<tool>". */
const bareName = (name: string) => name.replace(/^mcp__.*?mtg-deck__/, "");
const toolEvents = (t: Transcript): { i: number; e: ToolEvent }[] =>
  t.events.flatMap((e, i) => (e.kind === "tool" ? [{ i, e: { ...e, name: bareName(e.name) } }] : []));
const turns = (t: Transcript, kind: "user" | "assistant"): { i: number; text: string }[] =>
  t.events.flatMap((e, i) => (e.kind === kind ? [{ i, text: e.text }] : []));


/** A card name as a heading writes it: without bold or code marks or a trailing parenthetical ("Name (4 mana)"). */
const cleanName = (raw: string | undefined): string => (raw ?? "").replace(/[*`_]/g, "").replace(/\s*\([^)]*\)\s*$/, "").trim();

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
      const [a, b] = m[3].split(/\s*(?:→|->)\s*/).map(cleanName);
      out.push({
        event: i, kind, n: Number(m[2]),
        out: kind === "Add" ? null : a,
        in: kind === "Swap" ? b || null : kind === "Add" ? a : null,
        text: lines.slice(l, end).join("\n"),
      });
    }
  }
  return out;
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
export function namedCards(text: string, names: string[]): string[] {
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


// Tool and code vocabulary a reply to the player never carries (SKILL.md "Talk Magic, not tools"). Each entry is a name the
// MCP or the repo uses and a player would not: tool names, tool arguments and JSON fields, file paths, tag talk, search
// match counts and the plumbing words. "diagnose" and "shortlist" are tool names and also plain words a player says, so
// they count only in backticks.
const TOOL_TALK: [string, RegExp][] = [
  ["tool name", /\b(?:deck_stats|swap_candidates|find_cards|accept_swap|reject_swap|commander_profile)\b|`(?:diagnose|shortlist)`/],
  ["tool lever in backticks", new RegExp("`(?:" + LEVERS.join("|") + ")`")],
  ["tool argument or field", /\b(?:belowTarget|dropsRole|deckFile|decklist|colorIdentity|manaValue|engineGap|offPlan|maxManaValue|maxPrice|planPartners|planGain|genericLinks|noLinks|cardFacts)\b|`(?:card|targets|tags|neighbors)`/],
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

// ISC-83 (code probe for the no-overfitting constraint): product code names no specific commander or card as a rule, a
// constant or a branch. A card name in a string literal is how such a rule is written (`if (name === "...")`, a table
// keyed by names, a list of exempt cards), so the check reads every string literal of the product source and looks for
// card names from the store. Comments are not literals and are never read; a regular expression's source is read as one.

/** The text of every string literal in some TypeScript source (single, double and template literals, the static parts of
 * a template each as their own, and the source of every regular expression), skipping comments. A lexer, not a parser:
 * it knows what a slash after an identifier or a closing bracket means (division) against one after an operator (a
 * regex). */
export function stringLiterals(src: string): string[] {
  const out: string[] = [];
  const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^]$/;
  let last = ""; // the last significant token's tail, to tell a regex from a division
  const templ = (i: number): number => {
    // i is just past the opening backtick or a closing `}` of a substitution; read static text up to `${` or the closing backtick
    let text = "";
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "\\") { text += src[i + 1] ?? ""; i++; continue; }
      if (c === "`") { out.push(text); return i + 1; }
      if (c === "$" && src[i + 1] === "{") {
        out.push(text); text = "";
        i = code(i + 2, true);
        i--; // the loop's i++ steps over the position code() returned (just past the closing brace)
        continue;
      }
      text += c;
    }
    return i;
  };
  const code = (start: number, inSubst: boolean): number => {
    let depth = 0;
    let i = start;
    for (; i < src.length; i++) {
      const c = src[i], n = src[i + 1];
      if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === "/" && n === "*") { i = src.indexOf("*/", i + 2); if (i < 0) return src.length; i++; continue; }
      if (c === "'" || c === '"') {
        let text = "";
        for (i++; i < src.length && src[i] !== c && src[i] !== "\n"; i++) { if (src[i] === "\\") { text += src[i + 1] ?? ""; i++; } else text += src[i]; }
        out.push(text); last = "s"; continue;
      }
      if (c === "`") { i = templ(i + 1) - 1; last = "s"; continue; }
      if (c === "/" && (last === "" || REGEX_AFTER.test(last) || /(?:return|typeof|case|in|of)$/.test(last))) {
        let cls = false, body = "";
        for (i++; i < src.length && src[i] !== "\n"; i++) {
          if (src[i] === "\\") { body += src[i] + (src[i + 1] ?? ""); i++; continue; }
          if (src[i] === "[") cls = true;
          else if (src[i] === "]") cls = false;
          else if (src[i] === "/" && !cls) break;
          body += src[i];
        }
        out.push(body); last = "r"; continue;
      }
      if (inSubst) {
        if (c === "{") depth++;
        else if (c === "}") { if (depth === 0) return i + 1; depth--; }
      }
      if (!/\s/.test(c)) last = /[\w$]/.test(c) ? (/[\w$]$/.test(last) ? last + c : c) : c;
    }
    return i;
  };
  code(0, false);
  return out;
}

/** Card names (and each face of a multi-face card) found in string literals: a multi-word name anywhere in a literal, at
 * word edges and in the card's own capitals; a one-word name only when it is the whole literal. Names `scannableNames`
 * drops (one word under five letters) never count. `names` comes from scannableNames over the card store. */
export function cardNamesInLiterals(literals: string[], names: string[]): { name: string; literal: string }[] {
  const hits: { name: string; literal: string }[] = [];
  const multi = names.filter((n) => n.includes(" "));
  const single = new Set(names.filter((n) => !n.includes(" ")));
  for (const literal of new Set(literals)) {
    const whole = literal.trim();
    if (single.has(whole)) hits.push({ name: whole, literal });
    for (const n of multi) {
      let at = literal.indexOf(n);
      while (at >= 0) {
        const before = literal[at - 1], after = literal[at + n.length];
        if (!(before && /\w/.test(before)) && !(after && /\w/.test(after))) { hits.push({ name: n, literal }); break; }
        at = literal.indexOf(n, at + 1);
      }
    }
  }
  return hits;
}


// ---------- reading a session ----------

const norm = (s: string) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Faces of a multi-face card name, plus the whole name. */
const faces = (name: string) => (name.includes(" // ") ? [name, ...name.split(" // ")] : [name]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isTable = (v: unknown): v is { columns: string[]; rows: unknown[][] } =>
  isObj(v) && Array.isArray(v.columns) && Array.isArray(v.rows) && v.rows.every(Array.isArray);

/** Every table ({columns, rows}) inside a tool result, as one object per row. */
function tableRows(v: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (isTable(v)) {
    for (const row of v.rows) out.push(Object.fromEntries(v.columns.map((c, k) => [c, row[k]])));
  } else if (Array.isArray(v)) for (const x of v) tableRows(x, out);
  else if (isObj(v)) for (const x of Object.values(v)) tableRows(x, out);
  return out;
}

/** Every object with a string \`name\` inside a result, tables flattened to their rows. */
function namedRecords(v: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (isTable(v)) out.push(...tableRows(v));
  else if (Array.isArray(v)) for (const x of v) namedRecords(x, out);
  else if (isObj(v)) {
    if (typeof v.name === "string") out.push(v);
    // the commander and the plan are echoed in most results; they are not cards a tool returned
    for (const [k, x] of Object.entries(v)) if (k !== "commander") namedRecords(x, out);
  }
  return out;
}

const okResults = (t: Transcript, names: string[], before = Infinity): { i: number; e: ToolEvent }[] =>
  toolEvents(t).filter(({ i, e }) => i < before && !e.isError && names.includes(e.name));

/** The card names a set of tools returned before an event: a name column or a name field, and a bare name in a list of
 * names (the diagnosis's unread and off-plan groups). A two-face name is also known by each face. */
function returnedBy(t: Transcript, tools: string[], before = Infinity): Set<string> {
  const out = new Set<string>();
  const add = (n: unknown) => { if (typeof n === "string" && n) for (const f of faces(n)) out.add(f); };
  for (const { e } of okResults(t, tools, before)) {
    for (const r of namedRecords(e.result)) add(r.name);
    const walk = (v: unknown) => {
      if (isObj(v) && Array.isArray(v.cards)) for (const c of v.cards) add(c);
      if (Array.isArray(v)) v.forEach(walk);
      else if (isObj(v)) Object.values(v).forEach(walk);
    };
    walk(e.result);
  }
  return out;
}


/** Text outside code fences and judgment blocks, line by line (the prose of a reply). */
function proseLines(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let fenced = false;
  for (let l = 0; l < lines.length; l++) {
    if (/^\s*```/.test(lines[l])) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (SWAP_HEADING.test(lines[l])) {
      let k = l + 1;
      let bullets = false;
      for (; k < lines.length; k++) {
        if (/^\s*[-*]\s/.test(lines[k]) || (bullets && /^\s{2,}\S/.test(lines[k]))) bullets = true;
        else if (lines[k].trim() !== "") break;
      }
      l = k - 1;
      continue;
    }
    out.push(lines[l]);
  }
  return out;
}

// ---------- ISC-91: card facts ----------

type Fact = { manaValue?: number; typeLine?: string; power?: string | null; toughness?: string | null };
/** Every card fact the session's tools returned before an event, by card name (each face too). */
function factsBefore(t: Transcript, before: number): Map<string, Fact> {
  const facts = new Map<string, Fact>();
  for (const { e } of okResults(t, ["card", "find_cards", "deck_stats", "diagnose", "shortlist", "swap_candidates", "neighbors"], before)) {
    for (const r of namedRecords(e.result)) {
      if (typeof r.name !== "string") continue;
      const fact: Fact = {};
      if (typeof r.manaValue === "number") fact.manaValue = r.manaValue;
      if (typeof r.typeLine === "string") fact.typeLine = r.typeLine;
      if ("power" in r) { fact.power = r.power === null || r.power === undefined ? null : String(r.power); fact.toughness = r.toughness === null || r.toughness === undefined ? null : String(r.toughness); }
      if (Object.keys(fact).length === 0) continue;
      for (const f of faces(r.name)) facts.set(f, { ...facts.get(f), ...fact });
    }
    if (isObj(e.result) && isObj(e.result.card) && typeof e.result.card.name === "string") {
      const c = e.result.card;
      const fact: Fact = { manaValue: typeof c.manaValue === "number" ? c.manaValue : undefined, typeLine: typeof c.typeLine === "string" ? c.typeLine : undefined, power: c.power === undefined ? null : String(c.power), toughness: c.toughness === undefined ? null : String(c.toughness) };
      for (const f of faces(c.name as string)) facts.set(f, { ...facts.get(f), ...fact });
    }
  }
  return facts;
}

const TYPES = ["creature", "artifact", "enchantment", "instant", "sorcery", "land", "planeswalker", "battle"];
const MV_COMPARE = /\b(?:mana value|MV|cmc)\s*:?\s*(\d+)\s*(?:vs\.?|versus|→|->|against|compared (?:to|with))\s*(?:mana value|MV|cmc)?\s*(\d+)|\b(?:mana value|MV|cmc)\s+from\s+(\d+)\s+to\s+(\d+)\b/gi;
const MV_CLAIMS = [/(\d+)-drop\b/gi, /\b(?:mana value|MV|cmc)\s*:?\s*(\d+)/gi, /\bcosts?\s+(?:just\s+)?\{?(\d+)\}?(?![\d/])/gi];

/** ISC-91, code half: every card cost, type or stats a reply states for a card is backed by a tool result in that session that
 * returned that card, and agrees with it. A sentence that names a card beside a mana value, a cost, power and toughness or a
 * card type counts as stating a fact; one that names several cards is held only to "each card was returned". Whether a stated
 * rules-text fact matches its card is the judge stage's. \`names\` comes from scannableNames over the card store. */
export function checkFactsFromTools(t: Transcript, names: string[]): CheckResult {
  const details: string[] = [];
  let stated = 0;
  for (const { i, text } of turns(t, "assistant")) {
    const facts = factsBefore(t, i);
    for (const line of proseLines(text).concat(swapBlocks({ ...t, events: [t.events[i]] }).flatMap((b) => b.text.split("\n")))) {
      for (const sentence of line.split(/(?<=[.!?])\s+/)) {
        const s = norm(sentence).replace(FORMAT_LABELS, " ");
        const cards = namedCards(s, names);
        if (cards.length === 0) continue;
        // "mana value 4 vs 7" compares two cards' costs, so it is one claim that holds when either number is the named card's.
        const compared = [...s.matchAll(MV_COMPARE)].map((m) => [Number(m[1] ?? m[3]), Number(m[2] ?? m[4])]);
        const claimsMV = MV_CLAIMS.flatMap((re) => [...s.replace(MV_COMPARE, " ").matchAll(re)].map((m) => Number(m[1])));
        const afterName = cards.flatMap((c) => { const m = new RegExp(`${esc(c)}(?:\\*\\*)?\\s*\\((\\d+)\\)`).exec(s); return m ? [{ card: c, mv: Number(m[1]) }] : []; });
        const pt = /\btokens?\b/i.test(s) ? [] : [...s.matchAll(/(?<![+\-\d])(\d+)\s*\/\s*(\d+)(?!\d)/g)].map((m) => [m[1], m[2]]);
        const typeClaim = cards.length === 1 ? new RegExp(`${esc(cards[0])}(?:\\*\\*)?\\s+(?:is|are)\\s+(?:a|an)\\s+([a-z ,]+?)(?:[.,;:]|$)`, "i").exec(s)?.[1] : undefined;
        const typeWords = typeClaim ? TYPES.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(typeClaim)) : [];
        const makesClaim = claimsMV.length + compared.length + afterName.length + pt.length + typeWords.length > 0;
        if (!makesClaim) continue;
        stated++;
        for (const c of cards) if (!facts.has(c)) details.push(`event ${i}: states a fact about ${c}, which no tool result before it returned: ${sentence.trim().slice(0, 100)}`);
        if (cards.length === 1) {
          const f = facts.get(cards[0]);
          if (f) {
            for (const [a, b] of compared) if (f.manaValue !== undefined && f.manaValue !== a && f.manaValue !== b) details.push(`event ${i}: compares mana values ${a} and ${b} beside ${cards[0]}; the data says ${f.manaValue}`);
            for (const mv of claimsMV) if (f.manaValue !== undefined && f.manaValue !== mv) details.push(`event ${i}: says ${cards[0]} has mana value ${mv}; the data says ${f.manaValue}`);
            for (const [p, tt] of pt) if (f.power !== undefined && !/\btokens?\b/i.test(s) && (f.power === null || f.power !== p || f.toughness !== tt)) details.push(`event ${i}: says ${cards[0]} is ${p}/${tt}; the data says ${f.power === null ? "no power or toughness" : `${f.power}/${f.toughness}`}`);
            for (const w of typeWords) if (f.typeLine !== undefined && !new RegExp(`\\b${w}\\b`, "i").test(f.typeLine)) details.push(`event ${i}: says ${cards[0]} is a ${w}; the data says ${f.typeLine}`);
          }
        }
        for (const a of afterName) {
          const f = facts.get(a.card);
          if (f && f.manaValue !== undefined && f.manaValue !== a.mv) details.push(`event ${i}: shows ${a.card} at ${a.mv}; the data says mana value ${f.manaValue}`);
        }
      }
    }
  }
  return details.length ? { pass: false, details } : { pass: true, details: [`${stated} stated card fact(s), each from a result that returned the card and agreeing with it`] };
}


// ---------- ISC-110: the mana curve chart ----------

const CHART_ROW = /^\s*(?:MV\s*|mana value\s*)?(\d+\+?)\s*[:|]?\s+([█░]+)\s*(\d+)?\s*$/i;

/** ISC-110: a reply that shows the whole mana curve draws it as a chart in a code block with one row per mana value, one filled
 * cell (█) per card, the count at the end of the row and ░ padding to a common width, and every row matches the curve in a
 * deck_stats result from earlier in the session. A zero bucket may be left out. */
export function checkCurveChart(t: Transcript): CheckResult {
  const details: string[] = [];
  let charts = 0;
  for (const { i, text } of turns(t, "assistant")) {
    const lines = text.split("\n");
    const fenced = (idx: number) => { let f = false; for (let k = 0; k <= idx; k++) if (/^\s*```/.test(lines[k]) && k !== idx) f = !f; return f; };
    const barLines = lines.map((l, k) => ({ l, k })).filter(({ l }) => /[█░]/.test(l));
    if (barLines.length === 0) continue;
    const loose = barLines.filter(({ k }) => !fenced(k));
    if (loose.length) details.push(`event ${i}: a chart row sits outside a code block: ${loose[0].l.trim().slice(0, 60)}`);
    const columns = barLines.filter(({ k }) => fenced(k)).map(({ l }) => l.trim().split(/(?<=[█░]\s*\d+)\s{2,}/)); // a before and after can sit side by side
    for (let col = 0; col < Math.max(0, ...columns.map((c) => c.length)); col++) {
    const rows = columns.filter((c) => c[col] !== undefined).map((c) => ({ l: c[col], m: CHART_ROW.exec(c[col]) }));
    const parsed = rows.flatMap((r) => (r.m ? [{ bucket: r.m[1], filled: [...r.m[2]].filter((c) => c === "█").length, width: [...r.m[2]].length, count: r.m[3] === undefined ? null : Number(r.m[3]), line: r.l }] : []));
    for (const r of rows.filter((r) => !r.m)) details.push(`event ${i}: a chart row has no mana value, bars and count: ${r.l.trim().slice(0, 60)}`);
    if (parsed.length === 0) continue;
    charts++;
    const stats = okResults(t, ["deck_stats"], i).map(({ i: si, e }) => ({ si, curve: isObj(e.result) && isObj(e.result.curve) ? (e.result.curve as Record<string, unknown>) : null })).filter((x) => x.curve);
    if (stats.length === 0) { details.push(`event ${i}: a mana curve chart with no deck_stats result before it`); continue; }
    const problems = stats.map(({ si, curve }) => {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const r of parsed) {
        const key = r.bucket;
        if (seen.has(key)) out.push(`mana value ${key} appears twice`);
        seen.add(key);
        const want = curve![key];
        if (typeof want !== "number") { out.push(`mana value ${key} is not a bucket of the deck_stats curve`); continue; }
        if (r.filled !== want) out.push(`mana value ${key} has ${r.filled} filled cell(s); the deck has ${want}`);
        if (r.count === null) out.push(`mana value ${key} has no count at the end`);
        else if (r.count !== want) out.push(`mana value ${key} prints ${r.count}; the deck has ${want}`);
        if (r.width !== parsed[0].width) out.push(`mana value ${key} is padded to ${r.width}, not ${parsed[0].width}`);
      }
      for (const [k, v] of Object.entries(curve!)) if (typeof v === "number" && v > 0 && !seen.has(k)) out.push(`the row for mana value ${k} (${v} cards) is missing`);
      return { si, out };
    });
    const best = problems.find((p) => p.out.length === 0);
    if (!best) {
      const nearest = problems.reduce((a, b) => (b.out.length < a.out.length ? b : a));
      details.push(...nearest.out.map((m) => `event ${i}: ${m} (against deck_stats at event ${nearest.si})`));
    }
    }
  }
  return details.length ? { pass: false, details } : { pass: true, details: [charts ? `${charts} chart(s), every row equal to a deck_stats curve bucket` : "no reply shows the whole curve as a chart"] };
}

/** ISC-108: every swap, cut or add block carries the "my read" label, in any capitals, and "Claude's read" appears in no reply. */
export function checkMyRead(t: Transcript): CheckResult {
  const details: string[] = [];
  const blocks = swapBlocks(t);
  for (const b of blocks.filter((b) => !READ_LABEL.test(b.text))) details.push(`${b.kind} ${b.n} (event ${b.event}) has no **My read** line`);
  for (const { i, text } of turns(t, "assistant")) for (const l of text.split("\n").filter((l) => OLD_READ_LABEL.test(l))) details.push(`event ${i} says "Claude's read": ${l.trim().slice(0, 100)}`);
  return { pass: details.length === 0, details: details.length ? details : [`${blocks.length} swap block(s), each with a **My read** line; no reply says "Claude's read"`] };
}

// ---------- ISC-68: incoming cards come from a search ----------

/** ISC-68: every incoming card in a swap or add block came back from a shortlist, swap_candidates or find_cards call earlier in
 * the session. */
export function checkIncomingFromSearch(t: Transcript): CheckResult {
  const blocks = swapBlocks(t).filter((b) => b.in !== null);
  const bad = blocks.filter((b) => !returnedBy(t, ["shortlist", "swap_candidates", "find_cards"], b.event).has(b.in!));
  return bad.length
    ? { pass: false, details: bad.map((b) => `${b.kind} ${b.n} (event ${b.event}): ${b.in} came back from no shortlist, swap_candidates or find_cards call before it`) }
    : { pass: true, details: [`${blocks.length} incoming card(s), each returned by a shortlist, swap_candidates or find_cards call before its block`] };
}

// ---------- ISC-111: verdicts on the player's word ----------

const ACCEPTS = /\b(?:yes|yep|yeah|concur\w*|agree\w*|accept\w*|take|keep|add|do it|go ahead|go for it|sounds good|swap (?:it|them|that)|make (?:it|that|those|them)|lock (?:it|them) in|approve\w*|ok|okay|sure)\b/i;
const REJECTS = /\b(?:no|nope|nah|reject\w*|skip|pass|don'?t|do not|drop|leave it|not that)\b/i;
const EVERY = /\b(?:all|both|every|each|those|them|the rest|everything)\b/i;

/** The swap numbers a player's words name: "1", "swap 2", "1 and 3", "1-3", "1 to 3". */
function numbersNamed(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/(\d+)\s*(?:-|–|to|through|thru)\s*(\d+)/gi)) for (let n = Number(m[1]); n <= Number(m[2]) && n < 100; n++) out.add(n);
  for (const m of text.matchAll(/\d+/g)) out.add(Number(m[0]));
  return out;
}

/** ISC-111: accept_swap and reject_swap run only on the player's own word for that swap. The latest player turn before each call
 * gives the verdict (an accepting word for accept_swap, a rejecting one for reject_swap) and names that swap: the card it adds or
 * cuts, its number in a block Claude showed before that turn, or every swap at once. A lever pick, silence, or "looks interesting"
 * is no verdict. */
export function checkVerdictsOnPlayersWord(t: Transcript): CheckResult {
  const calls = toolEvents(t).filter(({ e }) => e.name === "accept_swap" || e.name === "reject_swap");
  const details: string[] = [];
  const users = turns(t, "user");
  const blocks = swapBlocks(t);
  for (const { i, e } of calls) {
    const accept = e.name === "accept_swap";
    const out = typeof e.input.out === "string" ? e.input.out : null;
    const inn = typeof e.input.in === "string" ? e.input.in : null;
    const label = `${e.name} ${[out, inn].filter(Boolean).join(" → ")}`;
    const u = [...users].reverse().find((x) => x.i < i);
    if (!u) { details.push(`event ${i}: ${label} ran with no player turn before it`); continue; }
    const between = blocks.some((b) => b.event > u.i && b.event < i); // a status line is not a new offer; swaps shown since are
    if (between) { details.push(`event ${i}: ${label} ran after a reply that came after the player's last word (event ${u.i})`); continue; }
    const word = accept ? ACCEPTS.test(u.text) : REJECTS.test(u.text);
    if (!word) { details.push(`event ${i}: ${label}, but the player's last turn (event ${u.i}) does not ${accept ? "accept" : "reject"} anything`); continue; }
    const names = [out, inn].filter((x): x is string => !!x).some((n) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(n)}(?![\\p{L}\\p{N}])`, "iu").test(u.text));
    const block = blocks.find((b) => b.event < u.i && ((out !== null && b.out === out) || (inn !== null && b.in === inn)));
    const byNumber = block !== undefined && numbersNamed(u.text).has(block.n);
    const every = block !== undefined && EVERY.test(u.text);
    if (!names && !byNumber && !every) details.push(`event ${i}: ${label}, but the player's turn at event ${u.i} names no card of that swap and no shown swap number${block ? ` (it was swap ${block.n})` : " (no block showed it)"}`);
  }
  return details.length ? { pass: false, details } : { pass: true, details: [`${calls.length} verdict call(s), each on the player's word for that swap`] };
}

// ---------- grading a whole session ----------

export type Graded = { id: string; title: string; result: CheckResult };

/** The six session checks on one transcript. `names` comes from scannableNames over the card store. */
export function gradeSession(t: Transcript, names: string[]): Graded[] {
  return [
    { id: "ISC-111", title: "verdicts run on the player's word", result: checkVerdictsOnPlayersWord(t) },
    { id: "ISC-91", title: "card facts come from tool results", result: checkFactsFromTools(t, names) },
    { id: "ISC-68", title: "incoming cards came from a search", result: checkIncomingFromSearch(t) },
    { id: "ISC-29", title: "no tool or code vocabulary in a reply", result: checkNoToolTalk(t) },
    { id: "ISC-108", title: "\"my read\" on every block; \"Claude's read\" nowhere", result: checkMyRead(t) },
    { id: "ISC-110", title: "the curve chart matches deck_stats", result: checkCurveChart(t) },
  ];
}
