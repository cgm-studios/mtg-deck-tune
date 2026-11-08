// DT-6.18: reading and saving a player's deck file. Sections that are not the deck count for nothing (ISC-113), an add
// lands in the main deck (ISC-114), the commander changes only when the call says so (ISC-115), and a save is safe: a
// failed record leaves the file alone (ISC-116), a symlink stays a symlink and the mode stays (ISC-117), and a file
// that is not a deck list is refused (ISC-118).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptReceipt } from "./compact";
import { parseDecklist } from "./deck-pool";
import { deckStats, openStore, type Store } from "./deck-tools";
import { diagnose } from "./diagnose";
import { parseDeckList } from "./graph/deck";
import { createDeckServer } from "./mcp";
import { shortlist } from "./shortlist";
import { acceptSwap } from "./swap-tools";

const FIXTURE = new URL("../fixtures/namor.txt", import.meta.url).pathname;
const NAMOR = "Namor the Sub-Mariner";
const namorList = readFileSync(FIXTURE, "utf8").trimEnd();

let store: Store;
let dir: string;
let labelsPath: string;
let count = 0;
beforeAll(() => {
  store = openStore();
  dir = mkdtempSync(join(tmpdir(), "dt618-"));
  labelsPath = join(dir, "labels.jsonl");
});
afterAll(() => {
  store?.db.close();
  rmSync(dir, { recursive: true, force: true });
});
const deckFileWith = (text: string, name = `deck-${++count}.txt`) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

// ---------- ISC-113 ----------
// An off-color card and a misspelling: if either counted, the numbers would show it.
const EXTRAS = ["Lightning Bolt", "Not A Real Card Name"];
const SHAPES: [string, (cards: string[]) => string][] = [
  ["bare header (Arena, MTGO)", (c) => `\nSideboard\n${c.map((n) => `1 ${n}`).join("\n")}`],
  ["header with a colon and capitals (Moxfield)", (c) => `\n\nSIDEBOARD:\n${c.map((n) => `1 ${n}`).join("\n")}`],
  ["header with a count (TopDecked)", (c) => `\nConsidering (${c.length})\n${c.map((n) => `1x ${n}`).join("\n")}`],
  ["maybeboard with set codes", (c) => `\nMaybeboard (${c.length})\n${c.map((n) => `1 ${n} (M11) 149`).join("\n")}`],
  ["comment header", (c) => `\n// Maybeboard\n${c.map((n) => `1 ${n}`).join("\n")}`],
  ["a tag on each line (Archidekt)", (c) => `\n${c.map((n) => `1x ${n} (m11) 149 [Maybeboard{noDeck}{noPrice}]`).join("\n")}`],
];

test("ISC-113: sideboard, maybeboard and considering sections count toward no deck number, in every common export shape", () => {
  const plain = deckStats(store, { commander: NAMOR, decklist: namorList });
  expect(plain).toMatchObject({ cards: 100, unresolved: [], offIdentity: [] });
  for (const [shape, section] of SHAPES) {
    expect([shape, deckStats(store, { commander: NAMOR, decklist: namorList + section(EXTRAS) })]).toEqual([shape, plain]);
  }
});

test("ISC-113: the diagnosis reads the same deck with those sections present", () => {
  const plan = { themes: ["Spellslinger"] };
  const plain = diagnose(store, { commander: NAMOR, decklist: namorList, plan });
  expect(diagnose(store, { commander: NAMOR, decklist: `${namorList}\n\nMaybeboard (2)\n1 Lightning Bolt\n1 Not A Real Card Name`, plan })).toEqual(plain);
}, 60_000);

test("ISC-113: a card in a sideboard is not in the deck, so the shortlist still offers it", () => {
  const args = { commander: NAMOR, plan: { themes: ["Spellslinger"] }, problem: { role: "removal" } };
  const plain = shortlist(store, { ...args, decklist: namorList });
  const offered = plain.cards[0].name;
  const listed = shortlist(store, { ...args, decklist: `${namorList}\n\nConsidering (1)\n1 ${offered}` });
  expect(listed.cards.map((c) => c.name)).toEqual(plain.cards.map((c) => c.name));
  expect(listed.before).toEqual(plain.before);
}, 60_000);

