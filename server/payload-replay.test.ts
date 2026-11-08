// DT-6.16, ISC-102: the payload replay's pure parts — reading a Claude Code transcript, finding the card facts its
// replies used, and checking a replay still carries them. The transcripts here are synthetic: a real session's
// transcript holds the player's decklist and is never committed.

import { expect, test } from "bun:test";
import { factsUsed, missingFacts, readTranscript, resultSize, type Fact } from "../scripts/payload-replay";

const P = "mcp__plugin_mtg-deck-tune_mtg-deck__";
const line = (o: object) => JSON.stringify(o);
const use = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
const result = (id: string, text: string) => ({ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] });

const transcript = [
  line({ type: "user", message: { role: "user", content: "tune my deck" } }),
  line({ type: "assistant", message: { content: [use("a", `${P}deck_stats`, { commander: "Niv-Mizzet, Parun", deckFile: "/x/deck.txt" }), use("b", "Bash", { command: "ls" })] } }),
  line({ type: "user", message: { content: [result("a", '{"cards":100}'), result("b", "deck.txt")] } }),
  line({ type: "assistant", message: { content: [{ type: "text", text: "First reply." }, use("c", `${P}card`, { name: "Opt" })] } }),
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c", content: "plain string result" }] } }),
  line({ type: "assistant", message: { content: [{ type: "text", text: "Second reply." }] } }),
  "",
].join("\n");

test("ISC-102 replay: the transcript reader keeps the mtg-deck tool calls in order with their original results, and the assistant's replies", () => {
  const t = readTranscript(transcript);
  expect(t.calls).toEqual([
    { id: "a", tool: "deck_stats", input: { commander: "Niv-Mizzet, Parun", deckFile: "/x/deck.txt" }, original: '{"cards":100}' },
    { id: "c", tool: "card", input: { name: "Opt" }, original: "plain string result" },
  ]);
  expect(t.replies).toEqual(["First reply.", "Second reply."]);
});

test("ISC-102 replay: a result's size is counted as the text the model reads and as that text escaped in the transcript", () => {
  expect(resultSize('{"a":"b"}')).toEqual({ chars: 9, escaped: JSON.stringify('{"a":"b"}').length });
});

const CARDS = ["Opt", "Brainstorm", "Counterspell", "Lightning Bolt", "Delver of Secrets // Insectile Aberration", "Mystic Remora"];
const ROLES = ["card draw", "counterspell", "removal"];
const originals = [
  { cards: [{ name: "Opt", manaValue: 1, usd: 0.25 }, { name: "Brainstorm", manaValue: 1, usd: 1.4 }] },
  { name: "Delver of Secrets // Insectile Aberration", manaValue: 1, oracleText: "At the beginning of your upkeep, look at the top card of your library." },
  { roles: [{ role: "card draw", count: 7, target: 10 }], averageManaValue: 3.094, links: [{ name: "Counterspell", links: 12 }] },
  { candidates: [{ out: { name: "Counterspell", manaValue: 2 }, in: { name: "Lightning Bolt", manaValue: 1 }, reason: "plan: works on spells cast; shares Tagger tags: instant" }] },
];
const replies = [
  "**Opt (1)** costs about $0.25. Mystic Remora is great but the tools never returned it.",
  "| Card draw | 7 against 10 |\n| Average mana value | 3.09 |",
  "Counterspell has 12 connections.",
  "### Swap: Counterspell → Lightning Bolt\n- Reason (data): works on spells cast. Mana value 2 → 1.",
  "Wandering in: Delver of Secrets wants you to look at the top card of your library each upkeep.",
];
const has = (facts: Fact[], f: Fact) => facts.some((x) => JSON.stringify(x) === JSON.stringify(f));

test("ISC-102 replay: the facts used are the card names the replies quote that a tool returned, a front-face name standing for its card", () => {
  const facts = factsUsed(replies, originals, { cards: CARDS, roles: ROLES });
  for (const card of ["Opt", "Counterspell", "Lightning Bolt", "Delver of Secrets // Insectile Aberration"]) expect(has(facts, { kind: "name", card })).toBe(true);
  expect(facts.some((f) => f.kind === "name" && f.card === "Mystic Remora")).toBe(false); // quoted, but no tool returned it
  expect(facts.some((f) => f.kind === "name" && f.card === "Brainstorm")).toBe(false); // returned, but never quoted
});

test("ISC-102 replay: a mana value or price beside a quoted card, or under the heading that names it, is a fact used", () => {
  const facts = factsUsed(replies, originals, { cards: CARDS, roles: ROLES });
  expect(has(facts, { kind: "manaValue", card: "Opt", value: 1 })).toBe(true);
  expect(has(facts, { kind: "price", card: "Opt", value: 0.25 })).toBe(true);
  expect(has(facts, { kind: "manaValue", card: "Counterspell", value: 2 })).toBe(true); // "Mana value 2 → 1" under the swap heading
  expect(has(facts, { kind: "manaValue", card: "Lightning Bolt", value: 1 })).toBe(true);
});

test("ISC-102 replay: a count beside a role, a deck number or a card is a fact used, matched at the reply's rounding", () => {
  const facts = factsUsed(replies, originals, { cards: CARDS, roles: ROLES });
  expect(has(facts, { kind: "count", entity: "card draw", value: 7 })).toBe(true);
  expect(has(facts, { kind: "count", entity: "card draw", value: 10 })).toBe(true);
  expect(has(facts, { kind: "count", entity: "average mana value", value: 3.09 })).toBe(true);
  expect(has(facts, { kind: "count", entity: "Counterspell", value: 12 })).toBe(true);
});

