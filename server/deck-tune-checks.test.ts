// MV-17: the code stage of the deck-tune eval on the two recorded sessions in docs/research/deck-tune/, plus one
// broken copy per check that must go red, so a check that passes everything cannot hide here.

import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  cardNamesInLiterals, stringLiterals,
  checkLeversBeforeSwaps, checkNoSwapsWithoutPick, checkSearchesNotDeferred, checkNumbersBeforeSwaps, checkProposalsFromTools, checkReadsLabeled,
  checkNoToolTalk, LEVER_NAMES, leverLists, scannableNames, swapBlocks,
} from "./deck-tune-checks";
import { openStore } from "./deck-tools";
import { parseTranscript, readTranscript, serializeTranscript, TranscriptError, type Transcript, type TranscriptEvent } from "./deck-tune-transcript";

const DIR = new URL("../docs/research/deck-tune/", import.meta.url).pathname;
const namor = readTranscript(`${DIR}namor-mana-efficient.jsonl`);
const noPick = readTranscript(`${DIR}namor-no-pick.jsonl`);
let names: string[] = [];
beforeAll(() => { names = scannableNames(openStore().names.map((n) => n.name)); });

const clone = (t: Transcript): Transcript => structuredClone(t);
/** A copy with every assistant turn's text passed through `edit`. */
function editAssistant(t: Transcript, edit: (text: string, i: number) => string): Transcript {
  const c = clone(t);
  c.events = c.events.map((e, i) => (e.kind === "assistant" ? { ...e, text: edit(e.text, i) } : e));
  return c;
}
const lastAssistant = (t: Transcript) => t.events.findLastIndex((e) => e.kind === "assistant");

describe("recorded sessions", () => {
  test("both are labeled agent-played and parse back to the same JSONL", () => {
    for (const t of [namor, noPick]) {
      expect(t.header.agentPlayed).toBe(true);
      expect(parseTranscript(serializeTranscript(t))).toEqual(t);
    }
  });

  test("the Namor session has 15 swap blocks from three cheaper calls; the no-pick session has none", () => {
    expect(swapBlocks(namor).length).toBe(15);
    expect(namor.events.filter((e) => e.kind === "tool" && e.name === "swap_candidates").length).toBe(3);
    expect(swapBlocks(noPick).length).toBe(0);
    expect(leverLists(namor)[0].items.map((x) => x.lever)).toEqual(["cheaper", "roles", "cheaper", "cheaper"]);
  });

  test("a malformed line is a TranscriptError, not a pass", () => {
    expect(() => parseTranscript('{"kind":"header"}')).toThrow(TranscriptError);
    expect(() => parseTranscript(`${serializeTranscript(namor)}{"kind":"tool","name":"x"}\n`)).toThrow(TranscriptError);
  });
});

describe("ISC-13: no lever produces swaps until the player picks it", () => {
  test("ISC-13 no-pick session: 0 swaps listed, 0 swap_candidates calls", () => {
    const r = checkNoSwapsWithoutPick(noPick);
    expect(r).toEqual({ pass: true, details: ["0 swap_candidates call(s), each after a pick; 0 swap block(s), none before a call"] });
  });

  test("ISC-13 Namor session: every swap_candidates call follows the player's pick of that lever", () => {
    expect(checkNoSwapsWithoutPick(namor).pass).toBe(true);
  });

  test("ISC-13 goes red when swaps run without a pick", () => {
    const unpicked = clone(namor);
    const pick = unpicked.events.findIndex((e, i) => e.kind === "user" && i > 0);
    unpicked.events[pick] = { kind: "user", text: "Hmm, let me think about it." };
    const r = checkNoSwapsWithoutPick(unpicked);
    expect(r.pass).toBe(false);
    expect(r.details.length).toBe(3);

    const wrongLever = clone(namor);
    wrongLever.events[pick] = { kind: "user", text: "More ramp, please." };
    expect(checkNoSwapsWithoutPick(wrongLever).pass).toBe(false);

    const listedEarly = editAssistant(noPick, (text, i) => (i === lastAssistant(noPick) ? `${text}\n\n### Swap 1: Hullbreaker Horror → Cryptic Command\n- **Claude's read** (my own Magic knowledge, not the data): strong.` : text));
    expect(checkNoSwapsWithoutPick(listedEarly).pass).toBe(false);
  });
});

