// DT-6.16, ISC-102: replays the mtg-deck tool calls of a Claude Code session against the current server code and
// reports how many characters each tool returns, before (the session's own results) and now, and whether every card
// fact the session's replies used is still in the results.
//   bun scripts/payload-replay.ts <transcript.jsonl> [--seed <deckFile>=<source>]... [--compare <server dir>]
//                                 [--server <server dir>] [--card-facts-once] [--dump <dir>] [--json]
// A transcript holds the player's decklist and file paths: read it where it lies, never copy it into the repo.
//
// Deck files are never touched. Every deck file a call names is copied into a temp folder first (from `--seed` when
// given, for a file the session created or changed before its first tool call), and the calls run against the copies,
// so accept_swap rewrites a copy. Verdict labels go to the temp folder too. `--server` runs another checkout's server
// code (its `server/` folder) instead of this one; `--compare` also replays another checkout's server code and reports
// it as "before", and a fact then counts as lost only if that code still returned it (facts the session got from older
// code that no longer returns them are counted apart). `--dump` writes each replayed result to a folder for reading
// (it holds the player's cards: keep it out of the repo). `--card-facts-once` asks for the deck's card facts
// (`cardFacts: true`) on the first deck_stats or diagnose call of this checkout's replay, as a session that follows the
// skill does; a session recorded before DT-6.16 never passes the flag. Exits 1 on a tool error, a missing deck file or a
// lost fact.
//
// The facts a session's replies used are found by reading the replies against the session's own tool results:
//   name       a card name (or a two-faced card's front name) a reply quotes, which a tool result returned
//   manaValue  a quoted card's mana value, or its price, written beside it in a reply (or under the heading naming it)
//   price
//   count      a number written beside a card, a deck role or a deck number ("average mana value", "lands") that a tool
//              result gave that card, role or number, compared at the reply's rounding (3.09 matches 3.094)
//   phrase     four or more words in a row a reply took from a result's text about a quoted card (its rules text, the
//              reason for a swap)
// A fact is still there when a replayed result holds the same card with the same value, in any shape.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

// ---------- transcript ----------
export type Call = { id: string; tool: string; input: Record<string, unknown>; original: string | null };
export type Transcript = { calls: Call[]; replies: string[] };

const TOOL_NAME = /mtg-deck__([a-z_]+)$/;
type Block = { type?: string; id?: string; name?: string; input?: unknown; text?: string; tool_use_id?: string; content?: unknown };

const resultText = (content: unknown): string =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.map((c: { text?: unknown }) => (typeof c?.text === "string" ? c.text : "")).join("")
    : "";

/** The mtg-deck tool calls of a Claude Code transcript (JSONL), in order, each with the result text it got, and the assistant's replies. */
export function readTranscript(jsonl: string): Transcript {
  const calls: Call[] = [], replies: string[] = [];
  const byId = new Map<string, Call>();
  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    const entry = JSON.parse(raw) as { type?: string; message?: { content?: unknown } };
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Block[]) {
      if (entry.type === "assistant" && b.type === "text" && typeof b.text === "string") replies.push(b.text);
      if (b.type === "tool_use" && typeof b.name === "string" && typeof b.id === "string") {
        const m = TOOL_NAME.exec(b.name);
        if (!m) continue;
        const call: Call = { id: b.id, tool: m[1], input: (b.input ?? {}) as Record<string, unknown>, original: null };
        calls.push(call);
        byId.set(b.id, call);
      }
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const call = byId.get(b.tool_use_id);
        if (call) call.original = resultText(b.content);
      }
    }
  }
  return { calls, replies };
}

/** A result's size: the characters the model reads, and the same text escaped as the transcript stores it. */
export const resultSize = (text: string) => ({ chars: text.length, escaped: JSON.stringify(text).length });

// ---------- facts ----------
export type Fact =
  | { kind: "name"; card: string }
  | { kind: "manaValue"; card: string; value: number }
  | { kind: "price"; card: string; value: number }
  | { kind: "count"; entity: string; value: number }
  | { kind: "phrase"; card: string; text: string };
export type Vocab = { cards: string[]; roles: string[] };

const MV_KEYS = new Set(["manaValue", "mv", "cmc"]);
const PRICE_KEYS = new Set(["usd", "price"]);
const NAME_KEYS = new Set(["name", "out", "in", "card"]);
const ENTITY_KEYS = new Set(["role", "theme", "event", "mechanic"]);
// deck-number keys too generic to name a number in a reply
const GENERIC_KEYS = new Set(["count", "target", "total", "rank", "score", "fit", "fits", "expected", "of", "offset", "similarity", "line", "limit", "weight"]);

