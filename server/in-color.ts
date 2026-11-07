// MV-10: Card Space neighbor lists computed inside one color identity.
// chosen-full.json keeps each card's top 10 across all colors, so a color filter cuts most links (mono-blue keeps
// 4.84 of 10; 439 cards keep none, MV-9). Here the kNN is recomputed among only the cards a commander can play, with
// ADR 0001's similarity as amended (MV-7.15 opt1):
//   two cards with t4 text   (t4 cosine + w * tag cosine) / (1 + w), w = mean of clamp((120 - t4 chars) / 60, 0, 1.5),
//                            the tag part skipped only when both cards are tagless
//   a text-less card         fixed blend: t4 (w 1, 0 against a card with text) + cleaned tags (w 1) + keyword IDF
//                            (w 0.25); a part counts only when either card has it
//   a card with text never lists a text-less card (its t4 part is 0 and the blend applies only to text-less rows),
//   matching docs/research/card-space-full/knn.ts. Ties break by Card Space order, so results are deterministic.
// Note: data/card-space/chosen-full.json came from the plain t4 run, not opt1 (regions.ts writes the cache only
// when no VARIANT is set). This file uses opt1, the adopted rule.
//
//   bun app/in-color.ts features        copy t4 embeddings + features from docs/research/card-space-full/out/ into
//                                       data/card-space/t4/ (shared by every worktree; run once in the main checkout)
//   bun app/in-color.ts build <CI>      build and cache the graph for a color identity, e.g. U, WUB, C (colorless)

import { existsSync, mkdirSync } from "node:fs";

export const D = 384;
export type Sparse = { k: Int32Array; w: Float32Array };
export type Features = { N: number; ids: string[]; t4len: Int32Array; hasText: Uint8Array; X: Float32Array; tags: Sparse[]; kw: Sparse[] };
export type Graph = { K: number; rows: number[]; nb: Int32Array; ns: Float32Array }; // rows: global indices; nb: global indices, -1 = none

// sorted by slot: sdot walks both vectors in step (features.json does not store tag slots in order)
const sp = (rows: [number[], number[]][]): Sparse[] => rows.map(([k, w]) => {
  const o = k.map((_, x) => x).sort((a, b) => k[a] - k[b]);
  return { k: Int32Array.from(o, (x) => k[x]), w: Float32Array.from(o, (x) => w[x]) };
});
export const featuresFrom = (F: { N: number; ids: string[]; t4: string[]; tags: { rows: [number[], number[]][] }; keywordsIdf: { rows: [number[], number[]][] } }, X: Float32Array): Features => ({
  N: F.N, ids: F.ids, X,
  t4len: Int32Array.from(F.t4, (s) => s.length), hasText: Uint8Array.from(F.t4, (s) => +!!s),
  tags: sp(F.tags.rows), kw: sp(F.keywordsIdf.rows),
});

// sparse dot product of two sorted sparse vectors
function sdot(a: Sparse, b: Sparse) {
  let s = 0, x = 0, y = 0;
  while (x < a.k.length && y < b.k.length) {
    if (a.k[x] === b.k[y]) s += a.w[x++] * b.w[y++];
    else if (a.k[x] < b.k[y]) x++;
    else y++;
  }
  return s;
}

// ADR 0001's similarity (MV-7.15 opt1) between cards i and j (global indices); undefined = the pair is never listed
// (a card with text never lists a text-less card). One definition, shared by the in-color graph and the card store.
export type Scorer = (i: number, j: number) => number | undefined;
export function pairScorer(f: Features): Scorer {
  const X = f.X;
  const tagW = Float64Array.from({ length: f.N }, (_, i) => Math.max(0, Math.min(1.5, (120 - f.t4len[i]) / 60)));
  return (i, j) => {
    const text = f.hasText[i] === 1, ti = f.tags[i].k.length > 0;
    if (text) {
      if (!f.hasText[j]) return undefined;
      const oi = i * D, oj = j * D;
      let d = 0;
      for (let x = 0; x < D; x++) d += X[oi + x] * X[oj + x];
      const w = (tagW[i] + tagW[j]) / 2;
      return w > 0 && (ti || f.tags[j].k.length) ? (d + w * sdot(f.tags[i], f.tags[j])) / (1 + w) : d;
    }
    let num = 0, den = 0;
    if (f.hasText[j]) den += 1;
    if (ti || f.tags[j].k.length) { num += sdot(f.tags[i], f.tags[j]); den += 1; }
    if (f.kw[i].k.length > 0 || f.kw[j].k.length) { num += 0.25 * sdot(f.kw[i], f.kw[j]); den += 0.25; }
    return den > 0 ? num / den : 0;
  };
}

