// Builds the plugin's server: one bundled file (the MCP SDK and zod inlined, bun:sqlite left to the runtime) plus the
// JSON files it reads beside it, so an installed plugin needs Bun and nothing else, with no `bun install` step.
//   bun run build   → plugin/dist/ (mcp.js, roles.json, role-targets.json, store.json)
import { copyFileSync, mkdirSync, rmSync } from "node:fs";

rmSync("plugin/dist", { recursive: true, force: true });
mkdirSync("plugin/dist");
const out = await Bun.build({ entrypoints: ["server/mcp.ts"], outdir: "plugin/dist", target: "bun", minify: false });
if (!out.success) {
  for (const log of out.logs) console.error(log);
  process.exit(1);
}
for (const f of ["roles.json", "role-targets.json", "store.json"]) copyFileSync(`server/${f}`, `plugin/dist/${f}`);
console.log(`built plugin/dist/mcp.js (${out.outputs[0].size} bytes)`);
