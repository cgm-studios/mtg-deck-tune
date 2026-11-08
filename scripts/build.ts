// Builds the plugin's server: one bundled file (the MCP SDK and zod inlined, bun:sqlite left to the runtime) plus the
// JSON files it reads beside it, so an installed plugin needs Bun and nothing else, with no `bun install` step.
//   bun run build   → plugin/dist/ (mcp.js, roles.json, role-targets.json, store.json) and plugin/THIRD-PARTY-NOTICES.md
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The bundler drops the inlined packages' copyright comments, and their licenses require the notices to travel with the code.
function writeNotices(inputs: string[]): void {
  const names = new Set<string>();
  for (const path of inputs) {
    const m = path.match(/(?:.*\/)?node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (m) names.add(m[1]);
  }
  const sections = [...names].sort().map((name) => {
    const dir = join("node_modules", name);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string; license: string };
    const file = readdirSync(dir).find((f) => /^licen[sc]e/i.test(f));
    if (!file) throw new Error(`${name} ships no license file, so its notice cannot be reproduced`);
    return `## ${name}@${pkg.version} (${pkg.license})\n\n\`\`\`text\n${readFileSync(join(dir, file), "utf8").trim()}\n\`\`\`\n`;
  });
  writeFileSync("plugin/THIRD-PARTY-NOTICES.md", `# Third-party notices\n\n\`dist/mcp.js\` includes the packages below, each under its own license.\n\n${sections.join("\n")}`);
}

rmSync("plugin/dist", { recursive: true, force: true });
mkdirSync("plugin/dist");
const out = await Bun.build({ entrypoints: ["server/mcp.ts"], outdir: "plugin/dist", target: "bun", minify: false, metafile: true });
if (!out.success) {
  for (const log of out.logs) console.error(log);
  process.exit(1);
}
for (const f of ["roles.json", "role-targets.json", "store.json"]) copyFileSync(`server/${f}`, `plugin/dist/${f}`);
writeNotices(Object.keys(out.metafile!.inputs));
console.log(`built plugin/dist/mcp.js (${out.outputs[0].size} bytes)`);
