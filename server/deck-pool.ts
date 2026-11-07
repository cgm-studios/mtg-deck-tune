// MV-9: the deck pool. A commander plus an anchor list (cards, optionally Regions) becomes the pool: the
// commander-legal nonland cards in the anchors' Card Space neighborhoods inside the commander's color identity.
// The pool is computed here, never picked by a model (ISA 20261106-card-galaxy-deck-mcp, Constraints).
//
// Ranking: personalized PageRank over the Card Space kNN graph (data/card-space/chosen-full.json, top-10 neighbors
// per card, symmetrized, edge weight = similarity), restricted to cards eligible for the commander. The restart
// mass sits on the seeds: each anchor card, the commander itself (optional), and the members of each anchored
// Region (sharing `regionWeight` of the mass). The pool is the top `size` cards by score; anchors always lead.
// Everything iterates in a fixed card order and ties break by name then oracle id, so the same inputs give the
// same pool card for card (ISC-3).

import { fitsIdentity } from "./color-identity";
import { oracleText, readJSONL } from "./scryfall";

export const METHODS = ["leiden", "leidenHi", "hdb10"] as const;
export type Method = (typeof METHODS)[number];
export type RegionRef = { method: Method; id: number };

export type SpaceCard = {
  id: string; name: string; ci: string[]; legal: boolean; land: boolean; inSpace: boolean;
  nb: string[]; ns: number[]; r: Partial<Record<Method, number>>; textless?: boolean;
  meta?: CardMeta;
};
// Rules data the swap lever reads (front face for cost and type; every face for text). Scryfall only.
export type CardMeta = { cost: string; type: string; text: string; cmc: number; usd: number | null; keywords: string[] };
export type RegionInfo = { method: Method; id: number; name: string; n: number };
export type Space = {
  cards: Map<string, SpaceCard>;
  order: string[]; // Card Space ids, sorted by name then id: the one iteration order
  byName: Map<string, string[]>; // normalized name → ids (Card Space first, then other legal cards, then the rest)
  regions: RegionInfo[];
};

// ---------- names ----------
// Lower case, accents dropped, punctuation dropped, spaces collapsed: "Namor, the Sub-Mariner" and
// "Namor the Sub-Mariner" (Scryfall renamed it) meet; "Aquitect's Will" meets "Aquitects Will".
export const normName = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9/ ]+/g, " ").replace(/\s+/g, " ").trim();

const rank = (c: SpaceCard) => (c.inSpace ? 0 : c.legal ? 1 : 2);

export function buildSpace(cards: SpaceCard[], regions: RegionInfo[] = []): Space {
  const map = new Map(cards.map((c) => [c.id, c]));
  const byKey = (a: SpaceCard, b: SpaceCard) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const order = cards.filter((c) => c.inSpace).sort(byKey).map((c) => c.id);
  const byName = new Map<string, string[]>();
  const add = (k: string, id: string) => { const l = byName.get(k) ?? []; if (!l.includes(id)) l.push(id); byName.set(k, l); };
  for (const c of cards) {
    add(normName(c.name), c.id);
    if (c.name.includes(" // ")) add(normName(c.name.split(" // ")[0]), c.id); // a double-faced card by its front name
  }
  for (const l of byName.values()) l.sort((a, b) => rank(map.get(a)!) - rank(map.get(b)!) || byKey(map.get(a)!, map.get(b)!));
  return { cards: map, order, byName, regions };
}

// The same Space with neighbor lists swapped in (MV-10: the in-color graph). Cards absent from `graph` keep theirs.
export function withGraph(space: Space, graph: Map<string, { nb: string[]; ns: number[] }>): Space {
  const cards = new Map([...space.cards].map(([id, c]) => [id, graph.has(id) ? { ...c, ...graph.get(id)! } : c]));
  return { ...space, cards };
}

// The Space a commander's pool walks: `in-color` (default, MV-10) recomputes neighbors inside its color identity;
// `global` keeps chosen-full.json's top 10 across all colors (MV-9).
export type GraphKind = "in-color" | "global";
export async function spaceFor(space: Space, commander: SpaceCard, graph: GraphKind = "in-color"): Promise<Space> {
  if (graph === "global") return space;
  const { loadInColor } = await import("./in-color");
  return withGraph(space, await loadInColor(commander.ci, (id) => space.cards.get(id)?.ci ?? ["?"]));
}

export function resolveName(space: Space, name: string): SpaceCard | undefined {
  const ids = space.byName.get(normName(name));
  return ids?.length ? space.cards.get(ids[0]) : undefined;
}

// ---------- loading ----------
const DATA = new URL("../data/", import.meta.url).pathname;

type Face = { name?: string; type_line?: string; mana_cost?: string; oracle_text?: string };
type Oracle = Face & { oracle_id: string; name: string; color_identity?: string[]; legalities?: Record<string, string>; card_faces?: Face[]; cmc?: number; prices?: { usd?: string | null }; keywords?: string[] };