// The kNN graph among `subset` (global indices, any order), K neighbors per card, strongest first.
export function inColorKnn(f: Features, subset: number[], K = 30): Graph {
  const rows = [...subset].sort((a, b) => a - b), n = rows.length;
  const nb = new Int32Array(n * K).fill(-1), ns = new Float32Array(n * K).fill(-Infinity);
  // insert (j, s) into row r's sorted top-K; strictly better replaces, so ties keep the lower index (scanned first)
  const put = (r: number, j: number, s: number) => {
    const o = r * K;
    if (!(s > ns[o + K - 1]) && nb[o + K - 1] !== -1) return;
    let p = K - 1;
    while (p > 0 && (nb[o + p - 1] === -1 || ns[o + p - 1] < s)) { ns[o + p] = ns[o + p - 1]; nb[o + p] = nb[o + p - 1]; p--; }
    ns[o + p] = s; nb[o + p] = j;
  };
  const score = pairScorer(f);
  for (let a = 0; a < n; a++) {
    const i = rows[a];
    for (let b = 0; b < n; b++) {
      if (b === a) continue;
      const s = score(i, rows[b]);
      if (s !== undefined) put(a, rows[b], s);
    }
  }
  return { K, rows, nb, ns };
}

// MV-13: one ranked neighbor list per card over the whole Card Space, long enough that any color identity the card
// can be played in still gets its own top K. Similarity is pairwise, so the in-color top K for an identity X is the
// first K cards of this list whose color identity lies inside X. The list stops at the K-th neighbor inside the
// card's OWN identity (the narrowest X it can be played in; every wider X reaches K sooner), or at the end of the
// card's candidates when fewer than K exist. `mask` gives each global index a color-identity bit mask, -1 = not a candidate.
// Ties order exactly as in inColorKnn (see the sort below).
export function neighborList(f: Features, score: Scorer, i: number, mask: Int32Array, K = 30): { nb: number[]; ns: number[] } {
  const row = new Float64Array(f.N).fill(NaN);
  const own = mask[i];
  const top = new Float64Array(K).fill(-Infinity); // K best scores inside the own identity, sorted
  let inside = 0;
  for (let j = 0; j < f.N; j++) {
    if (j === i || mask[j] < 0) continue;
    const s = score(i, j);
    if (s === undefined) continue;
    row[j] = s;
    if ((mask[j] & ~own) === 0) {
      inside++;
      if (s > top[K - 1]) { let p = K - 1; while (p > 0 && top[p - 1] < s) { top[p] = top[p - 1]; p--; } top[p] = s; }
    }
  }
  const tau = inside >= K ? top[K - 1] : -Infinity;
  const cand: number[] = [];
  for (let j = 0; j < f.N; j++) if (row[j] >= tau) cand.push(j); // NaN fails the test
  // Exactly equal scores: inColorKnn stores float32 and tests a new double against the stored value, so a tie goes to
  // the later card when float32 rounded the score down and to the earlier card otherwise. Kept, so the store and the
  // cached MV-10 graphs list tied cards in the same order.
  cand.sort((a, b) => row[b] - row[a] || (Math.fround(row[a]) < row[a] ? b - a : a - b));
  const nb: number[] = [], ns: number[] = [];
  let seen = 0;
  for (const j of cand) {
    nb.push(j); ns.push(row[j]);
    if ((mask[j] & ~own) === 0 && ++seen === K) break;
  }
  return { nb, ns };
}