test("ISC-113: a later header puts the list back in the deck, section lines are skipped not lost, and one parser serves both readers", () => {
  const text = "Sideboard\n1 Lightning Bolt\nCommander (1)\n1 Opt\nMain (1)\n1 Consider";
  const deck = parseDecklist(store.space, text);
  expect(deck.entries.map((e) => e.text)).toEqual(["Opt", "Consider"]);
  expect(deck.skipped.map((s) => s.text)).toContain("1 Lightning Bolt");
  // the graph's reader sees the same sections, the same comment headers and the same line tags
  expect(parseDeckList(text).map((e) => e.name)).toEqual(["Opt", "Consider"]);
  expect(parseDeckList("1 Opt\n// Sideboard\n1 Lightning Bolt").map((e) => e.name)).toEqual(["Opt"]);
  expect(parseDeckList("1x Opt (m11) 1 [Draw]\n1x Lightning Bolt (m11) 149 [Maybeboard{noDeck}{noPrice}]").map((e) => e.name)).toEqual(["Opt"]);
  // the shapes each reader accepted before stay accepted: an uncounted name and a title line for the graph, a # tag for the tools
  expect(parseDeckList("my deck: my deck\nOpt\n2x Island").map((e) => [e.name, e.count])).toEqual([["Opt", 1], ["Island", 2]]);
  expect(parseDecklist(store.space, "1 Opt #draw\nOpt").entries.map((e) => [e.text, e.qty])).toEqual([["Opt", 1]]);
});

// ---------- ISC-114 ----------

test("ISC-114: an add goes in the main deck, not after a maybeboard, a commander section or a URL line", () => {
  const add = (text: string) => {
    const deckFile = deckFileWith(text);
    acceptSwap(store, { commander: NAMOR, deckFile, in: "Opt" }, { labelsPath });
    return readFileSync(deckFile, "utf8").split("\n");
  };
  expect(add("1 Consider\n1 Remand\n\nMaybeboard (1)\n1 Ponder\n").slice(0, 3)).toEqual(["1 Consider", "1 Remand", "1 Opt"]);
  expect(add("1 Consider\n1 Remand\nhttps://example.test/deck/1\n").slice(0, 4)).toEqual(["1 Consider", "1 Remand", "1 Opt", "https://example.test/deck/1"]);
  expect(add(`1 Consider\n1 Remand\n\nCommander\n1 ${NAMOR}\n`).slice(0, 3)).toEqual(["1 Consider", "1 Remand", "1 Opt"]);
  expect(parseDecklist(store.space, add("1 Consider\n\nSideboard\n1 Ponder\n").join("\n")).entries.map((e) => e.text)).toEqual(["Consider", "Opt"]);
});

// ---------- ISC-115 ----------
const SMALL = `1 ${NAMOR}\n1 Sol Ring\n1 Counterspell\n1 Opt\n`;

test("ISC-115: without the flag the commander cannot leave the deck, swapped or cut, and the file is untouched", () => {
  const deckFile = deckFileWith(SMALL);
  expect(() => acceptSwap(store, { commander: NAMOR, deckFile, out: NAMOR, in: "Talrand, Sky Summoner" }, { labelsPath })).toThrow(/is the commander.*changeCommander/);
  expect(() => acceptSwap(store, { commander: NAMOR, deckFile, out: NAMOR }, { labelsPath })).toThrow(/is the commander/);
  expect(() => acceptSwap(store, { commander: NAMOR, deckFile, out: NAMOR, changeCommander: true }, { labelsPath })).toThrow(/needs the new commander/);
  expect(readFileSync(deckFile, "utf8")).toBe(SMALL);
});

