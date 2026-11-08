// MV-17, DT-6.7: the code stage of the deck-tune eval: six session checks (ISC-111, 91, 68, 29, 108, 110) and the product-code
// probe ISC-83. Every session check is shown red on a bad example before it is shown green; the sessions are small and built here
// from generic cards.

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  cardNamesInLiterals, checkCurveChart, checkFactsFromTools, checkIncomingFromSearch, checkMyRead, checkNoToolTalk, checkVerdictsOnPlayersWord,
  gradeSession, namedCards, scannableNames, stringLiterals,
} from "./deck-tune-checks";
import { openStore } from "./deck-tools";
import { caseMatches } from "./deck-tune-eval";
import { parseTranscript, readTranscript, serializeTranscript, TranscriptError, type Transcript, type TranscriptEvent } from "./deck-tune-transcript";

// grading a session scans every card name of the store against each sentence
setDefaultTimeout(120_000);
const DIR = new URL("../docs/research/deck-tune/", import.meta.url).pathname;
let names: string[] = [];
beforeAll(() => { names = scannableNames(openStore().names.map((n) => n.name)); });

// ---------- small sessions ----------
const user = (text: string): TranscriptEvent => ({ kind: "user", text });
const say = (text: string): TranscriptEvent => ({ kind: "assistant", text });
const call = (name: string, input: Record<string, unknown>, result: unknown, isError = false): TranscriptEvent => ({ kind: "tool", server: "mtg-deck", name, input, result, isError });
const session = (...events: TranscriptEvent[]): Transcript => ({
  header: { kind: "header", agentPlayed: true, playedBy: "synthetic", skill: "plugin/skills/deck-tune/SKILL.md", title: "t", note: "n", recordedAt: "2026-11-08T00:00:00.000Z" },
  events,
});
const table = (columns: string[], rows: unknown[][]) => ({ columns, rows });
const CURVE = { "0": 0, "1": 12, "2": 23, "3": 8, "4": 7, "5": 5, "6": 3, "7+": 6 };
const STATS = call("deck_stats", { cardFacts: true }, {
  curve: CURVE,
  cardFacts: table(["name", "manaValue", "typeLine", "power", "toughness", "oracleText"], [
    ["Arcane Signet", 2, "Artifact", null, null, "{T}: Add one mana."], ["Counterspell", 2, "Instant", null, null, "Counter target spell."],
    ["Harmonize", 4, "Sorcery", null, null, "Draw three cards."]]),
});
const SHORT = call("shortlist", { plan: { themes: ["Ramp"] } }, { cards: table(["name", "manaValue", "typeLine"], [["Cultivate", 3, "Sorcery"], ["Farseek", 2, "Sorcery"]]) });
const block = (n: number, out: string, inn: string, read = "- **My read:** it fits.") =>
  [`### Swap ${n}: ${out} → ${inn}`, "- **Reason (data):** the same job; mana value 2 → 3.", "- **Deck after:** average mana value 3.09 → 3.11.", read].filter(Boolean).join("\n");
const TWO = `${block(1, "Counterspell", "Cultivate")}\n\n${block(2, "Harmonize", "Farseek")}\n\nWant either?`;
const accept = (out: string, inn: string) => call("accept_swap", { out, in: inn }, { verdict: "accept" });
const reject = (out: string, inn: string) => call("reject_swap", { out, in: inn }, { verdict: "reject" });
const shown = [user("make my deck better"), STATS, SHORT, say(TWO)];