// ---------- files ----------
const DATA = new URL("../data/card-space/", import.meta.url).pathname;
const RESEARCH_OUT = new URL("../docs/research/card-space-full/out/", import.meta.url).pathname;

export async function loadFeatures(dir = `${DATA}t4/`): Promise<Features> {
  if (!existsSync(`${dir}features.json`)) throw new Error(`no ${dir}features.json; run \`bun app/in-color.ts features\` in the main checkout`);
  const F = await Bun.file(`${dir}features.json`).json();
  return featuresFrom(F, new Float32Array(await Bun.file(`${dir}emb-t4fix.f32`).arrayBuffer()));
}

export const ciKey = (ci: string[]) => ["W", "U", "B", "R", "G"].filter((c) => ci.includes(c)).join("") || "C";

// Cached per color identity under data/card-space/in-color/; built on first use (mono-blue: seconds; five-color:
// the whole space, about 90 s). Eligible = in the Card Space with color identity inside `ci`.
export async function loadInColor(ci: string[], cardCi: (id: string) => string[], K = 30, f?: Features): Promise<Map<string, { nb: string[]; ns: number[] }>> {
  const key = ciKey(ci), file = `${DATA}in-color/knn-${key}-k${K}.json`;
  if (existsSync(file)) {
    const c = await Bun.file(file).json();
    return new Map(Object.entries(c.rows as Record<string, [string[], number[]]>).map(([id, [nb, ns]]) => [id, { nb, ns }]));
  }
  f ??= await loadFeatures();
  const subset = f.ids.map((id, i) => [id, i] as const).filter(([id]) => cardCi(id).every((c) => ci.includes(c))).map(([, i]) => i);
  const g = inColorKnn(f, subset, K);
  const out: Record<string, [string[], number[]]> = {};
  g.rows.forEach((i, r) => {
    const nb: string[] = [], ns: number[] = [];
    for (let x = 0; x < K; x++) { const j = g.nb[r * K + x]; if (j >= 0) { nb.push(f!.ids[j]); ns.push(+g.ns[r * K + x].toFixed(4)); } }
    out[f!.ids[i]] = [nb, ns];
  });
  mkdirSync(`${DATA}in-color`, { recursive: true });
  await Bun.write(file, JSON.stringify({ built: new Date().toISOString().slice(0, 10), ticket: "MV-10", ci: key, K, similarity: "ADR 0001 opt1 (MV-7.15)", rows: out }));
  return new Map(Object.entries(out).map(([id, [nb, ns]]) => [id, { nb, ns }]));
}

if (import.meta.main) {
  const [cmd, ci] = process.argv.slice(2);
  if (cmd === "features") {
    mkdirSync(`${DATA}t4`, { recursive: true });
    for (const f of ["features.json", "emb-t4fix.f32"]) {
      if (!existsSync(`${RESEARCH_OUT}${f}`)) throw new Error(`missing ${RESEARCH_OUT}${f}; run docs/research/card-space-full/features.ts first`);
      await Bun.write(`${DATA}t4/${f}`, Bun.file(`${RESEARCH_OUT}${f}`));
    }
    console.log(`copied into ${DATA}t4/`);
  } else if (cmd === "build" && ci) {
    const { loadSpace } = await import("./deck-pool");
    const space = await loadSpace();
    const t = performance.now();
    const g = await loadInColor(ci === "C" ? [] : ci.split(""), (id) => space.cards.get(id)?.ci ?? ["?"]);
    const zero = [...g.values()].filter((r) => !r.nb.length).length;
    console.log(`${ciKey(ci === "C" ? [] : ci.split(""))}: ${g.size} cards, ${zero} with no neighbor, ${((performance.now() - t) / 1000).toFixed(1)} s`);
  } else throw new Error("usage: bun app/in-color.ts features | build <CI>");
}