test("ISC-115: the flag is only for the commander's own line, and the incoming card must be able to lead a deck", () => {
  const deckFile = deckFileWith(SMALL);
  expect(() => acceptSwap(store, { commander: NAMOR, deckFile, out: "Opt", in: "Consider", changeCommander: true }, { labelsPath })).toThrow(/out must be the commander/);
  expect(() => acceptSwap(store, { commander: NAMOR, deckFile, in: "Talrand, Sky Summoner", changeCommander: true }, { labelsPath })).toThrow(/out must be the commander/);
  for (const notOne of ["Grizzly Bears", "Sol Ring", "Consider", "Karn Liberated"]) {
    expect(() => acceptSwap(store, { commander: NAMOR, deckFile, out: NAMOR, in: notOne, changeCommander: true }, { labelsPath })).toThrow(/cannot be a commander/);
  }
  expect(readFileSync(deckFile, "utf8")).toBe(SMALL);
});

test("ISC-115: with the flag the new commander takes the line, its colors judge the deck, and the receipt names every card now off-color", () => {
  const deckFile = deckFileWith(SMALL);
  // a red commander for a blue deck: the incoming card is judged by its own colors, not the old commander's
  const res = acceptSwap(store, { commander: NAMOR, deckFile, out: NAMOR, in: "Krenko, Mob Boss", changeCommander: true }, { labelsPath, today: "2026-11-08" });
  const lines = readFileSync(deckFile, "utf8").split("\n");
  expect(lines[0]).toBe("1 Krenko, Mob Boss");
  expect(lines).toContain("# 2026-11-08 changed commander: -1 Namor the Sub-Mariner, +1 Krenko, Mob Boss");
  expect(lines).toContain("1 Counterspell"); // never removed
  const stats = deckStats(store, { commander: "Krenko, Mob Boss", deckFile });
  expect(stats.offIdentity.sort()).toEqual(["Counterspell", "Opt"]);
  const receipt = acceptReceipt(res);
  expect(receipt.offColor).toEqual({ count: 2, names: stats.offIdentity });
  expect(res.label).toMatchObject({ commander: NAMOR, out: NAMOR, in: "Krenko, Mob Boss", changedCommander: true });
  // a card that says it can be your commander counts; a same-colored commander leaves nothing off-color
  const other = deckFileWith(`1 ${NAMOR}\n1 Opt\n`);
  expect(acceptReceipt(acceptSwap(store, { commander: NAMOR, deckFile: other, out: NAMOR, in: "Teferi, Temporal Archmage", changeCommander: true }, { labelsPath })).offColor).toEqual({ count: 0, names: [] });
});

test("ISC-115: a long off-color list stays inside the receipt budget as a count and the first names, the rest from deck_stats", () => {
  const deckFile = deckFileWith(`${namorList}\n`);
  const receipt = acceptReceipt(acceptSwap(store, { commander: NAMOR, deckFile, out: NAMOR, in: "Krenko, Mob Boss", changeCommander: true }, { labelsPath }));
  expect(JSON.stringify(receipt).length).toBeLessThanOrEqual(300);
  const all = deckStats(store, { commander: "Krenko, Mob Boss", deckFile }).offIdentity;
  expect(receipt.offColor!.count).toBe(all.length);
  expect(all.length).toBeGreaterThan(receipt.offColor!.names.length);
  expect(receipt.offColor!.names.length).toBeGreaterThan(0);
  expect(all.slice(0, receipt.offColor!.names.length)).toEqual(receipt.offColor!.names);
});

