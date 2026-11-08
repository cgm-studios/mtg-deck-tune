// SKILL.md against what the MCP really offers (ISC-100) and against the label the player sees (ISC-108). The skill's
// `## Tools` section is its declaration of the tools: one bullet per tool, the backticked name first, then what it is for.
import { describe, expect, test } from "bun:test";

const SKILL_FILE = new URL("../plugin/skills/deck-tune/SKILL.md", import.meta.url).pathname;
const MCP_FILE = new URL("./mcp.ts", import.meta.url).pathname;

const skill = await Bun.file(SKILL_FILE).text();
const mcp = await Bun.file(MCP_FILE).text();

function registeredTools(source: string): string[] {
  return [...source.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
}

function toolsSection(doc: string): string {
  const start = doc.search(/^## Tools$/m);
  if (start === -1) return "";
  const rest = doc.slice(start + "## Tools".length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Each tool the skill declares, with the words saying what it is for. */
function declaredTools(doc: string): { name: string; purpose: string }[] {
  return [...toolsSection(doc).matchAll(/^- `([a-z_]+)`: (.+)$/gm)].map((m) => ({ name: m[1], purpose: m[2] }));
}

/** Backticked snake_case words anywhere in the file: only tool names look like that, so each must be a real tool. */
function snakeCaseNames(doc: string): string[] {
  return [...new Set([...doc.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]))].sort();
}

function declarationProblems(doc: string, registered: string[]): string[] {
  const declared = declaredTools(doc);
  const names = declared.map((d) => d.name).sort();
  return [
    ...registered.filter((r) => !names.includes(r)).map((r) => `not declared: ${r}`),
    ...names.filter((n) => !registered.includes(n)).map((n) => `declared but the MCP lacks it: ${n}`),
    ...names.filter((n, i) => names.indexOf(n) !== i).map((n) => `declared twice: ${n}`),
    ...declared.filter((d) => d.purpose.trim().split(/\s+/).length < 3).map((d) => `no stated purpose: ${d.name}`),
    ...snakeCaseNames(doc).filter((n) => !registered.includes(n)).map((n) => `named but the MCP lacks it: ${n}`),
  ];
}

const REGISTERED = registeredTools(mcp);
const decl = (tools: string[]) => `## Tools\n\n${tools.map((t) => `- \`${t}\`: what it is for.`).join("\n")}\n\n## Next\n`;

describe("ISC-100: SKILL.md declares exactly the tools the MCP registers", () => {
  test("the MCP registers the eleven tools this test reads", () => {
    expect(REGISTERED).toEqual([
      "accept_swap", "card", "commander_profile", "deck_stats", "diagnose", "find_cards",
      "neighbors", "reject_swap", "shortlist", "swap_candidates", "tags",
    ]);
  });

  test("every registered tool is declared with its purpose, and nothing else is named as a tool", () => {
    expect(declarationProblems(skill, REGISTERED)).toEqual([]);
  });

  test("red on a missing tool, an invented tool, a bare name and a stray tool name in the prose", () => {
    const tools = ["card", "diagnose"];
    expect(declarationProblems(decl(tools), tools)).toEqual([]);
    expect(declarationProblems(decl(["card"]), tools)).toEqual(["not declared: diagnose"]);
    expect(declarationProblems(decl([...tools, "tune_deck"]), tools)).toEqual(
      expect.arrayContaining(["declared but the MCP lacks it: tune_deck"]),
    );
    expect(declarationProblems("## Tools\n\n- `card`: read.\n- `diagnose`: find problems here.\n", tools)).toEqual(["no stated purpose: card"]);
    expect(declarationProblems(`${decl(tools)}Run \`find_card\` first.\n`, tools)).toEqual(["named but the MCP lacks it: find_card"]);
  });
});

describe("ISC-108: the skill labels judgment 'my read'", () => {
  test("the old label is gone in either apostrophe", () => {
    expect(skill).not.toMatch(/Claude['’]s read/i);
  });

  test("the swap layout carries the My read line", () => {
    expect(skill).toContain("- **My read:**");
  });
});
