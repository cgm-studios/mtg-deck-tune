// End-to-end check of the installed-plugin path, run before every release (needs data/cards.db.gz from
// `bun server/store.ts manifest`). It starts the bundled server (plugin/dist/mcp.js) the way Claude Code starts a plugin
// server: a fresh CLAUDE_PLUGIN_DATA folder, a separate project folder, and the card data served from a local stand-in
// for the GitHub Release. It proves: the server answers before the download ends, the first-run download installs a
// verified store, relative deck paths resolve against the project, verdict labels land in the plugin data folder, and
// the installed store carries the card graph and commander data (schema 2), and a download that fails its checksum
// leaves no store and says so.
//   bun scripts/plugin-smoke.ts <cards.db.gz>
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gzFile = process.argv[2];
if (!gzFile || !existsSync(gzFile)) throw new Error("usage: bun scripts/plugin-smoke.ts <cards.db.gz>");
const real = JSON.parse(readFileSync("plugin/dist/store.json", "utf8"));
const asset = Bun.file(gzFile);
const server = Bun.serve({ port: 0, fetch: () => new Response(asset) });
const url = `http://127.0.0.1:${server.port}/cards.db.gz`;
let failures = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures++; };

async function run(manifest: object, seedStoreFrom?: string) {
  const root = mkdtempSync(join(tmpdir(), "deck-tune-smoke-"));
  const data = join(root, "plugin-data"), project = join(root, "project"), manifestFile = join(root, "store.json");
  Bun.spawnSync(["mkdir", "-p", data, join(project, "decks")]);
  copyFileSync("fixtures/namor.txt", join(project, "decks", "namor.txt"));
  writeFileSync(manifestFile, JSON.stringify(manifest));
  if (seedStoreFrom) for (const f of ["cards.db", "cards.db.sha256"]) copyFileSync(join(seedStoreFrom, f), join(data, f));
  const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: project, MTG_DECK_STORE_MANIFEST: manifestFile };
  const client = new Client({ name: "smoke", version: "0" });
  const t0 = performance.now();
  await client.connect(new StdioClientTransport({ command: "bun", args: [join(process.cwd(), "plugin/dist/mcp.js")], env, cwd: project, stderr: "pipe" }));
  const connectMs = performance.now() - t0;
  const call = (name: string, args: object) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: { text: string }[]; structuredContent?: any }>;
  return { root, data, project, client, call, connectMs };
}

// 1. A good release: the server answers at once, the download installs, the tools work against the project.
const good = await run({ ...real, url });
check(good.connectMs < 5000, `server answers before the download (connected in ${Math.round(good.connectMs)} ms)`);
const tools = (await good.client.listTools()).tools.map((t) => t.name).sort();
check(tools.length === 11, `11 tools listed (${tools.join(", ")})`);
const stats = await good.call("deck_stats", { commander: "Namor the Sub-Mariner", deckFile: "decks/namor.txt" });
check(!stats.isError && stats.structuredContent?.cards === 100, `deck_stats on a project-relative deck path: ${stats.isError ? stats.content[0].text : `${stats.structuredContent.cards} cards, avg MV ${stats.structuredContent.averageManaValue}`}`);
const profile = await good.call("commander_profile", { commander: "Namor the Sub-Mariner", deckFile: "decks/namor.txt" });
check(!profile.isError && profile.structuredContent?.decks === 4772 && profile.structuredContent?.deckMatch?.themes?.length > 0, `commander_profile on Namor with the deck: ${profile.isError ? profile.content[0].text : `${profile.structuredContent.themes[0].theme} first, deck matches ${profile.structuredContent.deckMatch.strongest} best`}`);
check(existsSync(join(good.data, "cards.db")) && readFileSync(join(good.data, "cards.db.sha256"), "utf8").trim() === real.dbSha256, "store installed in the plugin data folder with its checksum stamp");
{
  // the installed store carries the card graph and the commander data (store schema 2), not only the card rows
  const db = new Database(join(good.data, "cards.db"), { readonly: true });
  const count = (t: string) => (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  const schema = (db.query("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | null)?.value;
  const tables = ["card_graph", "card_graph_hooks", "graph_untranslated", "card_scryfall", "subtype_facts", "commanders", "themes", "commander_themes", "commander_cards", "card_tagger"];
  const counts = tables.map((t) => [t, count(t)] as const);
  check(schema === "2" && counts.every(([, n]) => n > 0), `installed store is schema ${schema} with ${counts.map(([t, n]) => `${t} ${n}`).join(", ")}`);
  db.close();
}
const rej = await good.call("reject_swap", { commander: "Namor the Sub-Mariner", deckFile: "decks/namor.txt", out: "Mist Dancer", in: "Levitation", lever: "plan", note: "smoke test" });
check(!rej.isError && existsSync(join(good.data, "labels", "swap-verdicts.jsonl")), "reject_swap logs its label in the plugin data folder");
const acc = await good.call("accept_swap", { commander: "Namor the Sub-Mariner", deckFile: "decks/namor.txt", out: "Mist Dancer", in: "Levitation", lever: "plan" });
const deckLines = readFileSync(join(good.project, "decks", "namor.txt"), "utf8").split("\n").map((l) => l.trim());
check(!acc.isError && deckLines.includes("1 Levitation") && !deckLines.includes("1 Mist Dancer") && deckLines.some((l) => l.startsWith("#") && l.includes("+1 Levitation")),
  `accept_swap rewrites the deck file in the project folder${acc.isError ? ": " + acc.content[0].text : ""}`);
await good.client.close();

// 2. A later start reuses the verified store and downloads nothing: the release URL is dead and the tools still work.
const reuse = await run({ ...real, url: "http://127.0.0.1:9/never" }, good.data);
const reuseCall = await reuse.call("card", { name: "Sol Ring" });
check(!reuseCall.isError, "a later start reuses the store without downloading");
await reuse.client.close();

// 3. A tampered download: the checksum fails, nothing is installed, and the tool says why.
const bad = await run({ ...real, url, gzSha256: "0".repeat(64) });
const badCall = await bad.call("card", { name: "Sol Ring" });
check(!!badCall.isError && badCall.content[0].text.includes("checksum"), `checksum failure is reported: "${badCall.content[0].text}"`);
check(!existsSync(join(bad.data, "cards.db")), "no store installed after a failed checksum");
await bad.client.close();

server.stop(true);
console.log(failures ? `${failures} FAILED` : "all smoke checks passed");
process.exit(failures ? 1 : 0);
