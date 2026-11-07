import { expect, test } from "bun:test";
import { loadSpace, parseDecklist, resolveName } from "./deck-pool";
import { compileRoleMap, loadRoleIndex, roleSheet, rolesOf, type RoleMap, type TagRecord } from "./roles";

// A small Tagger tree. Ids are made up; parents are named by label and turned into ids here.
const tag = (label: string, cards: string[], parents: string[] = []): TagRecord => ({
  id: `id-${label}`, label, parent_ids: parents.map((p) => `id-${p}`), taggings: cards.map((oracle_id) => ({ oracle_id })),
});
const tree = [
  tag("draw", []),
  tag("pure draw", ["deep-analysis", "censor"], ["draw"]),
  tag("repeatable pure draw", ["seafloor-oracle"], ["pure draw"]),
  tag("cantrip", ["opt"], ["pure draw"]),
  tag("loot", ["looter"], ["draw"]),
  tag("counterspell", ["censor"]),
];
const map: RoleMap = { roles: [{ role: "card draw", about: "test", tags: ["draw"] }] };
const names = (index: ReturnType<typeof compileRoleMap>, card: string) => rolesOf(index, card).roles.map((r) => r.role);

test("resolver: a card tagged with a child tag gets the role of its ancestor, and the matching tag is the evidence", () => {
  const index = compileRoleMap(map, tree);
  expect(rolesOf(index, "seafloor-oracle").roles).toEqual([{ role: "card draw", tags: ["repeatable pure draw"] }]);
  expect(names(index, "nobody")).toEqual([]);
});

test("resolver: an excluded tag and everything below it never give the role, even under an included tag", () => {
  const index = compileRoleMap({ roles: [{ role: "card draw", about: "test", tags: ["draw"], exclude: ["loot", "pure draw"] }] }, tree);
  expect(names(index, "looter")).toEqual([]);
  expect(names(index, "seafloor-oracle")).toEqual([]); // below pure draw
  expect(names(index, "deep-analysis")).toEqual([]);
});

const weakMap: RoleMap = { roles: [
  { role: "card draw", about: "test", tags: ["draw"], weak: ["pure draw", "cantrip"] },
  { role: "counterspell", about: "test", tags: ["counterspell"] },
] };

test("resolver: a weak tag gives its role only when no other tag gives the card a role; a dropped one shows as incidental", () => {
  const index = compileRoleMap(weakMap, tree);
  expect(rolesOf(index, "censor")).toEqual({ roles: [{ role: "counterspell", tags: ["counterspell"] }], incidental: [{ role: "card draw", tags: ["pure draw"] }] });
  expect(rolesOf(index, "deep-analysis")).toEqual({ roles: [{ role: "card draw", tags: ["pure draw"] }], incidental: [] });
  // weak is the exact tag, not its children: repeatable pure draw sits below pure draw and stays strong
  expect(names(index, "seafloor-oracle")).toEqual(["card draw"]);
  expect(rolesOf(index, "seafloor-oracle").incidental).toEqual([]);
});

test("resolver: a map naming a tag Tagger lacks or names twice, a weak tag outside its role, a role twice or a role with no tags fails to compile", () => {
  const one = (def: Partial<RoleMap["roles"][number]>) => ({ roles: [{ role: "card draw", about: "test", tags: ["draw"], ...def }] });
  expect(() => compileRoleMap(one({ tags: ["draw", "drawww"] }), tree)).toThrow(/drawww/);
  expect(() => compileRoleMap(one({ exclude: ["lot"] }), tree)).toThrow(/lot/);
  expect(() => compileRoleMap(one({ weak: ["counterspell"] }), tree)).toThrow(/counterspell/);
  expect(() => compileRoleMap({ roles: [...one({}).roles, ...one({}).roles] }, tree)).toThrow(/card draw/);
  expect(() => compileRoleMap(one({ tags: [] }), tree)).toThrow(/no tags/);
  // two Tagger tags under one label: the map can't say which it means
  expect(() => compileRoleMap(one({}), [...tree, { ...tag("draw", []), id: "id-draw-2" }])).toThrow(/"draw" names 2 Tagger tags/);
});

// ---------- the committed map, on the real Tagger data (ISC-20.1) ----------
const real = await loadRoleIndex();
const space = await loadSpace();
const rolesByName = (name: string) => rolesOf(real.index, resolveName(space, name)!.id).roles.map((r) => r.role);

test("role map: the committed file names about ten roles, every tag in it exists in Tagger, and every role reaches real cards", () => {
  // loadRoleIndex compiles the file, and compiling throws on any tag Tagger lacks (see the resolver tests)
  expect(real.map.roles.length).toBeGreaterThanOrEqual(8);
  expect(real.map.roles.length).toBeLessThanOrEqual(12);
  for (const def of real.map.roles) {
    expect(def.tags.length).toBeGreaterThan(0);
    expect(def.about.length).toBeGreaterThan(0);
  }
  const reached = new Set([...real.index.cardTags.keys()].flatMap((id) => rolesOf(real.index, id).roles.map((r) => r.role)));
  expect([...reached].sort()).toEqual(real.map.roles.map((r) => r.role).sort());
});

