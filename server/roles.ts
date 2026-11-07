// MV-14: the role map. Scryfall Tagger tags (child tags included) → about ten deck roles a Commander player
// counts (ramp, card draw, removal, ...). The map is the committed file app/roles.json; this module compiles it
// against the Oracle Tags file and answers which roles a card has and which of its tags gave them.
// Pure except loadRoleIndex, which reads the two files.

import { readJSONL } from "./scryfall";

// An Oracle Tags record, cut to the fields read here. child_ids is optional: children are also found from parent_ids.
export type TagRecord = { id: string; label: string; parent_ids: string[]; child_ids?: string[]; taggings: { oracle_id: string }[] };

// One role in roles.json. `tags`: a card carrying one of these, or any tag below them in the Tagger tree, gets the
// role. `exclude`: these tags and everything below them never give the role. `weak`: exact tags (not their
// children) that give the role only when no other tag gives the card any role: draw that comes along with a card
// bought for something else, like cycling on a counterspell or the cantrip on a removal spell.
export type RoleDef = { role: string; about: string; tags: string[]; exclude?: string[]; weak?: string[] };
export type RoleMap = { roles: RoleDef[] };

export type RoleIndex = {
  roleNames: string[];
  // tag id → the roles it gives, and whether it gives each one weakly
  gives: Map<string, { role: string; weak: boolean }[]>;
  label: Map<string, string>;
  // oracle id → its tag ids (direct taggings only; ancestry is folded into `gives`)
  cardTags: Map<string, string[]>;
};

// A card's roles, each with the card's own tags that gave it (sorted), roles in roles.json order. `incidental`:
// roles only weak tags pointed at, dropped because another tag explains the card.
export type RoleHit = { role: string; tags: string[] };
export type CardRoles = { roles: RoleHit[]; incidental: RoleHit[] };

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);

export function compileRoleMap(map: RoleMap, tags: TagRecord[]): RoleIndex {
  const byId = new Map(tags.map((t) => [t.id, t]));
  const children = new Map<string, Set<string>>();
  const link = (parent: string, child: string) => { if (byId.has(parent) && byId.has(child)) (children.get(parent) ?? children.set(parent, new Set()).get(parent)!).add(child); };
  for (const t of tags) {
    for (const p of t.parent_ids) link(p, t.id);
    for (const c of t.child_ids ?? []) link(t.id, c);
  }
  const idsOf = new Map<string, string[]>();
  for (const t of tags) push(idsOf, t.label, t.id);
  // a tag and everything below it
  const below = (id: string, out = new Set<string>()) => {
    if (out.has(id)) return out;
    out.add(id);
    for (const c of children.get(id) ?? []) below(c, out);
    return out;
  };

  // every problem in the map at once, so a bad edit is fixed in one pass
  const problems: string[] = [];
  const seen = new Set<string>();
  const id = (def: RoleDef, l: string) => {
    const xs = idsOf.get(l) ?? [];
    if (!xs.length) problems.push(`${def.role}: no Tagger tag "${l}"`);
    if (xs.length > 1) problems.push(`${def.role}: "${l}" names ${xs.length} Tagger tags`);
    return xs.length === 1 ? xs[0] : undefined;
  };
  const gives: RoleIndex["gives"] = new Map();
  for (const def of map.roles) {
    if (seen.has(def.role)) problems.push(`role "${def.role}" is named twice`);
    seen.add(def.role);
    if (!Array.isArray(def.tags) || !def.tags.length) problems.push(`role "${def.role}" has no tags`);
    const ids = new Set<string>(), cut = new Set<string>(), weak = new Set<string>();
    for (const l of def.tags ?? []) { const x = id(def, l); if (x) below(x, ids); }
    for (const l of def.exclude ?? []) { const x = id(def, l); if (x) below(x, cut); }
    for (const l of def.weak ?? []) {
      const x = id(def, l);
      if (x && (!ids.has(x) || cut.has(x))) problems.push(`${def.role}: weak tag "${l}" does not give this role`);
      if (x) weak.add(x);
    }
    for (const x of ids) if (!cut.has(x)) push(gives, x, { role: def.role, weak: weak.has(x) });
  }
  if (problems.length) throw new Error(`role map does not compile:\n  ${problems.join("\n  ")}`);
  const cardTags = new Map<string, string[]>();
  for (const t of tags) for (const g of t.taggings) push(cardTags, g.oracle_id, t.id);
  return { roleNames: map.roles.map((r) => r.role), gives, label: new Map(tags.map((t) => [t.id, t.label])), cardTags };
}