describe("ISC-28: a turn never offers a card search it could run", () => {
  test("ISC-28 both recorded sessions pass", () => {
    for (const s of [namor, noPick]) expect(checkSearchesNotDeferred(s).pass).toBe(true);
  });

  test("ISC-28 goes red on the offer a real session caught (2026-11-06), and green once the turn ran find_cards", () => {
    const offer = "A find_cards search (Merfolk or blue cards tagged anthem or evasion) would surface them, and I can run it whenever you want.";
    const offered = editAssistant(noPick, (text, i) => (i === lastAssistant(noPick) ? `${text}\n\n${offer}` : text));
    const r = checkSearchesNotDeferred(offered);
    expect(r.pass).toBe(false);
    expect(r.details[0]).toContain("I can run it whenever you want");
    expect(checkSearchesNotDeferred(editAssistant(noPick, (text, i) => (i === lastAssistant(noPick) ? `${text}\n\nWant me to search for anthems?` : text))).pass).toBe(false);

    const ran = clone(offered);
    ran.events.splice(lastAssistant(ran), 0, { kind: "tool", server: "mtg-deck", name: "find_cards", input: { tags: ["anthem"], colorIdentity: "U" }, result: { total: 70, offset: 0, cards: [] }, isError: false } as TranscriptEvent);
    expect(checkSearchesNotDeferred(ran).pass).toBe(true);
  });
});

describe("ISC-22.1: the deck's numbers come before any swap", () => {
  test("ISC-22.1 Namor session: deck_stats, then the numbers, then the first swap", () => {
    expect(checkNumbersBeforeSwaps(namor)).toEqual({ pass: true, details: ["deck_stats at event 2, numbers reported at event 3, first swap at event 5"] });
    expect(checkNumbersBeforeSwaps(noPick).pass).toBe(true);
  });

  test("ISC-22.1 goes red when the numbers are missing or come late", () => {
    const noStats = clone(namor);
    noStats.events = noStats.events.filter((e) => !(e.kind === "tool" && e.name === "deck_stats"));
    expect(checkNumbersBeforeSwaps(noStats).pass).toBe(false);

    const late = editAssistant(namor, (text) => text.replaceAll(/2\.77(?!\d)/g, "low"));
    expect(checkNumbersBeforeSwaps(late).pass).toBe(false);
  });
});

describe("ISC-22.2: ranked levers come before any swap", () => {
  test("ISC-22.2 Namor session: four levers ranked 1 to 4 before the first swap", () => {
    expect(checkLeversBeforeSwaps(namor).pass).toBe(true);
    expect(checkLeversBeforeSwaps(noPick).pass).toBe(true);
  });

  test("ISC-22.2 goes red with no ranked list, a one-item list, or a lever with no tool lever", () => {
    expect(checkLeversBeforeSwaps(editAssistant(namor, (t) => t.replace("Levers, ranked by expected help", "Some options"))).pass).toBe(false);
    expect(checkLeversBeforeSwaps(editAssistant(namor, (t) => t.replace(/\n2\. [\s\S]*?\n\nThis ranking/, "\n\nThis ranking"))).pass).toBe(false);
    expect(checkLeversBeforeSwaps(editAssistant(namor, (t) => t.replace("(`roles`, filling", "(filling"))).pass).toBe(false);
  });
});