test("ISC-115 over MCP: the tool takes the flag, says what it does, and returns the receipt; an ordinary swap's receipt has no off-color field", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createDeckServer(store, { labelsPath }).connect(a);
  const client = new Client({ name: "dt618", version: "0" });
  await client.connect(b);
  try {
    const tool = (await client.listTools()).tools.find((t) => t.name === "accept_swap")!;
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toContain("changeCommander");
    expect(tool.description).toMatch(/changeCommander: true/);
    expect(tool.description).toMatch(/offColor/);
    const deckFile = deckFileWith(SMALL);
    const refused = await client.callTool({ name: "accept_swap", arguments: { commander: NAMOR, deckFile, out: NAMOR, in: "Krenko, Mob Boss" } });
    expect(refused.isError).toBe(true);
    const plain = await client.callTool({ name: "accept_swap", arguments: { commander: NAMOR, deckFile, out: "Opt", in: "Consider" } });
    expect(Object.keys(plain.structuredContent as object)).not.toContain("offColor");
    const changed = await client.callTool({ name: "accept_swap", arguments: { commander: NAMOR, deckFile, out: NAMOR, in: "Krenko, Mob Boss", changeCommander: true } });
    expect((changed.structuredContent as { offColor: { count: number } }).offColor.count).toBe(2);
  } finally {
    await client.close();
  }
});

// ---------- ISC-119 ----------

test("ISC-119: a card already in the deck is promoted: one copy of it, the old commander takes its slot when its colors fit, and the deck keeps its size", () => {
  const deckFile = deckFileWith(`1 ${NAMOR}\n1 Sol Ring\n1 Talrand, Sky Summoner\n1 Opt\n`);
  const before = deckStats(store, { commander: NAMOR, deckFile }).cards;
  const res = acceptSwap(store, { commander: NAMOR, deckFile, out: NAMOR, in: "Talrand, Sky Summoner", changeCommander: true }, { labelsPath, today: "2026-11-08" });
  const lines = readFileSync(deckFile, "utf8").trimEnd().split("\n");
  expect(lines).toEqual(["1 Talrand, Sky Summoner", "1 Sol Ring", `1 ${NAMOR}`, "1 Opt", `# 2026-11-08 commander promoted: Talrand, Sky Summoner; ${NAMOR} stays`]);
  const after = deckStats(store, { commander: "Talrand, Sky Summoner", deckFile });
  expect([after.cards, after.offIdentity, after.commanderInDeck]).toEqual([before, [], true]);
  const receipt = acceptReceipt(res);
  expect(receipt).toMatchObject({ oldCommander: "stays", offColor: { count: 0, names: [] } });
  expect(receipt.cards).toBeUndefined();
  expect(res.label).toMatchObject({ changedCommander: true, promoted: true, out: NAMOR, in: "Talrand, Sky Summoner" });
});

test("ISC-119: an old commander outside the new colors leaves, and the receipt says so and that the deck is a card short; the rest is reported off-color and stays", () => {
  const deckFile = deckFileWith(`1 ${NAMOR}\n1 Krenko, Mob Boss\n1 Counterspell\n1 Opt\n`);
  const receipt = acceptReceipt(acceptSwap(store, { commander: NAMOR, deckFile, out: NAMOR, in: "Krenko, Mob Boss", changeCommander: true }, { labelsPath, today: "2026-11-08" }));
  expect(readFileSync(deckFile, "utf8").trimEnd().split("\n")).toEqual(["1 Krenko, Mob Boss", "1 Counterspell", "1 Opt", `# 2026-11-08 commander promoted: Krenko, Mob Boss; ${NAMOR} left`]);
  expect(receipt).toMatchObject({ oldCommander: "left", cards: [4, 3], offColor: { count: 2, names: ["Counterspell", "Opt"] } });
});