// ---------- ISC-111 ----------
describe("ISC-111: accept and reject run only on the player's own word for that swap", () => {
  test("ISC-111 goes red on silence, a hedge, a lever pick, the wrong swap number and the wrong verdict, then green on the player's word", () => {
    const red = (...rest: TranscriptEvent[]) => checkVerdictsOnPlayersWord(session(...shown, ...rest));
    expect(red(accept("Counterspell", "Cultivate")).details.join()).toContain("after a reply that came after the player's last word"); // silence: the swaps were just shown
    expect(checkVerdictsOnPlayersWord(session(accept("Counterspell", "Cultivate"))).details.join()).toContain("ran with no player turn before it");
    expect(checkVerdictsOnPlayersWord(session(user("make it better"), STATS, say("Which lever?"), user("1"), SHORT, say(TWO), accept("Counterspell", "Cultivate"))).pass).toBe(false); // the lever pick is not a verdict
    expect(red(user("looks interesting"), accept("Counterspell", "Cultivate")).details.join()).toContain("does not accept anything");
    expect(red(user("yes, take swap 2"), accept("Counterspell", "Cultivate")).details.join()).toContain("names no card of that swap");
    expect(red(user("yes, take swap 1"), reject("Counterspell", "Cultivate")).details.join()).toContain("does not reject anything");
    expect(red(user("yes take 1"), say("Done."), accept("Counterspell", "Cultivate")).pass).toBe(false); // Claude spoke after the player's last word
    expect(red(user("yes, take swap 1"), accept("Counterspell", "Cultivate"))).toEqual({ pass: true, details: ["1 verdict call(s), each on the player's word for that swap"] });
  });

  test("ISC-111 takes the player's word by card name, number, range or 'all', and a reject on a no", () => {
    const ok = (...rest: TranscriptEvent[]) => checkVerdictsOnPlayersWord(session(...shown, ...rest)).pass;
    expect(ok(user("no, skip the Farseek one"), reject("Harmonize", "Farseek"))).toBe(true);
    expect(ok(user("sure, add cultivate"), accept("Counterspell", "Cultivate"))).toBe(true);
    expect(ok(user("take 1-2"), accept("Counterspell", "Cultivate"), accept("Harmonize", "Farseek"))).toBe(true);
    expect(ok(user("yes, both"), accept("Counterspell", "Cultivate"), accept("Harmonize", "Farseek"))).toBe(true);
    expect(ok(user("take swap 1 and 2"), accept("Counterspell", "Cultivate"), accept("Harmonize", "Farseek"))).toBe(true);
    expect(ok(user("take swap 1"), accept("Counterspell", "Cultivate"), accept("Harmonize", "Farseek"))).toBe(false); // swap 2 was not named
    expect(checkVerdictsOnPlayersWord(session(user("yes, swap Counterspell for Cultivate"), accept("Counterspell", "Cultivate"))).pass).toBe(true); // a swap the player asked for in their own words
  });
});

// ---------- ISC-91 ----------
describe("ISC-91: card facts come from tool results", () => {
  const say1 = (line: string) => checkFactsFromTools(session(STATS, SHORT, say(line)), names);

  test("ISC-91 goes red on a mana value that contradicts the data, a card no tool returned, a wrong stat or type, then green on facts that match", () => {
    expect(say1("Cultivate costs 5 mana.").details.join()).toContain("says Cultivate has mana value 5; the data says 3");
    expect(say1("Wayfarer's Bauble is a 1-drop that fetches a basic.").details.join()).toContain("Wayfarer's Bauble");
    expect(say1("Harmonize is a 7-drop.").pass).toBe(false);
    expect(say1("Arcane Signet is a 3/3 for 2.").pass).toBe(false);
    expect(say1("Arcane Signet is an instant.").pass).toBe(false);
    expect(say1("**Farseek** (4) fetches a land.").pass).toBe(false);
    expect(say1("Harmonize is mana value 2 vs 3, so it saves one.").pass).toBe(false);
    expect(say1("Cultivate costs 3 mana.")).toMatchObject({ pass: true });
    expect(say1("Harmonize is a 4-drop.").pass).toBe(true);
    expect(say1("Arcane Signet is an artifact.").pass).toBe(true);
    expect(say1("**Farseek** (2) fetches a land.").pass).toBe(true);
    expect(say1("Harmonize is mana value 2 vs 4, so it saves two.").pass).toBe(true);
  });

  test("ISC-91 a card named with no fact stated needs no result, and a result that came after the reply does not count", () => {
    expect(say1("I like Wayfarer's Bauble in general.").pass).toBe(true);
    expect(checkFactsFromTools(session(say("Cultivate costs 3 mana."), SHORT), names).pass).toBe(false);
  });
});