// file paths name no card fact (and differ between a session and its replay)
const PATH_KEYS = new Set(["deckFile", "file", "path"]);

const words = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
/** A key naming a deck number a reply can quote ("averageManaValue" → "average mana value"), or null. */
const statKey = (key: string): string | null =>
  GENERIC_KEYS.has(key) || MV_KEYS.has(key) || PRICE_KEYS.has(key) || !/[a-z]/i.test(key) ? null : words(key);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const decimals = (n: number) => (String(n).split(".")[1] ?? "").length;
const roundTo = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };

/** What a set of tool results says, by card and by entity, in any shape. */
type Index = {
  text: string; // every result as JSON text
  mv: Map<string, number[]>; price: Map<string, number[]>; // by card name
  nums: Map<string, number[]>; // by entity (lower case): a card, a role, a deck-number key in words, a map key
  strings: Map<string, string[]>; // by card name: normalized text found beside it
  statKeys: Set<string>; // deck-number keys in words
};

const numberMap = (c: unknown): c is Record<string, number> => isObj(c) && Object.values(c).length > 0 && Object.values(c).every((x) => typeof x === "number");

/** Rows under named columns (`{columns: [...], rows: [[...], ...]}`, any key for the rows) as the objects they stand for. */
function untable(v: Record<string, unknown>): Record<string, unknown> {
  const cols = v.columns;
  if (!Array.isArray(cols) || !cols.every((c) => typeof c === "string")) return v;
  const out: Record<string, unknown> = {};
  for (const [k, c] of Object.entries(v)) {
    if (k === "columns") continue;
    out[k] = Array.isArray(c) && c.every((row) => Array.isArray(row) && row.length === cols.length)
      ? c.map((row: unknown[]) => Object.fromEntries(cols.map((col, i) => [col, row[i]])))
      : c;
  }
  return out;
}

function indexOf(results: unknown[]): Index {
  const ix: Index = { text: results.map((r) => JSON.stringify(r)).join("\n"), mv: new Map(), price: new Map(), nums: new Map(), strings: new Map(), statKeys: new Set() };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!isObj(value)) return;
    const v = untable(value);
    const own = typeof v.name === "string" ? v.name : null;
    const names = new Set<string>(own ? [own] : []);
    for (const [k, c] of Object.entries(v)) {
      if (isObj(c) && typeof c.name === "string") names.add(c.name);
      if (NAME_KEYS.has(k) && typeof c === "string") names.add(c);
    }
    for (const [k, c] of Object.entries(v)) {
      const stat = statKey(k);
      const count = (x: number) => { if (stat) { push(ix.nums, stat, x); ix.statKeys.add(stat); } };
      if (typeof c === "number") {
        if (own && MV_KEYS.has(k)) push(ix.mv, own, c);
        else if (own && PRICE_KEYS.has(k)) push(ix.price, own, c);
        else if (own) push(ix.nums, own.toLowerCase(), c);
        for (const e of ENTITY_KEYS) if (typeof v[e] === "string") push(ix.nums, (v[e] as string).toLowerCase(), c);
        count(c);
      } else if (typeof c === "string" && !NAME_KEYS.has(k) && !PATH_KEYS.has(k)) {
        for (const n of names) push(ix.strings, n, norm(c));
      } else if (numberMap(c)) {
        // a map of numbers (role counts, a curve, pips, a few deck numbers): each key names its number; a one-letter or
        // digit key (a color, a curve slot) names no deck number of its own
        for (const [ik, x] of Object.entries(c)) {
          push(ix.nums, ik.toLowerCase(), x);
          count(x);
          const inner = ik.length > 1 ? statKey(ik) : null;
          if (inner) { if (inner !== ik.toLowerCase()) push(ix.nums, inner, x); ix.statKeys.add(inner); }
        }
        continue;
      } else if (Array.isArray(c) && c.length && c.every((x) => typeof x === "number")) {
        (c as number[]).forEach(count);
      }
      walk(c);
    }
  };
  results.forEach(walk);
  return ix;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const presentIn = (text: string, name: string) =>
  new RegExp(`(^|[^A-Za-z0-9])${escapeRe(JSON.stringify(name).slice(1, -1))}($|[^A-Za-z0-9])`).test(text);