export async function loadSpace(dataDir = DATA): Promise<Space> {
  const chosen = await Bun.file(`${dataDir}card-space/chosen-full.json`).json();
  const oracle: Oracle[] = await readJSONL(`${dataDir}scryfall/oracle_cards.jsonl.gz`);
  const cards: SpaceCard[] = [];
  const seen = new Set<string>();
  for (const o of oracle) {
    if (!o.oracle_id || seen.has(o.oracle_id)) continue;
    seen.add(o.oracle_id);
    const s = chosen.cards[o.oracle_id];
    const legal = o.legalities?.commander === "legal" || o.legalities?.commander === "restricted";
    const front = o.card_faces?.[0]?.type_line ?? o.type_line ?? "";
    cards.push({
      id: o.oracle_id, name: o.name, ci: o.color_identity ?? [], legal, land: /\bLand\b/.test(front), inSpace: !!s,
      nb: s?.nb ?? [], ns: s?.ns ?? [], r: s?.r ?? {}, textless: s?.textless,
      meta: {
        cost: o.card_faces?.[0]?.mana_cost ?? o.mana_cost ?? "", type: front,
        text: oracleText(o),
        cmc: o.cmc ?? 0, usd: o.prices?.usd ? +o.prices.usd : null, keywords: o.keywords ?? [],
      },
    });
  }
  const regions: RegionInfo[] = METHODS.flatMap((m) => (chosen.methods[m]?.regions ?? []).map((r: RegionInfo) => ({ method: m, id: r.id, name: r.name, n: r.n })));
  return buildSpace(cards, regions);
}

// ---------- anchors ----------
// An anchors file: one card name per line, `commander: <name>` once, `region: <method>:<id>` for a Region,
// `#` comments and blank lines ignored.
export type AnchorSpec = { commander?: string; cards: string[]; regions: string[] };
export type Anchors = { commander: SpaceCard; cards: SpaceCard[]; regions: (RegionRef & { name: string; n: number })[]; problems: string[] };

export function parseAnchors(text: string): AnchorSpec {
  const spec: AnchorSpec = { cards: [], regions: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^(commander|region)\s*:\s*(.+)$/i);
    if (m?.[1].toLowerCase() === "commander") spec.commander = m[2].trim();
    else if (m) spec.regions.push(m[2].trim());
    else spec.cards.push(line.replace(/^\d+x?\s+/, ""));
  }
  return spec;
}

export function resolveAnchors(space: Space, spec: AnchorSpec): Anchors {
  const problems: string[] = [];
  const commander = spec.commander ? resolveName(space, spec.commander) : undefined;
  if (!spec.commander) problems.push("no `commander:` line");
  else if (!commander) problems.push(`commander not found: ${spec.commander}`);
  else if (!commander.inSpace) problems.push(`commander is not in the Card Space: ${commander.name}`);
  const cards: SpaceCard[] = [];
  for (const n of spec.cards) {
    const c = resolveName(space, n);
    if (!c) { problems.push(`anchor not found: ${n}`); continue; }
    if (!c.inSpace) { problems.push(`anchor is not in the Card Space (land or not commander-legal): ${c.name}`); continue; }
    if (commander && !eligible(c, commander)) { problems.push(`anchor is outside ${commander.name}'s color identity: ${c.name}`); continue; }
    if (!cards.includes(c)) cards.push(c);
  }
  const regions: Anchors["regions"] = [];
  for (const r of spec.regions) {
    const m = r.match(/^(\w+):(\d+)$/);
    const info = m && space.regions.find((x) => x.method === m[1] && x.id === +m[2]);
    if (!info) { problems.push(`Region not found: ${r} (use method:id, e.g. hdb10:16)`); continue; }
    if (!regions.some((x) => x.method === info.method && x.id === info.id)) regions.push({ method: info.method, id: info.id, name: info.name, n: info.n });
  }
  if (cards.length < 3 || cards.length > 8) problems.push(`${cards.length} anchor cards; the plan wants 3 to 8`);
  return { commander: commander ?? ({} as SpaceCard), cards, regions, problems };
}

// ---------- the pool ----------
export const eligible = (c: SpaceCard, commander: SpaceCard) =>
  c.inSpace && c.legal && !c.land && c.id !== commander.id && fitsIdentity(c, commander.ci);

export type PoolOptions = { size?: number; regionWeight?: number; commanderSeed?: boolean; alpha?: number; iterations?: number };
export type PoolCard = { id: string; name: string; score: number; anchor: boolean };
export const POOL_DEFAULTS = { size: 300, regionWeight: 0.25, commanderSeed: true, alpha: 0.15, iterations: 60 };