// ---------- ISC-68 ----------
describe("ISC-68: every incoming card came from a shortlist, swap_candidates or find_cards call", () => {
  test("ISC-68 goes red on an incoming card from memory or returned only after its block, then green on each of the three tools", () => {
    expect(checkIncomingFromSearch(session(STATS, SHORT, say(block(1, "Counterspell", "Wayfarer's Bauble")))).details.join()).toContain("Wayfarer's Bauble came back from no shortlist");
    expect(checkIncomingFromSearch(session(STATS, say(block(1, "Counterspell", "Cultivate")), SHORT)).pass).toBe(false);
    const found = call("find_cards", {}, { cards: table(["name", "manaValue"], [["Cultivate", 3]]) });
    const paired = call("swap_candidates", {}, { candidates: [{ out: { name: "Counterspell" }, in: { name: "Cultivate" } }] });
    for (const tool of [SHORT, found, paired]) expect(checkIncomingFromSearch(session(STATS, tool, say(block(1, "Counterspell", "Cultivate"))))).toMatchObject({ pass: true });
    expect(checkIncomingFromSearch(session(STATS, say("No swaps yet.")))).toMatchObject({ pass: true });
  });
});

// ---------- ISC-108 ----------
describe("ISC-108: Claude's own judgment is labeled my read, and Claude's read appears in no reply", () => {
  test("ISC-108 goes red on a block with the old label or none, and on the old label anywhere in a reply, then green on my read in any capitals", () => {
    const old = block(1, "Counterspell", "Cultivate", "- **Claude's read** (my own Magic knowledge, not the data): it fits.");
    expect(checkMyRead(session(say(old))).details.join()).toContain("Swap 1 (event 0) has no **My read** line");
    expect(checkMyRead(session(say(block(1, "Counterspell", "Cultivate", "")))).pass).toBe(false);
    for (const line of ["**Claude’s read**: keep it.", "claude's READ: keep it.", `${block(1, "Counterspell", "Cultivate")}\n\nMy view, **Claude's read**.`]) {
      expect([line, checkMyRead(session(say(line))).pass]).toEqual([line, false]);
    }
    for (const label of ["**My read:**", "**MY READ:**", "**my read**:", "**My Read**:", "** my read **"]) {
      expect([label, checkMyRead(session(say(block(1, "Counterspell", "Cultivate", `- ${label} it fits.`)))).pass]).toEqual([label, true]);
    }
    expect(checkMyRead(session(say(TWO)))).toEqual({ pass: true, details: ['2 swap block(s), each with a **My read** line; no reply says "Claude\'s read"'] });
  });
});

// ---------- ISC-110 ----------
describe("ISC-110: the mana curve chart matches deck_stats", () => {
  const rows = (curve: Record<string, number>) => { const max = Math.max(...Object.values(curve)); return Object.entries(curve).map(([k, n]) => `${k.padEnd(2)} ${"█".repeat(n)}${"░".repeat(max - n)} ${String(n).padStart(2)}`); };
  const fence = (r: string[]) => `\`\`\`\n${r.join("\n")}\n\`\`\``;
  const withChart = (text: string, stats = STATS) => session(stats, say(text));
  const good = rows(CURVE);

  test("ISC-110 goes red on a cell too many, a wrong or missing count, a missing or doubled row, an unfenced chart, uneven padding and no deck_stats, then green on the true chart", () => {
    const bad = (r: string[]) => checkCurveChart(withChart(fence(r)));
    expect(bad(good.map((r) => (r.startsWith("1 ") ? r.replace("░", "█") : r))).details.join()).toContain("mana value 1 has 13 filled cell(s); the deck has 12");
    expect(bad(good.map((r) => (r.startsWith("3 ") ? r.replace(/ 8$/, " 9") : r))).details.join()).toContain("prints 9; the deck has 8");
    expect(bad(good.map((r) => (r.startsWith("3 ") ? r.replace(/ +8$/, "") : r))).details.join()).toContain("no count at the end");
    expect(bad(good.filter((r) => !r.startsWith("5"))).details.join()).toContain("the row for mana value 5 (5 cards) is missing");
    expect(bad([...good, good[1]]).details.join()).toContain("appears twice");
    expect(checkCurveChart(withChart(good.join("\n"))).details.join()).toContain("outside a code block");
    expect(bad(good.map((r) => (r.startsWith("7+") ? r.replace("░", "") : r))).details.join()).toContain("is padded to");
    expect(checkCurveChart(session(say(fence(good)))).details.join()).toContain("no deck_stats result");
    expect(bad(good)).toMatchObject({ pass: true });
  });

  test("ISC-110 leaves out a zero bucket, reads labels such as MV 3, and matches a chart to the deck_stats it came from after the deck changed", () => {
    expect(checkCurveChart(withChart(fence(good.filter((r) => !r.startsWith("0"))))).pass).toBe(true);
    expect(checkCurveChart(withChart(fence(good.map((r) => r.replace(/^(\d\+?)/, "MV $1"))))).pass).toBe(true);
    const later = { ...CURVE, "2": 24, "7+": 5 };
    const t = session(STATS, say(fence(good)), call("deck_stats", {}, { curve: later }), say(fence(rows(later))));
    expect(checkCurveChart(t).pass).toBe(true);
    expect(checkCurveChart(session(STATS, say(fence(rows(later))))).pass).toBe(false); // the later chart before the later result
    expect(checkCurveChart(session(STATS, say("No chart here."))).details).toEqual(["no reply shows the whole curve as a chart"]);
  });
});