// Where a Commander player files these staples: a Magic player's judgment, the first 34 written before the map was run
// on them. The last four were added after, to pin calls the map makes on purpose: a top-of-library tutor is not card
// selection, a permanent steal is removal, a temporary steal and a one-shot ritual have no role.
const staples: Record<string, string[]> = {
  "Sol Ring": ["ramp"], "Arcane Signet": ["ramp"], "Llanowar Elves": ["ramp"], "Rampant Growth": ["ramp"],
  "Cultivate": ["ramp"], "Kodama's Reach": ["ramp"], "Mind Stone": ["ramp"],
  "Rhystic Study": ["card draw"], "Phyrexian Arena": ["card draw"], "Fact or Fiction": ["card draw"],
  "Brainstorm": ["card selection"], "Ponder": ["card selection"], "Faithless Looting": ["card selection"],
  "Swords to Plowshares": ["removal"], "Path to Exile": ["removal"], "Beast Within": ["removal"], "Chaos Warp": ["removal"],
  "Confiscate": ["removal"],
  "Wrath of God": ["board wipe"], "Toxic Deluge": ["board wipe"], "Cyclonic Rift": ["removal", "board wipe"],
  "Counterspell": ["counterspell"], "Swan Song": ["counterspell"], "Stifle": ["counterspell"],
  "Heroic Intervention": ["protection"], "Teferi's Protection": ["protection"], "Lightning Greaves": ["protection"],
  "Demonic Tutor": ["tutor"], "Mystical Tutor": ["tutor"],
  "Eternal Witness": ["recursion"], "Regrowth": ["recursion"], "Animate Dead": ["recursion"],
  "Sapphire Medallion": ["cost reducer"], "Goblin Electromancer": ["cost reducer"],
  "Vampiric Tutor": ["tutor"], "Control Magic": ["removal"], "Threaten": [], "Dark Ritual": [],
};

test("role map: well-known staples land in the roles a Commander player would file them under", () => {
  const got = Object.fromEntries(Object.keys(staples).map((n) => [n, rolesByName(n)]));
  expect(got).toEqual(staples);
});

// ---------- the Namor role sheet (ISC-20.2) ----------
const namor = roleSheet(real.index, parseDecklist(space, await Bun.file(new URL("../fixtures/namor.txt", import.meta.url).pathname).text()).entries);

test("namor roles: every nonland card is on the sheet once, either with its roles or in the unroled list; lands are skipped", () => {
  // fixtures/namor.txt: 100 cards, 34 Island + Mistrise Village + Reliquary Tower are the lands
  expect(namor.unresolved).toEqual([]);
  expect(namor.lands).toBe(36);
  const roled = namor.cards.filter((c) => c.roles.length).map((c) => c.name);
  expect(namor.cards.length).toBe(64);
  expect(new Set(namor.cards.map((c) => c.name)).size).toBe(64);
  expect(namor.unroled).toEqual(namor.cards.filter((c) => !c.roles.length).map((c) => c.name));
  expect(roled.length + namor.unroled.length).toBe(64);
  expect(namor.cards.map((c) => c.name)).not.toContain("Island");
  for (const c of namor.cards) for (const r of c.roles) expect(r.tags.length).toBeGreaterThan(0);
});

test("namor roles: spot checks a Namor player would agree with", () => {
  const of = (n: string) => namor.cards.find((c) => c.name === n)!;
  expect(of("Sol Ring").roles.map((r) => r.role)).toEqual(["ramp"]);
  expect(of("Evacuation").roles.map((r) => r.role)).toEqual(["board wipe"]);
  expect(of("Negate").roles.map((r) => r.role)).toEqual(["counterspell"]);
  expect(of("Solve the Equation").roles.map((r) => r.role)).toEqual(["tutor"]);
  expect(of("Kopala, Warden of Waves").roles.map((r) => r.role)).toEqual(["protection"]);
  // Censor's cycling draw comes along with the counter: shown, but not counted
  expect(of("Censor").roles.map((r) => r.role)).toEqual(["counterspell"]);
  expect(of("Censor").incidental.map((r) => r.role)).toEqual(["card draw"]);
  // Tagger calls stealing a land 'land ramp'; the steal is removal, not ramp
  expect(of("Blatant Thievery").roles.map((r) => r.role)).toEqual(["removal"]);
  // the plan's payoffs carry no support role
  for (const n of ["Coralhelm Commander", "Master of the Pearl Trident", "Tempest Caller"]) expect(namor.unroled).toContain(n);
});

test("resolver: a sheet counts copies, merges a card listed twice, skips lands and reports unknown lines", () => {
  const index = compileRoleMap(weakMap, tree);
  const card = (id: string, land = false) => ({ id, name: id, land });
  const sheet = roleSheet(index, [
    { line: 1, qty: 2, text: "censor", card: card("censor") },
    { line: 2, qty: 1, text: "island", card: card("island", true) },
    { line: 3, qty: 1, text: "Opt", card: card("opt") },
    { line: 4, qty: 1, text: "censor", card: card("censor") },
    { line: 5, qty: 1, text: "Not A Card" },
    { line: 6, qty: 1, text: "nobody", card: card("nobody") },
  ]);
  expect(sheet.cards.map((c) => [c.name, c.qty])).toEqual([["censor", 3], ["opt", 1], ["nobody", 1]]);
  expect(sheet.counts).toEqual({ "card draw": 1, counterspell: 3 });
  expect(sheet.unroled).toEqual(["nobody"]);
  expect(sheet.lands).toBe(1);
  expect(sheet.unresolved).toEqual([{ line: 5, text: "Not A Card" }]);
});