describe("ISC-23.1: every proposed card came from the session's tools", () => {
  test("ISC-23.1 Namor session: every swap pair was returned and every named card is from the session", () => {
    const r = checkProposalsFromTools(namor, names);
    expect(r.details).toEqual([expect.stringMatching(/^15 swap block\(s\), all returned pairs; \d+ card names in Claude's turns, all from the session$/)]);
    expect(r.pass).toBe(true);
    expect(checkProposalsFromTools(noPick, names).pass).toBe(true);
  });

  test("ISC-23.1 goes red on a card from memory, in a swap heading or in prose", () => {
    const heading = editAssistant(namor, (t) => t.replace("### Swap 1: Hullbreaker Horror → Cryptic Command", "### Swap 1: Hullbreaker Horror → Rhystic Study"));
    const h = checkProposalsFromTools(heading, names);
    expect(h.pass).toBe(false);
    expect(h.details.join("\n")).toContain("Rhystic Study");

    const prose = editAssistant(namor, (t, i) => (i === lastAssistant(namor) ? `${t}\n\nYou could also just play Rhystic Study.` : t));
    expect(checkProposalsFromTools(prose, names).details).toEqual(['"Rhystic Study" is named by Claude but appears in no tool result, file read or user turn of the session']);

    // A returned card shown against the wrong outgoing card is a pair no call returned.
    const pair = editAssistant(namor, (t) => t.replace("### Swap 6: Blatant Thievery → Tempted by the Oriq", "### Swap 6: Blatant Thievery → Cryptic Command"));
    expect(checkProposalsFromTools(pair, names).pass).toBe(false);
  });

  test("ISC-23.1 scanner skips short one-word names and keeps each face of a split card", () => {
    expect(scannableNames(["Opt", "Cut // Ribbons", "Brainstorm", "Mana Leak"]).sort()).toEqual(["Brainstorm", "Cut // Ribbons", "Mana Leak", "Ribbons"]);
  });
});

describe("ISC-23.2 (code half): every swap block carries the Claude's read label", () => {
  test("ISC-23.2 Namor session: 15 of 15 blocks labeled", () => {
    expect(checkReadsLabeled(namor)).toEqual({ pass: true, details: ["15 swap block(s), each with a **Claude's read** line"] });
  });

  test("ISC-23.2 goes red on an unlabeled block, even with a labeled summary after it", () => {
    const stripped = editAssistant(namor, (t) => t.replace(
      "- **Claude's read** (my own Magic knowledge, not the data): weak. It saves one mana and bounces your Merfolk with everything else. Skip.",
      "- Weak. It saves one mana and bounces your Merfolk with everything else. Skip."));
    expect(checkReadsLabeled(stripped)).toEqual({ pass: false, details: ["Swap 15 (event 8) has no **Claude's read** line"] });
  });
});

test("events keep their order: tool calls sit between the turns that asked for them", () => {
  const kinds = namor.events.map((e: TranscriptEvent) => (e.kind === "tool" ? e.name : e.kind));
  expect(kinds).toEqual(["user", "read", "deck_stats", "assistant", "user", "swap_candidates", "swap_candidates", "swap_candidates", "assistant"]);
});

describe("real player session (ISC-25.2): Namor, more damage", () => {
  const real = readTranscript(`${DIR}namor-more-damage.jsonl`);

  test("is labeled a real session, called the deck MCP, and parses back to the same JSONL", () => {
    expect(real.header.agentPlayed).toBe(false);
    expect(parseTranscript(serializeTranscript(real))).toEqual(real);
    const calls = real.events.filter((e) => e.kind === "tool" && !e.isError);
    expect(calls.map((e) => e.kind === "tool" && e.name)).toContain("find_cards");
    expect(swapBlocks(real).length).toBe(0);
  });

  test("passes every code check: ISC-13, 22.1, 22.2, 23.1, 23.2 (code half) and 28", () => {
    const results = {
      "ISC-13": checkNoSwapsWithoutPick(real), "ISC-22.1": checkNumbersBeforeSwaps(real), "ISC-22.2": checkLeversBeforeSwaps(real),
      "ISC-23.1": checkProposalsFromTools(real, names), "ISC-23.2": checkReadsLabeled(real), "ISC-28": checkSearchesNotDeferred(real),
    };
    for (const [id, r] of Object.entries(results)) expect({ id, ...r }).toMatchObject({ id, pass: true });
  });
});

describe("blank lines between list items (the house list format) do not end a block", () => {
  test("a levers list and a swap block with spaced items parse whole", () => {
    const spaced = editAssistant(noPick, (text, i) => (i === lastAssistant(noPick)
      ? `**Levers, ranked by expected help:**\n\n1. **Trim** (\`cheaper\` on Hullbreaker Horror): a.\n\n2. **Roles** (\`roles\` on the whole deck): b.\n\n### Swap 1: Hullbreaker Horror → Opt\n\n- **Reason (data):** r\n\n- **Deck after:** d\n\n- **Claude's read** (my own Magic knowledge, not the data): fine.`
      : text));
    expect(leverLists(spaced).at(-1)!.items.map((x) => x.lever)).toEqual(["cheaper", "roles"]);
    const [block] = swapBlocks(spaced);
    expect(block.text).toContain("**Claude's read**");
  });
});

describe("ISC-29: no reply carries tool or code vocabulary", () => {
  const real = readTranscript(`${DIR}namor-more-damage.jsonl`);

  test("ISC-29 goes red on the lines flagged in a real session (2026-11-06)", () => {
    const r = checkNoToolTalk(real);
    expect(r.pass).toBe(false);
    const all = r.details.join("\n");
    for (const flagged of ["find_cards", "`redundancy`", "`plan`", "`roles`", "app/role-targets.json", "64 matches"]) expect(all).toContain(flagged);
  });

  test("ISC-29 is green on the same answer said in player's words, and the levers still parse", () => {
    const plain = [
      "**Search past the levers: blue cards that pump or evade**",
      "",
      "- **Levitation** (4 mana): **Claude's read**: my top pick.",
      "",
      "**Levers, ranked by expected help:**",
      "",
      "1. **Trim what's doubled up** (the whole deck, most likely the 11 counterspells): frees slots for the cards above.",
      "",
      "2. **Stronger fits for the commander** (the mana rocks, starting with Thought Vessel): blue-pip cards at the same cost.",
      "",
      "3. **Fill thin roles** (the whole deck): less on point, there's no damage role.",
      "",
      "The first and third measure against role counts I'm suggesting, not ones you've set. Which lever do you want?",
    ].join("\n");
    const t = editAssistant(real, () => plain);
    expect(checkNoToolTalk(t)).toEqual({ pass: true, details: ["no tool or code vocabulary in any reply"] });
    expect(leverLists(t)[0].items.map((x) => x.lever)).toEqual(["redundancy", "plan", "roles"]);
    expect(checkLeversBeforeSwaps(t).pass).toBe(true);
  });

  test("ISC-29 flags the diagnose and shortlist tools by name and their arguments, but not the words diagnose or shortlist in a player's sentence", () => {
    const said = (line: string) => checkNoToolTalk(editAssistant(real, () => line));
    for (const line of ["I ran `shortlist` for removal.", "Calling `diagnose` now.", "With engineGap set to dying:", "Under maxManaValue 3,", "offPlan cards first", "maxPrice 5 keeps it cheap", "its planPartners count is 4"]) {
      expect([line, said(line).pass]).toEqual([line, false]);
    }
    for (const line of ["Here's a shortlist of removal that fits.", "Let me diagnose the deck against that plan first.", "Three cards on the shortlist feed your death triggers."]) {
      expect([line, said(line).pass]).toEqual([line, true]);
    }
  });

  test("SKILL.md's lever table names each lever exactly as the checks do", async () => {
    const skill = await Bun.file(new URL("../plugin/skills/deck-tune/SKILL.md", import.meta.url).pathname).text();
    for (const [lever, name] of Object.entries(LEVER_NAMES)) expect(skill).toContain(`| \`${lever}\` | ${name} |`);
  });
});

// DT-6.12, ISC-83 (the code probe for the no-overfitting constraint, Sage 2026-11-07): product code under server/ names no
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