test("ISC-102 replay: words a reply takes from a card's rules text or a swap's reason are a fact used, tied to that card", () => {
  const facts = factsUsed(replies, originals, { cards: CARDS, roles: ROLES });
  expect(facts.some((f) => f.kind === "phrase" && f.card === "Delver of Secrets // Insectile Aberration" && f.text === "look at the top card of your library")).toBe(true);
  expect(facts.some((f) => f.kind === "phrase" && f.card === "Lightning Bolt" && f.text === "works on spells cast")).toBe(true);
});

test("ISC-102 replay: a replay that keeps every fact misses none; one that drops a card's mana value, a count, a phrase or a name misses exactly those", () => {
  const facts = factsUsed(replies, originals, { cards: CARDS, roles: ROLES });
  expect(missingFacts(facts, originals)).toEqual([]);
  // the same facts in a different shape still count: a compact list keyed by name, counts in a role map
  const reshaped = [
    { cards: [{ name: "Opt", mv: 1, usd: 0.25 }] },
    { name: "Delver of Secrets // Insectile Aberration", mv: 1, text: "At the beginning of your upkeep, look at the top card of your library." },
    { roleCounts: { "card draw": 7 }, targets: { "card draw": 10 }, averageManaValue: 3.094, links: { Counterspell: 12 } },
    { swaps: [{ out: { name: "Counterspell", mv: 2 }, in: { name: "Lightning Bolt", mv: 1 }, reason: "works on spells cast" }] },
  ];
  expect(missingFacts(facts, reshaped)).toEqual([]);
  const dropped = [
    { cards: [{ name: "Opt", usd: 0.25 }] },
    { name: "Delver of Secrets // Insectile Aberration", manaValue: 1 },
    { roles: [{ role: "card draw", count: 7, target: 10 }], averageManaValue: 3.094 },
    { candidates: [{ out: { name: "Counterspell", manaValue: 2 }, in: { name: "Lightning Bolt", manaValue: 1 }, reason: "works on spells cast" }] },
  ];
  expect(missingFacts(facts, dropped)).toEqual([
    { kind: "manaValue", card: "Opt", value: 1 },
    { kind: "count", entity: "Counterspell", value: 12 },
    { kind: "phrase", card: "Delver of Secrets // Insectile Aberration", text: "look at the top card of your library" },
  ].filter((f) => has(facts, f)));
  expect(missingFacts(facts, dropped).length).toBe(3);
  expect(missingFacts(facts, [{ cards: [] }]).some((f) => f.kind === "name" && f.card === "Opt")).toBe(true);
});

test("ISC-102 replay: a table of rows under named columns holds the same facts as a list of objects", () => {
  const facts = factsUsed(replies, originals, { cards: CARDS, roles: ROLES });
  const tabled = [
    { columns: ["name", "manaValue", "usd"], cards: [["Opt", 1, 0.25], ["Brainstorm", 1, 1.4]] },
    { cardFacts: { columns: ["name", "manaValue", "oracleText"], rows: [["Delver of Secrets // Insectile Aberration", 1, "At the beginning of your upkeep, look at the top card of your library."]] } },
    { roleCounts: { "card draw": 7 }, targets: { "card draw": 10 }, averageManaValue: 3.094, links: { Counterspell: 12 } },
    { swaps: [{ out: { name: "Counterspell", mv: 2 }, in: { name: "Lightning Bolt", mv: 1 }, reason: "works on spells cast" }] },
  ];
  expect(missingFacts(facts, tabled)).toEqual([]);
});

test("ISC-102 replay: a number that labels rather than counts (4+, 6-drops, power-4) is not a fact, and a number map's keys name no deck number", () => {
  const facts = factsUsed(
    ["Opt wants creatures with power-4 or 4+ mana, unlike your 6-drops.", "| Pips (U / R) | 9 / 2 |"],
    [{ name: "Opt", manaValue: 1, partners: 4, links: 6 }, { pipLoad: { U: 9, R: 2 } }],
    { cards: CARDS, roles: ROLES },
  );
  expect(facts.filter((f) => f.kind === "count")).toEqual([]);
});

test("ISC-102 replay: the reply line each fact came from can be read back, to check a fact by hand", () => {
  const sources = new Map<string, string>();
  const facts = factsUsed(replies, originals, { cards: CARDS, roles: ROLES }, sources);
  expect(sources.get(JSON.stringify({ kind: "count", entity: "Counterspell", value: 12 }))).toBe("Counterspell has 12 connections.");
  expect(facts.every((f) => sources.has(JSON.stringify(f)))).toBe(true);
});

test("ISC-102 replay: a deck number inside a map of numbers is still that deck number", () => {
  const facts = factsUsed(["| Average mana value | 3.09 |"], [{ averageManaValue: 3.094 }], { cards: CARDS, roles: ROLES });
  expect(facts).toEqual([{ kind: "count", entity: "average mana value", value: 3.09 }]);
  expect(missingFacts(facts, [{ after: { averageManaValue: 3.094, onPlan: 25 } }])).toEqual([]);
});
