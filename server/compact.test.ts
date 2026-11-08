// DT-6.16: what a session sees. The tools return their results compact by default (compact.ts), and every detail left
// out stays one flag away (`detail: true`, and `cardFacts` on deck_stats and diagnose). These tests reach the server
// through the MCP client, as a Claude session does, and compare it with the plain functions, which keep the full result.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardDetails, deckStats, findCards, openStore, type Store } from "./deck-tools";
import { diagnose } from "./diagnose";
import { createDeckServer } from "./mcp";
import { shortlist } from "./shortlist";
import { swapCandidates } from "./swap-tools";
import { compactSwapCandidates } from "./compact";
import { renderEvent } from "./deck-tune-transcript";

const NAMOR = { commander: "Namor the Sub-Mariner", deckFile: "fixtures/namor.txt" };
const TEYSA = { commander: "Teysa Karlov", deckFile: "fixtures/teysa.txt" };
const NAMOR_PLAN = { themes: ["Spellslinger"] };

let store: Store;
let client: Client;
let scratch: string;
type Res = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, unknown> };
const call = async (name: string, args: object): Promise<Res> => {
  const r = (await client.callTool({ name, arguments: args })) as Res;
  if (r.isError) throw new Error(`${name}: ${r.content[0]?.text}`);
  return r;
};
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

beforeAll(async () => {
  store = openStore();
  scratch = mkdtempSync(join(tmpdir(), "dt616-"));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createDeckServer(store, { labelsPath: join(scratch, "labels.jsonl") }).connect(a);
  client = new Client({ name: "compact-test", version: "0" });
  await client.connect(b);
});
afterAll(async () => {
  await client?.close();
  store?.db.close();
  rmSync(scratch, { recursive: true, force: true });
});

// ---------- every detail stays reachable (AC #4) ----------

test("detail flag: deck_stats, diagnose, shortlist, swap_candidates, card and find_cards return the function's full result with detail: true", async () => {
  const swapArgs = { ...NAMOR, lever: "plan", limit: 4, plan: NAMOR_PLAN } as const;
  const shortArgs = { ...NAMOR, plan: NAMOR_PLAN, problem: { role: "removal" } };
  const findArgs = { colorIdentity: "U", types: ["Instant"], limit: 10 };
  const pairs: [string, object, unknown][] = [
    ["deck_stats", NAMOR, deckStats(store, NAMOR)],
    ["diagnose", { ...NAMOR, plan: NAMOR_PLAN }, diagnose(store, { ...NAMOR, plan: NAMOR_PLAN })],
    ["shortlist", shortArgs, shortlist(store, shortArgs)],
    ["swap_candidates", swapArgs, swapCandidates(store, swapArgs)],
    ["card", { name: "Talrand" }, cardDetails(store, { name: "Talrand" })],
    ["find_cards", findArgs, findCards(store, findArgs)],
  ];
  for (const [name, args, full] of pairs) {
    const r = await call(name, { ...args, detail: true });
    expect([name, r.structuredContent]).toEqual([name, plain(full)]);
    expect(r.content[0].text).toBe(JSON.stringify(full));
  }
}, 120_000);

test("detail flag: every tool that trims its result says in its description how to get the rest", async () => {
  const { tools } = await client.listTools();
  const desc = Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));
  for (const name of ["deck_stats", "diagnose", "shortlist", "swap_candidates", "card", "find_cards"]) expect([name, desc[name]]).toEqual([name, expect.stringMatching(/detail: true/)]);
  expect(desc.deck_stats).toMatch(/cardFacts: true/);
  expect(desc.diagnose).toMatch(/cardFacts: true/);
  expect(desc.accept_swap).toMatch(/deck_stats/);
});

// ---------- card facts once, not twice (ISC-92) ----------

type Table = { columns: string[]; rows: unknown[][] };
/** A table's rows as the records they stand for. */
const records = (t: Table) => {
  expect(t.rows.every((r) => r.length === t.columns.length)).toBe(true);
  return t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])));
};