// ---------- ISC-29 ----------
describe("ISC-29: no reply carries tool or code vocabulary", () => {
  const real = readTranscript(`${DIR}namor-more-damage.jsonl`);

  test("ISC-29 goes red on the lines flagged in a real session (2026-11-06)", () => {
    const r = checkNoToolTalk(real);
    expect(r.pass).toBe(false);
    const all = r.details.join("\n");
    for (const flagged of ["find_cards", "`redundancy`", "`plan`", "`roles`", "app/role-targets.json", "64 matches"]) expect(all).toContain(flagged);
  });

  test("ISC-29 is green on the same answer said in a player's words", () => {
    const plain = ["**Search past the levers: blue cards that pump or evade**", "", "- **Levitation** (4 mana): **My read**: my top pick.", "",
      "1. **Trim what's doubled up** (the whole deck, most likely the 11 counterspells): frees slots for the cards above.", "",
      "The first and third measure against role counts I'm suggesting, not ones you've set. Which lever do you want?"].join("\n");
    expect(checkNoToolTalk(session(say(plain)))).toEqual({ pass: true, details: ["no tool or code vocabulary in any reply"] });
  });

  test("ISC-29 flags the diagnose and shortlist tools by name and their arguments, but not the words diagnose or shortlist in a player's sentence", () => {
    const said = (line: string) => checkNoToolTalk(session(say(line)));
    for (const line of ["I ran `shortlist` for removal.", "Calling `diagnose` now.", "With engineGap set to dying:", "Under maxManaValue 3,", "offPlan cards first", "maxPrice 5 keeps it cheap", "its planPartners count is 4", "I read cardFacts first."]) {
      expect([line, said(line).pass]).toEqual([line, false]);
    }
    for (const line of ["Here's a shortlist of removal that fits.", "Let me diagnose the deck against that plan first.", "Three cards on the shortlist feed your death triggers."]) {
      expect([line, said(line).pass]).toEqual([line, true]);
    }
  });
});

