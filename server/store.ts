// The card store an installed plugin reads. The SQLite file is not in git: each release of the data is a gzipped asset
// on a GitHub Release, named with its checksums in store.json. On first start (and after store.json moves to a new data
// release) the server downloads it into the plugin data folder, checks the download against store.json, unpacks it,
// checks it is the store schema this server reads, and only then swaps it into place, so a failed, tampered or
// out-of-date download never replaces a good store. A checkout of the repo (development) reads data/cards.db as it is
// and downloads nothing, but is held to the same schema.
//
// Schema 2 (DT-6.1; built by mtg-vector's app/build-db.ts) adds to the card rows, tags and Card Space neighbors:
//   card_graph (card_id, forge_file, abilities JSON, unmapped JSON)   what each card makes happen and listens for, as
//                                                                    the card graph's corpus has it (no Forge source line)
//   card_graph_hooks (card_id, relation, hook)                        the same relations as plain rows, indexed by hook
//   graph_untranslated (card_id)                                      commander-legal cards with no Forge script
//   card_scryfall (card_id, colors, card_faces, edhrec_rank)          Scryfall fields the graph's link rule reads
//   subtype_facts (subtype, creature_only, land_only)                 the graph's subtype facts over every Scryfall card
//   commanders (card_id, edhrec_slug, decks, tagger_deck, tagger_deck_fallback)
//   themes (id, slug, name), commander_themes (commander_id, theme_id, decks)   EDHREC Themes with deck counts
//   commander_cards (commander_id, card_id, decks, potential_decks, synergy)   the commander page's synergy list
//   card_tagger (card_id, vector)                                     each card's Tagger Card vector
// Tagger vectors are packed: n float32 weights then the n uint16 tag ids (tags.id), little-endian, strongest first.
// meta carries schema, graph_mapping_version and the counts the build wrote.
//
//   bun server/store.ts manifest <cards.db> <url>   prints the store.json entry for a new data release

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH, IN_PLUGIN } from "./paths";

/** The store schema this server reads. */
export const STORE_SCHEMA = 2;

export type StoreManifest = {
  version: string; // the data release, e.g. "2026-11-06"
  url: string; // the gzipped cards.db asset
  gzSha256: string; // of the downloaded .gz bytes
  dbSha256: string; // of the unpacked cards.db
};

const MANIFEST_PATH = process.env.MTG_DECK_STORE_MANIFEST ?? new URL("./store.json", import.meta.url).pathname;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const stampPath = (dbPath: string) => `${dbPath}.sha256`;

export function readManifest(path = MANIFEST_PATH): StoreManifest {
  const m = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreManifest>;
  for (const k of ["version", "url", "gzSha256", "dbSha256"] as const) {
    if (typeof m[k] !== "string" || !m[k]) throw new Error(`${path}: missing "${k}"`);
  }
  return m as StoreManifest;
}

/** Throws unless the store at dbPath is the schema this server reads, saying what it found. */
export function checkStoreSchema(dbPath: string): void {
  const db = new Database(dbPath, { readonly: true });
  let found: string | null;
  try {
    const hasMeta = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    found = hasMeta ? ((db.query("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | null)?.value ?? null) : null;
  } finally {
    db.close();
  }
  if (found !== String(STORE_SCHEMA)) {
    throw new Error(`card data at ${dbPath} is ${found === null ? "a store with no schema" : `store schema ${found}`}; this server needs schema ${STORE_SCHEMA}` +
      (IN_PLUGIN ? "" : " (rebuild it with mtg-vector's app/build-db.ts)"));
  }
}

/** True when the store at dbPath is the release store.json names (the stamp written after a verified unpack). */
export function storeIsCurrent(manifest: StoreManifest, dbPath = DB_PATH): boolean {
  return existsSync(dbPath) && existsSync(stampPath(dbPath)) && readFileSync(stampPath(dbPath), "utf8").trim() === manifest.dbSha256;
}

/** Download, verify and install the store. Throws, leaving any existing store untouched, when a check fails. */
export async function installStore(manifest: StoreManifest, dbPath = DB_PATH, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(manifest.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`card data download failed: HTTP ${res.status} from ${manifest.url}`);
  const gz = new Uint8Array(await res.arrayBuffer());
  if (sha256(gz) !== manifest.gzSha256) throw new Error(`card data download failed its checksum (${manifest.url})`);
  const db = Bun.gunzipSync(gz);
  if (sha256(db) !== manifest.dbSha256) throw new Error("card data unpacked to the wrong checksum");
  mkdirSync(dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.download`;
  writeFileSync(tmp, db);
  try {
    checkStoreSchema(tmp);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  renameSync(tmp, dbPath);
  writeFileSync(stampPath(dbPath), `${manifest.dbSha256}\n`);
}

/** What the server awaits before opening the store: a schema check in a checkout, the first-run download in a plugin. */
export async function ensureStore(dbPath = DB_PATH): Promise<void> {
  if (!IN_PLUGIN || process.env.MTG_DECK_DB) {
    if (!existsSync(dbPath)) throw new Error(`no card store at ${dbPath}`);
    checkStoreSchema(dbPath);
    return;
  }
  const manifest = readManifest();
  if (storeIsCurrent(manifest, dbPath)) return checkStoreSchema(dbPath);
  rmSync(stampPath(dbPath), { force: true });
  await installStore(manifest, dbPath);
}

if (import.meta.main) {
  const [cmd, dbFile, url] = process.argv.slice(2);
  if (cmd !== "manifest" || !dbFile || !url) {
    console.error("usage: bun server/store.ts manifest <cards.db> <url>");
    process.exit(2);
  }
  checkStoreSchema(dbFile);
  const db = new Uint8Array(readFileSync(dbFile));
  const gz = Bun.gzipSync(db, { level: 9 });
  const gzFile = `${dbFile}.gz`;
  writeFileSync(gzFile, gz);
  const entry: StoreManifest = { version: new Date().toISOString().slice(0, 10), url, gzSha256: sha256(gz), dbSha256: sha256(db) };
  console.error(`wrote ${gzFile} (${gz.length} bytes); upload it as the release asset at the url`);
  console.log(JSON.stringify(entry, null, 2));
}