test("ISC-92 over MCP: deck_stats and diagnose carry every deck card's facts when asked (cardFacts: true), so a session gets them once, when it asks", async () => {
  const stats = await call("deck_stats", NAMOR);
  expect(stats.structuredContent.cardFacts).toBeUndefined();
  expect((await call("diagnose", { ...NAMOR, plan: NAMOR_PLAN })).structuredContent.cardFacts).toBeUndefined();
  const full = plain(deckStats(store, NAMOR).cardFacts);
  for (const [name, args] of [["deck_stats", NAMOR], ["diagnose", { ...NAMOR, plan: NAMOR_PLAN }]] as const) {
    const asked = (await call(name, { ...args, cardFacts: true })).structuredContent.cardFacts as Table;
    expect([name, asked.columns]).toEqual([name, ["name", "manaValue", "typeLine", "oracleText"]]);
    expect([name, records(asked)]).toEqual([name, full]);
  }
  // the rest of deck_stats is the function's result
  const { cardFacts: _, ...rest } = deckStats(store, NAMOR);
  expect(stats.structuredContent).toEqual(plain(rest));
}, 60_000);

// ---------- what the compact results keep ----------

test("compact diagnose: every role count and target, trim, off-plan card with its roles and reason, link count, unread card and engine gap is still there, each said once", async () => {
  for (const [deck, plan] of [[NAMOR, NAMOR_PLAN], [TEYSA, { themes: ["Aristocrats"] }]] as const) {
    const full = diagnose(store, { ...deck, plan });
    const c = (await call("diagnose", { ...deck, plan })).structuredContent as {
      roles: { role: string; count: number; target: number; source: string; expected?: number }[];
      targetBasis: Record<string, string[]>;
      over: { role: string; trims: { name: string; partners: number }[] }[]; under: string[];
      offPlan: { reason: string; cards: { name: string; roles: string[]; fitsAvoided?: string[] }[] }[];
      unread: { reason: string; cards: string[] }[];
      cards: Table;
      engineGaps: unknown; doingLeast: unknown; plan: unknown; noGraphData: unknown; lowPartners: unknown;
    };
    expect(c.roles).toEqual(full.roles.map(({ basis: _, ...r }) => r));
    for (const r of full.roles) expect(c.targetBasis[r.basis]).toContain(r.role);
    expect(c.over).toEqual(full.over.map((o) => ({ role: o.role, trims: o.trims })));
    expect(c.under).toEqual(full.under.map((u) => u.role));
    const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : 1);
    expect(c.offPlan.flatMap((g) => g.cards.map((x) => ({ name: x.name, roles: x.roles, fitsAvoided: x.fitsAvoided ?? [], reason: g.reason }))).sort(byName))
      .toEqual(full.offPlan.map((o) => ({ name: o.name, roles: o.roles, fitsAvoided: o.fitsAvoided, reason: o.reason })).sort(byName));
    expect(new Set(c.offPlan.map((g) => g.reason)).size).toBe(c.offPlan.length); // each reason once
    expect(c.unread.flatMap((g) => g.cards.map((name) => ({ name, reason: g.reason }))).sort(byName)).toEqual(full.unread.slice().sort(byName));
    expect(records(c.cards)).toEqual(full.cards.map((x) => ({ name: x.name, partners: x.partners, bucket: x.bucket, reason: x.reason ?? null })));
    for (const k of ["engineGaps", "doingLeast", "plan", "noGraphData", "lowPartners"] as const) expect([k, c[k]]).toEqual([k, plain(full[k])]);
  }
}, 120_000);