describe("a transcript and the six checks together", () => {
  test("a recorded real session parses back to the same JSONL, and a malformed line is a TranscriptError, not a pass", () => {
    const real = readTranscript(`${DIR}namor-more-damage.jsonl`);
    expect(real.header.agentPlayed).toBe(false);
    expect(real.events.filter((e) => e.kind === "tool" && !e.isError).map((e) => e.kind === "tool" && e.name)).toContain("find_cards");
    expect(parseTranscript(serializeTranscript(real))).toEqual(real);
    expect(() => parseTranscript('{"kind":"header"}')).toThrow(TranscriptError);
  });

  test("gradeSession runs exactly the six, and a session that does everything right is green on all of them", () => {
    const t = session(user("make my deck better"), STATS, SHORT, say(`Here is your curve:\n\n${fenceOf(CURVE)}`), say(TWO), user("yes, take swap 1"), accept("Counterspell", "Cultivate"));
    const graded = gradeSession(t, names);
    expect(graded.map((g) => g.id)).toEqual(["ISC-111", "ISC-91", "ISC-68", "ISC-29", "ISC-108", "ISC-110"]);
    expect(graded.filter((g) => !g.result.pass).map((g) => `${g.id}: ${g.result.details.join(" | ")}`)).toEqual([]);
  });
});
function fenceOf(curve: Record<string, number>) {
  const max = Math.max(...Object.values(curve));
  return "```\n" + Object.entries(curve).map(([k, n]) => `${k.padEnd(2)} ${"█".repeat(n)}${"░".repeat(max - n)} ${String(n).padStart(2)}`).join("\n") + "\n```";
}