export function rolesOf(index: RoleIndex, oracleId: string): CardRoles {
  const evidence = new Map<string, Set<string>>(), strong = new Set<string>();
  for (const id of index.cardTags.get(oracleId) ?? [])
    for (const { role, weak } of index.gives.get(id) ?? []) {
      (evidence.get(role) ?? evidence.set(role, new Set()).get(role)!).add(index.label.get(id)!);
      if (!weak) strong.add(role);
    }
  const hits = index.roleNames.filter((r) => evidence.has(r)).map((role) => ({ role, tags: [...evidence.get(role)!].sort() }));
  // with no strong role, the weak ones stand
  if (!strong.size) return { roles: hits, incidental: [] };
  return { roles: hits.filter((h) => strong.has(h.role)), incidental: hits.filter((h) => !strong.has(h.role)) };
}

// ---------- loading ----------
const DATA = new URL("../data/", import.meta.url).pathname;
const MAP = new URL("./roles.json", import.meta.url).pathname;

// The committed map compiled against the cached Oracle Tags file. Throws if the map names a tag Tagger lacks.
export async function loadRoleIndex(dataDir = DATA, mapPath = MAP): Promise<{ map: RoleMap; index: RoleIndex }> {
  const map: RoleMap = await Bun.file(mapPath).json();
  if (!Array.isArray(map?.roles)) throw new Error(`${mapPath}: no "roles" list`);
  const tags: TagRecord[] = await readJSONL(`${dataDir}scryfall/oracle_tags.jsonl.gz`);
  return { map, index: compileRoleMap(map, tags) };
}

// ---------- role sheet ----------
// A decklist line as parseDecklist returns it; `card` is missing when the name did not resolve.
export type SheetEntry = { line: number; qty: number; text: string; card?: { id: string; name: string; land: boolean } };
export type SheetCard = { name: string; qty: number } & CardRoles;
export type RoleSheet = {
  cards: SheetCard[]; // every nonland card once, in list order (a card on several lines is merged, copies summed)
  unroled: string[]; // the cards above with no role, in list order
  counts: Record<string, number>; // role → copies of cards with it, every role in the map listed
  lands: number; // land copies skipped
  unresolved: { line: number; text: string }[]; // lines whose card is unknown, so neither roled nor unroled
};

export function roleSheet(index: RoleIndex, entries: SheetEntry[]): RoleSheet {
  const byId = new Map<string, SheetCard>();
  const unresolved: RoleSheet["unresolved"] = [];
  let lands = 0;
  for (const e of entries) {
    if (!e.card) { unresolved.push({ line: e.line, text: e.text }); continue; }
    if (e.card.land) { lands += e.qty; continue; }
    const had = byId.get(e.card.id);
    if (had) had.qty += e.qty;
    else byId.set(e.card.id, { name: e.card.name, qty: e.qty, ...rolesOf(index, e.card.id) });
  }
  const cards = [...byId.values()];
  const counts = Object.fromEntries(index.roleNames.map((r) => [r, 0]));
  for (const c of cards) for (const r of c.roles) counts[r.role] += c.qty;
  return { cards, unroled: cards.filter((c) => !c.roles.length).map((c) => c.name), counts, lands, unresolved };
}

// The sheet as text: one line per nonland card (`name  role (tags); role (tags)`), the role counts, the unroled list.
export function formatRoleSheet(sheet: RoleSheet, title: string): string {
  const hits = (hs: RoleHit[]) => hs.map((h) => `${h.role} (${h.tags.join(", ")})`).join("; ");
  const copies = sheet.cards.reduce((n, c) => n + c.qty, 0);
  const lines = [
    `role sheet: ${title}`,
    `${sheet.cards.length} nonland cards (${copies} copies); ${sheet.lands} land copies skipped`,
    `role counts: ${Object.entries(sheet.counts).map(([r, n]) => `${r} ${n}`).join(" · ")}`,
    "",
    ...sheet.cards.map((c) => {
      const name = c.qty > 1 ? `${c.qty}x ${c.name}` : c.name;
      const roles = c.roles.length ? hits(c.roles) : "(no role)";
      return `${name}  ${roles}${c.incidental.length ? `; incidental: ${hits(c.incidental)}` : ""}`;
    }),
    "",
    `unroled (${sheet.unroled.length}): ${sheet.unroled.join("; ") || "none"}`,
    ...sheet.unresolved.map((u) => `! unresolved line ${u.line}: ${u.text}`),
  ];
  return lines.join("\n");
}