test("compact shortlist: every card keeps its name, mana value, price, type, roles, labels, scores, priority links, links counted by event and the numbers it moves", async () => {
  const args = { ...TEYSA, plan: { themes: ["Aristocrats"], priorities: ["Blood Artist"] }, problem: { engineGap: "a creature dying" } };
  const full = shortlist(store, args);
  const c = (await call("shortlist", args)).structuredContent as { cards: Table; before: unknown; pool: unknown; problem: unknown; notes: unknown };
  const got = records(c.cards);
  expect(got.length).toBe(full.cards.length);
  const expected = (x: (typeof full.cards)[number], withOut: boolean): Record<string, unknown> => {
    const e = x.evidence;
    return {
      name: x.name, manaValue: x.manaValue, usd: x.usd, typeLine: x.typeLine, roles: x.roles, labels: x.labels,
      commanderSynergy: e.commanderSynergy, taggerFit: e.taggerFit, edhrecRank: e.edhrecRank, partners: e.partners,
      planPartners: e.planPartners, planFit: e.planFit.score, priorityLinks: e.priorityLinks, feeds: e.feeds,
      links: x.links.length ? x.links.map((l) => [l.feeds.length && `feeds ${l.feeds.length}`, l.fedBy.length && `fed by ${l.fedBy.length}`].filter(Boolean).join(" and ") + ` on ${l.on}`).join("; ") : null,
      genericLinks: x.genericLinks, noLinks: x.noLinks,
      delta: { averageManaValue: x.delta.averageManaValue, onPlan: x.delta.onPlan, roleCounts: x.delta.roleCounts },
      ...(withOut && { after: x.after, planGain: x.planGain }),
    };
  };
  /** The row holds every field that has a value, under a column; a column only some cards fill is null for the rest. */
  const holds = (row: Record<string, unknown>, want: Record<string, unknown>, columns: string[]) => {
    for (const [k, v] of Object.entries(want)) if (v !== undefined && v !== null) expect([want.name, k, columns.includes(k)]).toEqual([want.name, k, true]);
    expect(row).toEqual(plain(Object.fromEntries(columns.map((col) => [col, want[col] ?? null]))));
  };
  for (const [k, x] of full.cards.entries()) holds(got[k], expected(x, false), c.cards.columns);
  // no `after` or `planGain` column without `out`
  expect(c.cards.columns).not.toContain("after");
  expect(c.cards.columns).not.toContain("planGain");
  for (const k of ["before", "pool", "problem", "notes"] as const) expect([k, c[k]]).toEqual([k, plain(full[k])]);
  // with `out`, each card also carries the numbers after the swap and its plan gain
  const off = diagnose(store, { ...TEYSA, plan: args.plan }).offPlan[0].name;
  const swap = shortlist(store, { ...args, out: off });
  const outTable = ((await call("shortlist", { ...args, out: off })).structuredContent as { cards: Table }).cards;
  const withOut = records(outTable);
  for (const [k, x] of swap.cards.entries()) holds(withOut[k], expected(x, true), outTable.columns);
}, 120_000);

test("compact swap candidates: every candidate keeps both cards, its reason, the average mana value and plan fit after and the role counts it moves, and shows role drops only when there are some", async () => {
  const args = { ...NAMOR, lever: "plan", limit: 15, plan: NAMOR_PLAN } as const;
  const full = swapCandidates(store, args);
  const c = (await call("swap_candidates", args)).structuredContent as { candidates: Record<string, unknown>[]; before: unknown };
  expect(c.before).toEqual(plain(full.before));
  for (const [k, x] of full.candidates.entries()) {
    expect(c.candidates[k]).toEqual(plain({
      out: x.out, in: x.in, reason: x.reason,
      after: { averageManaValue: x.after.averageManaValue, onPlan: x.after.onPlan },
      ...(Object.keys(x.delta.roleCounts).length && { delta: { roleCounts: x.delta.roleCounts } }),
      ...(x.roleDrops.length && { roleDrops: x.roleDrops }), ...(x.rolesBelowTarget.length && { rolesBelowTarget: x.rolesBelowTarget }),
    }));
  }
  expect(full.candidates.some((x) => x.roleDrops.length)).toBe(true); // the test sees both kinds
  expect(full.candidates.some((x) => !x.roleDrops.length)).toBe(true);
}, 60_000);

test("compact card and find_cards: the card's printed facts, tag labels and role names stay; find_cards rows hold every field of every card", async () => {
  for (const name of ["Talrand, Sky Summoner", "Delver of Secrets", "Sol Ring", "Island"]) {
    const full = cardDetails(store, { name }).card;
    const c = (await call("card", { name })).structuredContent as { card: Record<string, unknown>; matchedBy: string };
    expect(c.card).toEqual(plain({
      name: full.name, manaCost: full.manaCost, manaValue: full.manaValue, typeLine: full.typeLine, oracleText: full.oracleText,
      ...(full.power !== null && { power: full.power, toughness: full.toughness }), ...(full.keywords.length && { keywords: full.keywords }),
      colorIdentity: full.colorIdentity, usd: full.usd, tags: full.tags.map((t) => t.label), roles: full.roles.map((r) => r.role),
      ...(full.incidentalRoles.length && { incidentalRoles: full.incidentalRoles.map((r) => r.role) }),
    }));
  }
  for (const includeText of [false, true]) {
    const args = { colorIdentity: "U", manaValue: { max: 2 }, limit: 40, includeText };
    const full = findCards(store, args);
    const c = (await call("find_cards", args)).structuredContent as { total: number; offset: number; cards: Table };
    expect([c.total, c.offset]).toEqual([full.total, full.offset]);
    expect(records(c.cards)).toEqual(plain(full.cards));
  }
}, 60_000);