test("ISC-119: the new commander takes the Commander section, every extra copy goes, and it cannot replace itself", () => {
  const sectioned = deckFileWith(`Commander (1)\n1 ${NAMOR}\nMain (2)\n1 Talrand, Sky Summoner\n1 Opt\n`);
  acceptSwap(store, { commander: NAMOR, deckFile: sectioned, out: NAMOR, in: "Talrand, Sky Summoner", changeCommander: true }, { labelsPath });
  expect(readFileSync(sectioned, "utf8").split("\n").slice(0, 5)).toEqual(["Commander (1)", "1 Talrand, Sky Summoner", "Main (2)", `1 ${NAMOR}`, "1 Opt"]);
  const doubled = deckFileWith(`1 ${NAMOR}\n2 Talrand, Sky Summoner\n1 Opt\n1 Talrand, Sky Summoner\n`);
  const receipt = acceptReceipt(acceptSwap(store, { commander: NAMOR, deckFile: doubled, out: NAMOR, in: "Talrand, Sky Summoner", changeCommander: true }, { labelsPath }));
  const named = parseDecklist(store.space, readFileSync(doubled, "utf8")).entries.filter((e) => e.text === "Talrand, Sky Summoner");
  expect(named.map((e) => e.qty)).toEqual([1]);
  expect(receipt.cards).toEqual([5, 3]);
  const self = deckFileWith(SMALL);
  expect(() => acceptSwap(store, { commander: NAMOR, deckFile: self, out: NAMOR, in: NAMOR, changeCommander: true }, { labelsPath })).toThrow(/already the commander/);
  expect(readFileSync(self, "utf8")).toBe(SMALL);
});

test("ISC-119: the receipt holds its 300 characters with the longest commander names, a long file name and a long off-color list; an incoming card from outside the deck has no promotion fields", () => {
  const longOld = "Reidane, God of the Worthy // Valkmira, Protector's Shield", longNew = "Blitzwing, Cruel Tormentor // Blitzwing, Adaptive Assailant";
  const deckFile = deckFileWith(`1 ${longOld}\n1 ${longNew}\n${namorList.split("\n").filter((l) => !l.includes(NAMOR)).join("\n")}\n`, `${"long-name-".repeat(14)}.txt`);
  const receipt = acceptReceipt(acceptSwap(store, { commander: longOld, deckFile, out: longOld, in: longNew, changeCommander: true }, { labelsPath }));
  expect(JSON.stringify(receipt).length).toBeLessThanOrEqual(300);
  expect(receipt.oldCommander).toBe("left");
  expect(receipt.cards![1]).toBe(receipt.cards![0] - 1);
  expect(receipt.offColor!.count).toBeGreaterThan(0);
  const outside = deckFileWith(SMALL);
  const plain = acceptReceipt(acceptSwap(store, { commander: NAMOR, deckFile: outside, out: NAMOR, in: "Talrand, Sky Summoner", changeCommander: true }, { labelsPath }));
  expect(Object.keys(plain)).not.toContain("oldCommander");
  expect(Object.keys(plain)).not.toContain("cards");
});

// ---------- ISC-116 ----------

test("ISC-116: when the label cannot be written the deck file is byte for byte as it was, the call fails saying so, and a retry works", () => {
  const sub = mkdtempSync(join(dir, "fail-"));
  const deckFile = join(sub, "deck.txt");
  copyFileSync(FIXTURE, deckFile);
  const before = readFileSync(deckFile);
  const blocked = join(sub, "labels-are-a-folder");
  mkdirSync(blocked);
  const input = { commander: NAMOR, deckFile, out: "Remand", in: "Archmage's Charm" };
  expect(() => acceptSwap(store, input, { labelsPath: blocked })).toThrow(/could not be recorded.*left as it was/);
  expect(readFileSync(deckFile).equals(before)).toBe(true);
  expect(readdirSync(sub).sort()).toEqual(["deck.txt", "labels-are-a-folder"]); // no temp file left behind
  const good = join(sub, "labels.jsonl");
  expect(acceptSwap(store, input, { labelsPath: good }).changeLog).toContain("+1 Archmage's Charm");
  expect(readFileSync(deckFile, "utf8")).toContain("1 Archmage's Charm");
  expect(readFileSync(good, "utf8").trim().split("\n")).toHaveLength(1);
});

// ---------- ISC-117 ----------

