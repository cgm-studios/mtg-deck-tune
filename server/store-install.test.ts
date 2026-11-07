// The first-run download (store.ts) against store schemas. Seam: installStore and checkStoreSchema over small SQLite
// files made here, served through a stand-in fetch. A store older than the schema this server reads (schema 1 has no
// graph or commander tables) must be refused with a message that says so, and must never replace a good store.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStoreSchema, installStore, STORE_SCHEMA, type StoreManifest } from "./store";

const dir = mkdtempSync(join(tmpdir(), "store-install-"));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function makeStore(name: string, schema: string | null): Uint8Array {
  const path = join(dir, name);
  const db = new Database(path, { create: true });
  db.exec("CREATE TABLE cards (id INTEGER PRIMARY KEY)");
  if (schema !== null) { db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); db.query("INSERT INTO meta VALUES ('schema', ?)").run(schema); }
  db.close();
  return new Uint8Array(readFileSync(path));
}

function release(db: Uint8Array): { manifest: StoreManifest; fetchImpl: typeof fetch } {
  const gz = Bun.gzipSync(db);
  const manifest = { version: "test", url: "http://release.invalid/cards.db.gz", gzSha256: sha(gz), dbSha256: sha(db) };
  return { manifest, fetchImpl: (async () => new Response(gz)) as unknown as typeof fetch };
}

test("store schema: this server reads schema 2, the store with the card graph and commander data", () => {
  expect(STORE_SCHEMA).toBe(2);
});

test("store schema: a schema 2 store passes; schema 1, a store with no schema, and a newer schema each fail naming what was found", () => {
  makeStore("s2.db", "2");
  makeStore("s1.db", "1");
  makeStore("none.db", null);
  makeStore("s3.db", "3");
  expect(() => checkStoreSchema(join(dir, "s2.db"))).not.toThrow();
  expect(() => checkStoreSchema(join(dir, "s1.db"))).toThrow(/schema 1.*needs schema 2/);
  expect(() => checkStoreSchema(join(dir, "none.db"))).toThrow(/no schema.*needs schema 2/);
  expect(() => checkStoreSchema(join(dir, "s3.db"))).toThrow(/schema 3.*needs schema 2/);
});

test("first-run download: a release of the current schema installs with its checksum stamp", async () => {
  const db = makeStore("good.db", "2");
  const { manifest, fetchImpl } = release(db);
  const target = join(dir, "plugin-a", "cards.db");
  await installStore(manifest, target, fetchImpl);
  expect(sha(new Uint8Array(readFileSync(target)))).toBe(manifest.dbSha256);
  expect(readFileSync(`${target}.sha256`, "utf8").trim()).toBe(manifest.dbSha256);
});

test("first-run download: a verified release of an older schema is refused and the store already there stays", async () => {
  const good = makeStore("keep.db", "2");
  const target = join(dir, "plugin-b", "cards.db");
  const first = release(good);
  await installStore(first.manifest, target, first.fetchImpl);
  const old = release(makeStore("old.db", "1"));
  await expect(installStore(old.manifest, target, old.fetchImpl)).rejects.toThrow(/schema 1.*needs schema 2/);
  expect(sha(new Uint8Array(readFileSync(target)))).toBe(first.manifest.dbSha256);
  expect(readFileSync(`${target}.sha256`, "utf8").trim()).toBe(first.manifest.dbSha256);
  expect(existsSync(`${target}.download`)).toBe(false);
});