/** Card names in a line, longest match first at each word start, as full names (a front-face name stands for its card). */
function namesIn(line: string, starts: Map<string, [string, string][]>): { names: string[]; rest: string } {
  const names: string[] = [];
  let rest = "";
  for (let i = 0; i < line.length;) {
    const atStart = i === 0 || !/[A-Za-z0-9']/.test(line[i - 1]);
    const first = atStart ? /^[A-Za-z0-9'][A-Za-z0-9'-]*/.exec(line.slice(i))?.[0] : undefined;
    const hit = first ? starts.get(first)?.find(([written]) => line.startsWith(written, i) && !/[A-Za-z0-9]/.test(line[i + written.length] ?? "")) : undefined;
    if (hit) { names.push(hit[1]); rest += " ".repeat(hit[0].length); i += hit[0].length; }
    else { rest += line[i]; i++; }
  }
  return { names, rest };
}

// a number standing alone; one that labels rather than counts ("4+", "6-drops", "power-4") is left out
const NUMBER = /(\$)?(?<![A-Za-z0-9.]|[A-Za-z]-)(\d+(?:\.\d+)?)(?![A-Za-z0-9+]|\.\d|-[A-Za-z])/g;
const has = (xs: number[] | undefined, shown: number) => !!xs?.some((x) => roundTo(x, decimals(shown)) === shown);

/** Runs of four or more words a line shares with a text, longest first, none inside another. */
function sharedRuns(line: string, text: string): string[] {
  const a = line.split(" ").filter(Boolean), b = text.split(" ").filter(Boolean);
  const runs: string[] = [];
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    if (a[i] !== b[j] || (i > 0 && j > 0 && a[i - 1] === b[j - 1])) continue;
    let n = 0;
    while (i + n < a.length && j + n < b.length && a[i + n] === b[j + n]) n++;
    if (n >= 4) runs.push(a.slice(i, i + n).join(" "));
  }
  return [...new Set(runs)].sort((x, y) => y.length - x.length).filter((r, k, all) => !all.slice(0, k).some((longer) => ` ${longer} `.includes(` ${r} `)));
}