// ---------- determinism in the new defaults (AC #3) ----------

test("determinism: the same deck, plan and inputs give the same compact text, byte for byte, from the same server and from a fresh one", async () => {
  const calls: [string, object][] = [
    ["deck_stats", { ...NAMOR, plan: NAMOR_PLAN }],
    ["diagnose", { ...TEYSA, plan: { themes: ["Aristocrats"] } }],
    ["shortlist", { ...NAMOR, plan: NAMOR_PLAN, problem: { offPlan: true } }],
    ["swap_candidates", { ...NAMOR, lever: "plan", plan: NAMOR_PLAN }],
    ["card", { name: "Remand" }],
    ["find_cards", { colorIdentity: "UB", types: ["Creature"], limit: 30 }],
  ];
  const fresh = openStore();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createDeckServer(fresh).connect(a);
  const other = new Client({ name: "compact-test-2", version: "0" });
  await other.connect(b);
  try {
    for (const [name, args] of calls) {
      const first = (await call(name, args)).content[0].text;
      expect([name, (await call(name, args)).content[0].text]).toEqual([name, first]);
      const again = (await other.callTool({ name, arguments: args })) as Res;
      expect([name, again.content[0].text]).toEqual([name, first]);
    }
  } finally {
    await other.close();
    fresh.db.close();
  }
}, 180_000);

// ---------- receipts over MCP (ISC-103's wiring; the property test is in mcp.test.ts) ----------

test("accept and reject over MCP return the short receipt, and the deck file changes as the receipt says", async () => {
  const deckFile = join(scratch, "namor.txt");
  copyFileSync(new URL("../fixtures/namor.txt", import.meta.url).pathname, deckFile);
  const acc = await call("accept_swap", { commander: NAMOR.commander, deckFile, out: "Remand", in: "Archmage's Charm", lever: "plan" });
  const receipt = acc.structuredContent as { verdict: string; file: string; changeLog: string; changed: Record<string, [number, number]> };
  expect(acc.content[0].text.length).toBeLessThanOrEqual(300);
  expect(receipt).toMatchObject({ verdict: "accept", file: "namor.txt" });
  expect(receipt.changeLog).toMatch(/accepted swap \(plan\): -1 Remand, \+1 Archmage's Charm$/);
  expect(readFileSync(deckFile, "utf8").trimEnd().split("\n").at(-1)).toBe(receipt.changeLog);
  const rej = await call("reject_swap", { commander: NAMOR.commander, out: "Opt", in: "Consider", lever: "cheaper", note: "x".repeat(500) });
  expect(rej.structuredContent).toEqual({ verdict: "reject", out: "Opt", in: "Consider", lever: "cheaper" });
});

// ---------- recorded sessions (deck-tune-transcript.ts) ----------

test("a recorded session renders compact swap candidates with the same flags as full ones: under target, a drop at target, the numbers moved", () => {
  const args = { ...NAMOR, lever: "plan", limit: 15, plan: NAMOR_PLAN } as const;
  const full = swapCandidates(store, args);
  const event = (result: unknown) => ({ kind: "tool" as const, server: "mtg-deck", name: "swap_candidates", input: args, result, isError: false });
  const fullLines = renderEvent(event(plain(full))).split("\n").filter((l) => /^\d+\. /.test(l));
  const compactLines = renderEvent(event(plain(compactSwapCandidates(full)))).split("\n").filter((l) => /^\d+\. /.test(l));
  expect(compactLines.length).toBe(full.candidates.length);
  const flagOf = (l: string) => / \| (UNDER TARGET|drops a role, still at or above target|DROPS ROLE)$/.exec(l)?.[1] ?? "";
  expect(compactLines.map(flagOf)).toEqual(fullLines.map(flagOf));
  expect(compactLines.map(flagOf).some(Boolean)).toBe(true);
  for (const [k, c] of full.candidates.entries()) expect(compactLines[k]).toContain(`after avg MV ${c.after.averageManaValue}`);
  expect(compactLines.join("\n")).not.toContain("undefined");
});