// The full ranking (every reachable eligible card, best first); `pool` cuts it to size.
export function rankPool(space: Space, a: Pick<Anchors, "commander" | "cards" | "regions">, opts: PoolOptions = {}): PoolCard[] {
  const o = { ...POOL_DEFAULTS, ...opts };
  const ids = space.order.filter((id) => eligible(space.cards.get(id)!, a.commander));
  const at = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  // symmetrized weighted adjacency over eligible cards; an edge listed both ways keeps the larger similarity
  const adj: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  const link = (i: number, j: number, w: number) => { if (w > (adj[i].get(j) ?? 0)) adj[i].set(j, w); };
  const seedNb = (src: SpaceCard, into: (j: number, w: number) => void) =>
    src.nb.forEach((v, k) => { const j = at.get(v); if (j !== undefined) into(j, Math.max(0, src.ns[k] ?? 0)); });
  ids.forEach((id, i) => seedNb(space.cards.get(id)!, (j, w) => { link(i, j, w); link(j, i, w); }));
  const out = Float64Array.from(adj, (m) => [...m.values()].reduce((s, w) => s + w, 0));

  // restart vector: anchors and the commander share (1 - regionWeight); Region members share regionWeight
  const restart = new Float64Array(n);
  const cardSeeds = a.cards.map((c) => at.get(c.id)).filter((i): i is number => i !== undefined);
  const commanderNb: [number, number][] = [];
  if (o.commanderSeed && a.commander.inSpace) seedNb(a.commander, (j, w) => commanderNb.push([j, w])); // not eligible itself: seed its neighbors
  const members = a.regions.length ? ids.map((id, i) => [i, space.cards.get(id)!] as const).filter(([, c]) => a.regions.some((r) => c.r[r.method] === r.id)).map(([i]) => i) : [];
  const rw = members.length ? o.regionWeight : 0;
  const unitSeeds = cardSeeds.length + (commanderNb.length ? 1 : 0);
  if (unitSeeds) {
    const each = (1 - rw) / unitSeeds;
    for (const i of cardSeeds) restart[i] += each;
    const cw = commanderNb.reduce((s, [, w]) => s + w, 0);
    for (const [j, w] of commanderNb) restart[j] += cw > 0 ? (each * w) / cw : each / commanderNb.length;
  }
  if (members.length) for (const i of members) restart[i] += (unitSeeds ? rw : 1) / members.length;

  let p = Float64Array.from(restart);
  for (let it = 0; it < o.iterations; it++) {
    const next = new Float64Array(n);
    for (let i = 0; i < n; i++) next[i] = o.alpha * restart[i];
    for (let i = 0; i < n; i++) {
      if (!p[i]) continue;
      if (!out[i]) { next[i] += (1 - o.alpha) * p[i]; continue; } // dangling: mass stays put
      const f = ((1 - o.alpha) * p[i]) / out[i];
      for (const [j, w] of adj[i]) next[j] += f * w;
    }
    p = next;
  }
  const anchorSet = new Set(cardSeeds);
  return ids
    .map((id, i) => ({ id, name: space.cards.get(id)!.name, score: p[i], anchor: anchorSet.has(i), i }))
    .filter((c) => c.score > 0)
    .sort((x, y) => +y.anchor - +x.anchor || y.score - x.score || x.i - y.i) // x.i follows space.order (name, id)
    .map(({ i: _i, ...c }) => c);
}

export function pool(space: Space, a: Pick<Anchors, "commander" | "cards" | "regions">, opts: PoolOptions = {}): PoolCard[] {
  return rankPool(space, a, opts).slice(0, opts.size ?? POOL_DEFAULTS.size);
}

// ---------- decklists ----------
// `1 Card Name` lines as TopDecked, Moxfield and Archidekt export them: trailing spaces, section headers
// ("Commander (1)", "Main (99)", "namor: namor"), URLs and comments skipped; set codes and foil marks stripped.
export type DeckEntry = { line: number; qty: number; text: string; card?: SpaceCard };
export type Decklist = { entries: DeckEntry[]; unresolved: DeckEntry[]; skipped: { line: number; text: string }[] };

export function parseDecklist(space: Space, text: string): Decklist {
  const entries: DeckEntry[] = [], skipped: Decklist["skipped"] = [];
  text.split(/\r?\n/).forEach((raw, k) => {
    const line = raw.trim();
    if (!line) return;
    const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (!m) { skipped.push({ line: k + 1, text: line }); return; }
    const name = m[2].replace(/\s+\*[A-Z]+\*$/, "").replace(/\s+\([A-Za-z0-9]{2,6}\)(\s+\S+)?$/, "").replace(/\s+#.*$/, "").trim();
    entries.push({ line: k + 1, qty: +m[1], text: name, card: resolveName(space, name) });
  });
  return { entries, unresolved: entries.filter((e) => !e.card), skipped };
}
