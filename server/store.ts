// The card store an installed plugin reads. The ~100 MB SQLite file is not in git: each release of the data is a
// gzipped asset on a GitHub Release, named with its checksums in store.json. On first start (and after store.json
// moves to a new data release) the server downloads it into the plugin data folder, checks the download against
// store.json, unpacks it, and only then swaps it into place, so a failed or tampered download never replaces a good
// store. A checkout of the repo (development) reads data/cards.db as it is and downloads nothing.
//
//   bun server/store.ts manifest <cards.db> <url>   prints the store.json entry for a new data release

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH, IN_PLUGIN } from "./paths";

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

/** True when the store at dbPath is the release store.json names (the stamp written after a verified unpack). */
export function storeIsCurrent(manifest: StoreManifest, dbPath = DB_PATH): boolean {
  return existsSync(dbPath) && existsSync(stampPath(dbPath)) && readFileSync(stampPath(dbPath), "utf8").trim() === manifest.dbSha256;
}

/** Download, verify and install the store. Throws, leaving any existing store untouched, when a checksum fails. */
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
  renameSync(tmp, dbPath);
  writeFileSync(stampPath(dbPath), `${manifest.dbSha256}\n`);
}

/** What the server awaits before opening the store: a no-op in a checkout, the first-run download in a plugin. */
export async function ensureStore(dbPath = DB_PATH): Promise<void> {
  if (!IN_PLUGIN || process.env.MTG_DECK_DB) {
    if (!existsSync(dbPath)) throw new Error(`no card store at ${dbPath}`);
    return;
  }
  const manifest = readManifest();
  if (storeIsCurrent(manifest, dbPath)) return;
  rmSync(stampPath(dbPath), { force: true });
  await installStore(manifest, dbPath);
}

if (import.meta.main) {
  const [cmd, dbFile, url] = process.argv.slice(2);
  if (cmd !== "manifest" || !dbFile || !url) {
    console.error("usage: bun server/store.ts manifest <cards.db> <url>");
    process.exit(2);
  }
  const db = new Uint8Array(readFileSync(dbFile));
  const gz = Bun.gzipSync(db, { level: 9 });
  const gzFile = `${dbFile}.gz`;
  writeFileSync(gzFile, gz);
  const entry: StoreManifest = { version: new Date().toISOString().slice(0, 10), url, gzSha256: sha256(gz), dbSha256: sha256(db) };
  console.error(`wrote ${gzFile} (${gz.length} bytes); upload it as the release asset at the url`);
  console.log(JSON.stringify(entry, null, 2));
}