const KIND_ORDER = ["name", "manaValue", "price", "count", "phrase"];
const factKey = (f: Fact) => JSON.stringify(f);
const factSort = (a: Fact, b: Fact) => {
  const ka = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  if (ka) return ka;
  const sa = factKey(a), sb = factKey(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
};

/** The card facts a session's replies used: read from the replies against the session's own tool results. `sources`,
 * when given, gets the reply line each fact was first read from, keyed by the fact as JSON. */
export function factsUsed(replies: string[], originals: unknown[], vocab: Vocab, sources?: Map<string, string>): Fact[] {
  const ix = indexOf(originals);
  const starts = new Map<string, [string, string][]>();
  for (const full of vocab.cards) {
    for (const written of new Set([full, full.split(" // ")[0]])) {
      const first = /^[A-Za-z0-9'][A-Za-z0-9'-]*/.exec(written)?.[0];
      if (first) push(starts, first, [written, full] as [string, string]);
    }
  }
  for (const list of starts.values()) list.sort((x, y) => y[0].length - x[0].length);
  const entities = [...new Set([...vocab.roles.map((r) => r.toLowerCase()), ...ix.statKeys])].sort((x, y) => y.length - x.length);
  const facts = new Map<string, Fact>();
  let line = "";
  const add = (f: Fact) => { const k = factKey(f); facts.set(k, f); if (sources && !sources.has(k)) sources.set(k, line); };
  for (const reply of replies) {
    let heading: string[] = [];
    for (line of reply.split("\n")) {
      const found = namesIn(line, starts);
      if (/^\s*#/.test(line)) heading = found.names;
      const cards = [...new Set([...found.names, ...(/^\s*#/.test(line) ? [] : heading)])].filter((c) => presentIn(ix.text, c));
      for (const c of found.names) if (presentIn(ix.text, c)) add({ kind: "name", card: c });
      const nums = [...found.rest.matchAll(NUMBER)].map((m) => ({ dollar: !!m[1], value: Number(m[2]) }));
      for (const card of cards) {
        for (const n of nums) {
          if (n.dollar) { if (has(ix.price.get(card), n.value)) add({ kind: "price", card, value: n.value }); continue; }
          if (has(ix.mv.get(card), n.value)) add({ kind: "manaValue", card, value: n.value });
          else if (found.names.includes(card) && has(ix.nums.get(card.toLowerCase()), n.value)) add({ kind: "count", entity: card, value: n.value });
        }
        for (const s of ix.strings.get(card) ?? []) for (const run of sharedRuns(norm(line), s)) add({ kind: "phrase", card, text: run });
      }
      const lower = found.rest.toLowerCase();
      for (const e of entities) {
        if (!new RegExp(`(^|[^a-z])${escapeRe(e)}s?($|[^a-z])`).test(lower)) continue;
        for (const n of nums) if (!n.dollar && has(ix.nums.get(e), n.value)) add({ kind: "count", entity: e, value: n.value });
      }
    }
  }
  return [...facts.values()].sort(factSort);
}

/** The facts a set of replayed results no longer holds, in a stable order. */
export function missingFacts(facts: Fact[], results: unknown[]): Fact[] {
  const ix = indexOf(results);
  const holds = (f: Fact): boolean => {
    switch (f.kind) {
      case "name": return presentIn(ix.text, f.card);
      case "manaValue": return has(ix.mv.get(f.card), f.value);
      case "price": return has(ix.price.get(f.card), f.value);
      case "count": return has(ix.nums.get(f.entity.toLowerCase()), f.value);
      case "phrase": return (ix.strings.get(f.card) ?? []).some((s) => ` ${s} `.includes(` ${f.text} `));
    }
  };
  return facts.filter((f) => !holds(f)).sort(factSort);
}

// ---------- replay ----------
const parse = (text: string | null): unknown => {
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return text; }
};

type Size = { chars: number; escaped: number };
type Run = { sizes: Map<string, { calls: number; size: Size; errors: number; skipped: number }>; results: unknown[]; cards: string[]; roles: string[] };
type Options = { seeds: Map<string, string>; dump?: string; cardFactsOnce?: boolean };

/** Every mtg-deck call of a transcript run through one checkout's server code, on temp copies of the deck files. */
async function replayWith(serverDir: string, calls: Call[], opts: Options): Promise<Run> {
  const tmp = mkdtempSync(join(tmpdir(), "payload-replay-"));
  try {
    // paths.ts reads these when the server code loads: labels into the temp folder, the store from this checkout
    process.env.MTG_DECK_DB ??= resolve(import.meta.dir, "../data/cards.db");
    process.env.CLAUDE_PLUGIN_DATA = join(tmp, "plugin-data");
    mkdirSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true });
    const { openStore } = await import(join(serverDir, "deck-tools.ts"));
    const { createDeckServer } = await import(join(serverDir, "mcp.ts"));
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const store = openStore();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createDeckServer(store).connect(a);
    const client = new Client({ name: "payload-replay", version: "0" });
    await client.connect(b);

    const copies = new Map<string, string | null>();
    const copyOf = (deckFile: string): string | null => {
      if (!copies.has(deckFile)) {
        const source = opts.seeds.get(deckFile) ?? deckFile;
        const dest = join(tmp, `${copies.size}-${basename(deckFile)}`);
        copies.set(deckFile, existsSync(source) ? (copyFileSync(source, dest), dest) : null);
      }
      return copies.get(deckFile)!;
    };

    const run: Run = { sizes: new Map(), results: [], cards: [], roles: [] };
    let askedFacts = false;
    for (const [i, call] of calls.entries()) {
      const row = run.sizes.get(call.tool) ?? { calls: 0, size: { chars: 0, escaped: 0 }, errors: 0, skipped: 0 };
      run.sizes.set(call.tool, row);
      row.calls++;
      const input = { ...call.input };
      if (opts.cardFactsOnce && !askedFacts && (call.tool === "deck_stats" || call.tool === "diagnose")) { input.cardFacts = true; askedFacts = true; }
      if (typeof input.deckFile === "string") {
        const copy = copyOf(input.deckFile);
        if (!copy) { row.skipped++; continue; }
        input.deckFile = copy;
      }
      const res = await client.callTool({ name: call.tool, arguments: input }) as { isError?: boolean; content: { text?: string }[] };
      const text = res.content.map((c) => c.text ?? "").join("");
      if (res.isError) row.errors++;
      const s = resultSize(text);
      row.size.chars += s.chars; row.size.escaped += s.escaped;
      run.results.push(parse(text));
      if (opts.dump) { mkdirSync(opts.dump, { recursive: true }); writeFileSync(join(opts.dump, `${String(i).padStart(2, "0")}-${call.tool}.json`), text); }
    }
    await client.close();
    run.cards = (store.names as { name: string }[]).map((n) => n.name);
    run.roles = (JSON.parse(readFileSync(join(serverDir, "roles.json"), "utf8")).roles as { role: string }[]).map((r) => r.role);
    store.db.close();
    return run;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const USAGE = "usage: bun scripts/payload-replay.ts <transcript.jsonl> [--seed <deckFile>=<source>]... [--compare <server dir>] [--server <server dir>] [--card-facts-once] [--dump <dir>] [--json]";

async function main(argv: string[]) {
  const opts: Options = { seeds: new Map() };
  let serverDir = resolve(import.meta.dir, "../server"), compareDir: string | undefined, json = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(USAGE); return v; };
    if (argv[i] === "--json") json = true;
    else if (argv[i] === "--seed") { const [k, ...v] = next().split("="); if (!v.length) throw new Error(USAGE); opts.seeds.set(k, v.join("=")); }
    else if (argv[i] === "--server") serverDir = resolve(next());
    else if (argv[i] === "--compare") compareDir = resolve(next());
    else if (argv[i] === "--dump") opts.dump = resolve(next());
    else if (argv[i] === "--card-facts-once") opts.cardFactsOnce = true;
    else rest.push(argv[i]);
  }
  const file = rest[0];
  if (!file || !existsSync(file)) throw new Error(USAGE);
  const t = readTranscript(readFileSync(file, "utf8"));

  const now = await replayWith(serverDir, t.calls, opts);
  const then = compareDir ? await replayWith(compareDir, t.calls, { seeds: opts.seeds }) : undefined;
  const originals = t.calls.map((c) => parse(c.original)).filter((o) => o !== null);
  const sources = new Map<string, string>();
  const facts = factsUsed(t.replies, originals, { cards: now.cards, roles: now.roles }, sources);
  const missing = missingFacts(facts, now.results);
  // with --compare, a fact counts as lost only when the compared code still returned it
  const missingThen = then ? missingFacts(facts, then.results) : undefined;
  const lost = missingThen ? missing.filter((f) => !missingThen.some((g) => factKey(g) === factKey(f))) : missing;

  const tools = [...new Set(t.calls.map((c) => c.tool))];
  const session = new Map<string, Size>();
  for (const c of t.calls) {
    const s = session.get(c.tool) ?? { chars: 0, escaped: 0 }, r = resultSize(c.original ?? "");
    session.set(c.tool, { chars: s.chars + r.chars, escaped: s.escaped + r.escaped });
  }
  const sum = (sizes: (Size | undefined)[]) => sizes.reduce<Size>((a, s) => ({ chars: a.chars + (s?.chars ?? 0), escaped: a.escaped + (s?.escaped ?? 0) }), { chars: 0, escaped: 0 });
  const rows = tools.map((tool) => ({
    tool, calls: now.sizes.get(tool)!.calls, session: session.get(tool)!, before: then?.sizes.get(tool)?.size, now: now.sizes.get(tool)!.size,
    errors: now.sizes.get(tool)!.errors, skipped: now.sizes.get(tool)!.skipped,
  }));
  const total = { session: sum(rows.map((r) => r.session)), before: then ? sum(rows.map((r) => r.before)) : undefined, now: sum(rows.map((r) => r.now)) };
  const counts = Object.fromEntries(KIND_ORDER.map((k) => [k, facts.filter((f) => f.kind === k).length]));
  const errors = rows.reduce((n, r) => n + r.errors + r.skipped, 0) + (then ? [...then.sizes.values()].reduce((n, r) => n + r.errors + r.skipped, 0) : 0);

  if (json) {
    console.log(JSON.stringify({ rows, total, facts: counts, missing, missingBefore: missingThen, lost }, null, 2));
  } else {
    const pad = (s: string | number, n: number) => String(s).padStart(n);
    const cell = (s?: Size) => (s ? `${pad(s.chars, 9)}${pad(`(${s.escaped})`, 10)}` : `${pad("-", 9)}${pad("", 10)}`);
    console.log(`${"tool".padEnd(18)}${pad("calls", 6)}${pad("session", 19)}${pad("before", 19)}${pad("now", 19)}  (escaped as the transcript stores it)`);
    for (const r of rows) {
      const notes = [r.errors && `${r.errors} error(s)`, r.skipped && `${r.skipped} skipped: deck file missing`].filter(Boolean).join(", ");
      console.log(`${r.tool.padEnd(18)}${pad(r.calls, 6)}${cell(r.session)}${cell(r.before)}${cell(r.now)}  ${notes}`);
    }
    console.log(`${"total".padEnd(18)}${pad(t.calls.length, 6)}${cell(total.session)}${cell(total.before)}${cell(total.now)}`);
    console.log(`facts used by the replies: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}`);
    if (missingThen) console.log(`missing before (the compared code no longer returns them either): ${missingThen.length}`);
    console.log(`missing now: ${missing.length}`);
    console.log(lost.length ? `LOST (${lost.length}):` : then ? "no fact the compared code returned is lost" : "every fact used is still in the replay");
    for (const f of lost) console.log(`  ${JSON.stringify(f)}\n      from the reply line: ${sources.get(factKey(f))?.trim()}`);
  }
  if (errors || lost.length) process.exitCode = 1;
}

if (import.meta.main) await main(process.argv.slice(2));