test("ISC-117: a symlinked deck file stays a symlink and its target is edited", () => {
  const home = mkdtempSync(join(dir, "real-")), links = mkdtempSync(join(dir, "link-"));
  const target = join(home, "deck.txt"), link = join(links, "linked.txt");
  copyFileSync(FIXTURE, target);
  symlinkSync(target, link);
  acceptSwap(store, { commander: NAMOR, deckFile: link, out: "Remand", in: "Archmage's Charm" }, { labelsPath });
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(target);
  expect(readFileSync(target, "utf8")).toContain("1 Archmage's Charm");
  expect(readdirSync(links)).toEqual(["linked.txt"]);
  expect(readdirSync(home)).toEqual(["deck.txt"]);
});

test("ISC-117: a save keeps the deck file's permissions, through a symlink too", () => {
  for (const mode of [0o600, 0o644, 0o640]) {
    const deckFile = deckFileWith(`${namorList}\n`);
    chmodSync(deckFile, mode);
    acceptSwap(store, { commander: NAMOR, deckFile, out: "Remand", in: "Archmage's Charm" }, { labelsPath });
    expect(statSync(deckFile).mode & 0o777).toBe(mode);
  }
  const target = deckFileWith(`${namorList}\n`);
  chmodSync(target, 0o600);
  const link = join(dir, `link-${++count}.txt`);
  symlinkSync(target, link);
  acceptSwap(store, { commander: NAMOR, deckFile: link, out: "Remand", in: "Archmage's Charm" }, { labelsPath });
  expect(statSync(target).mode & 0o777).toBe(0o600);
});

// ---------- ISC-118 ----------

test("ISC-118: a file that does not read as a deck list is refused and left untouched, even when a line happens to name a card", () => {
  const NOTES = "Shopping\n3 eggs\n2 apples\nCall the plumber about the sink\nRead more about 1 Sol Ring someday\nDinner on Friday\n1 Island\nAsk about the car\n";
  const RC = 'export PATH="$HOME/bin:$PATH"\nalias ll="ls -la"\n# prompt\nsetopt AUTO_CD\n2 >/dev/null\nsource ~/.profile\n';
  for (const text of [NOTES, RC, "", "just one line of prose\n"]) {
    const deckFile = deckFileWith(text);
    expect(() => acceptSwap(store, { commander: NAMOR, deckFile, in: "Opt" }, { labelsPath })).toThrow(/does not read as a deck list/);
    expect(readFileSync(deckFile, "utf8")).toBe(text);
  }
  const noted = deckFileWith(NOTES);
  expect(() => acceptSwap(store, { commander: NAMOR, deckFile: noted, out: "Island", in: "Opt" }, { labelsPath })).toThrow(/does not read as a deck list/);
});

test("ISC-118: every export shape stays accepted, however much a list carries beyond its cards", () => {
  const SHAPED: [string, string][] = [
    ["title, URL and trailing spaces (TopDecked)", `my deck: my deck\n1 Consider  \n1 Remand  \nhttps://example.test/d/1\n`],
    ["section headers with counts", `Commander (1)\n1 ${NAMOR}\nMain (2)\n1 Consider\n1 Remand\n`],
    ["1x and set codes", `1x Consider (MID) 44\n1x Remand (CMM) 120 *F*\n`],
    ["type groups", `Creatures (1)\n1 ${NAMOR}\nInstants (2)\n1 Consider\n1 Remand\n`],
    ["change-log and a diff block at the end", `1 Consider\n1 Remand\n1 Ponder\n# 2026-11-07 accepted swap: -1 Preordain, +1 Ponder\n====\nCUT (1)   ADD (1)\n- Preordain  + Ponder\n`],
    ["a card the store does not know among known ones", `1 Consider\n1 Remand\n1 Not A Real Card Name\n`],
    ["CRLF line ends", `1 Consider\r\n1 Remand\r\n`],
    ["mostly sideboard", `1 Consider\n\nSideboard\n1 Remand\n1 Ponder\n1 Preordain\n`],
  ];
  for (const [shape, text] of SHAPED) {
    const deckFile = deckFileWith(text);
    expect([shape, acceptSwap(store, { commander: NAMOR, deckFile, in: "Opt" }, { labelsPath }).changeLog]).toEqual([shape, expect.stringContaining("+1 Opt")]);
  }
});