// ---------- the judge suite ----------
describe("the judge suite (evals/deck-tune.yaml): ISC-107, 84 and 87", () => {
  type Case = { id: string; prompt: string; assert: { type: string; value: string }[]; adversarial_output?: string };
  const text = readFileSync(new URL("../evals/deck-tune.yaml", import.meta.url).pathname, "utf8");
  const suite = Bun.YAML.parse(text) as { cases: Case[] };

  test("the judged questions name no card and no commander, and the retired label is nowhere", () => {
    const judged = suite.cases.flatMap((c) => c.assert.filter((a) => a.type === "llm-assert").map((a) => ({ id: c.id, value: a.value })));
    expect(judged.map((j) => j.id).sort()).toEqual(["isc-107-only-recommended-swaps", "isc-84-read-before-cut", "isc-87-search-the-plan"]);
    for (const { id, value } of judged) expect({ id, cards: namedCards(value, names) }).toEqual({ id, cards: [] });
    expect(text).not.toMatch(/Claude[’']s read/);
  });

  test("each case carries an adversarial fixture that passes its code-checkable prerequisites, so only the judge can fail it", () => {
    for (const c of suite.cases) {
      expect({ id: c.id, adversarial: typeof c.adversarial_output }).toEqual({ id: c.id, adversarial: "string" });
      for (const a of c.assert) {
        if (a.type === "contains") expect({ id: c.id, ok: c.adversarial_output!.includes(a.value) }).toEqual({ id: c.id, ok: true });
        if (a.type === "regex") expect({ id: c.id, ok: new RegExp(a.value).test(c.adversarial_output!) }).toEqual({ id: c.id, ok: true });
      }
    }
  });

  test("a criterion pattern selects its cases: ISC-107 takes isc-107-..., ISC-10 does not", () => {
    expect(caseMatches("isc-107-only-recommended-swaps", "ISC-107")).toBe(true);
    expect(caseMatches("isc-107-only-recommended-swaps", "ISC-10")).toBe(false);
    expect(caseMatches("isc-84-read-before-cut", "isc-84")).toBe(true);
  });
});

// DT-6.12, ISC-83 (the code probe for the no-overfitting constraint, the user, 2026-11-07): product code under server/ names no
// specific commander or card as a rule, a constant or a branch. How it reads: every string literal (and regex source) of
// every non-test, non-fixture server/**/*.ts file is checked against the card store's names. Comments are not read.
// What counts as a hit, and what does not:
//   multi-word names (and each face of a multi-face card)  a hit anywhere in a literal, at word edges, in the card's capitals
//   one-word names                                         a hit only as the whole literal, in the card's capitals
//   one-word names under five letters (Opt, Cut, Fog)      never: ordinary words (the same cut scannableNames makes)
// Exempt: nothing but the documented examples in DOC_EXAMPLES, each a card named in a tool description's example, not in a
// rule. The check is deliberately a floor, not a proof: a rule that names no card (a mana-value test that happens to match
// one commander) is outside it, and ISC-82's measurement on commanders other than the probes is the other half.
const SERVER = new URL("./", import.meta.url).pathname;
const productFiles = (readdirSync(SERVER, { recursive: true }) as string[])
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !/fixture/i.test(f))
  .sort();
/** A card named inside a longer sentence of a tool description, as an example for the reader: not a rule. */
const DOC_EXAMPLES: { file: string; name: string }[] = [
  { file: "deck-tools.ts", name: "Fire // Ice" }, // the manaSymbols description: "Reads the front face's cost, so Fire // Ice is {1}{R}"
];

describe("ISC-83: product code names no commander or card as a rule", () => {
  test("ISC-83: the string-literal reader sees strings, templates and regex sources, and skips comments and division", () => {
    const src = [
      'const a = "one"; // "comment string"',
      "const b = 'two' /* \"block\" */ + 'th\\'ree';",
      "const c = `pre ${f(\"inner\")} mid ${`nested ${g('deep')}`} end`;",
      "const d = x / 2 / y; const e = /re\"gex[/]x/.test(s);",
      "const f = [1, 2].map((n) => n / 2); const g = a ? /yes/ : 'no';",
    ].join("\n");
    expect(stringLiterals(src)).toEqual(["one", "two", "th'ree", "pre ", "inner", " mid ", "nested ", "deep", "", " end", 're"gex[/]x', "yes", "no"]);
  });

  test("ISC-83: the matcher takes whole one-word names and multi-word names at word edges, in the card's capitals only", () => {
    const n = ["Sol Ring", "Teysa Karlov", "Fire // Ice", "Doubling Season", "Harvest"];
    const hit = (...lits: string[]) => cardNamesInLiterals(lits, n).map((h) => h.name);
    expect(hit("Sol Ring")).toEqual(["Sol Ring"]);
    expect(hit("if Teysa Karlov is the commander")).toEqual(["Teysa Karlov"]);
    expect(hit("Harvest")).toEqual(["Harvest"]);
    expect(hit(" Doubling Season ")).toEqual(["Doubling Season"]);
    expect(hit("a Sol Ringer", "Sol Rings", "sol ring", "Teysa  Karlov", "the Harvest moon", "Teysa", "harvest")).toEqual([]);
  });

  test("ISC-83: no non-test, non-fixture server/**/*.ts string literal names a commander or card", () => {
    expect(productFiles.length).toBeGreaterThanOrEqual(25);
    expect(productFiles).toContain("plan.ts");
    expect(productFiles).toContain("graph/strategy.ts");
    expect(productFiles.some((f) => f.endsWith(".test.ts"))).toBe(false);
    const hits = productFiles.flatMap((f) => cardNamesInLiterals(stringLiterals(readFileSync(SERVER + f, "utf8")), names)
      .filter((h) => !DOC_EXAMPLES.some((d) => d.file === f && d.name === h.name))
      .map((h) => `${f}: "${h.name}" in "${h.literal.slice(0, 100)}"`));
    expect(hits).toEqual([]);
    // the one documented example is still there and still seen, so the exemption cannot hide a different hit
    const seen = productFiles.flatMap((f) => cardNamesInLiterals(stringLiterals(readFileSync(SERVER + f, "utf8")), names).map((h) => ({ file: f, name: h.name })));
    expect(seen).toEqual(DOC_EXAMPLES);
  });

  test("ISC-83 goes red on a rule that names a card, in every product file and every way of writing one", () => {
    const rules = [
      'const RULE = "Teysa Karlov";',
      'if (card.name === "Sol Ring") skip();',
      'const EXEMPT = new Set(["Doubling Season", "Rhystic Study"]);',
      "const msg = `${n} Sol Ring is a staple`;",
      "const re = /Namor the Sub-Mariner/;",
      "const table = { 'Sol Ring': 1 };",
    ];
    for (const f of productFiles) {
      const src = readFileSync(SERVER + f, "utf8");
      for (const rule of rules) {
        // at the end of the file and at the start: the reader must be back in code state after the whole file
        for (const mutant of [src + "\n" + rule + "\n", rule + "\n" + src]) {
          const hits = cardNamesInLiterals(stringLiterals(mutant), names).filter((h) => !DOC_EXAMPLES.some((d) => d.file === f && d.name === h.name));
          expect({ f, rule, caught: hits.length > 0 }).toEqual({ f, rule, caught: true });
        }
      }
    }
  }, 60_000);
});
