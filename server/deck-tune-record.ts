// MV-17: records a deck-tune session against the real mtg-deck MCP. A nested `claude` session cannot run here, so an
// agent plays the skill turn by turn: it writes each user and assistant turn with this tool, and every tool call goes
// through a real MCP client over stdio (the server command `.mcp.json` gives), logged with its full result.
//
//   bun server/deck-tune-record.ts init <session.jsonl> --title <t> --note <n> --played-by <model> [--real]
//   bun server/deck-tune-record.ts user <session.jsonl>            (turn text on stdin)
//   bun server/deck-tune-record.ts assistant <session.jsonl>       (turn text on stdin)
//   bun server/deck-tune-record.ts read <session.jsonl> <path>     (a file the skill reads, relative to the repo root)
//   bun server/deck-tune-record.ts call <session.jsonl> <tool> <json-arguments>
//   bun server/deck-tune-record.ts render <session.jsonl> <out.md>
//
// Each call starts the server, connects, checks the tool is listed, calls it and closes: the tools are deterministic,
// so a fresh server per call gives the same answer a long-lived one would.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { readTranscript, renderTranscript, type ToolEvent, type TranscriptEvent, type TranscriptHeader } from "./deck-tune-transcript";

const ROOT = new URL("../", import.meta.url).pathname;
const SERVER = "mtg-deck";
const CALL_TIMEOUT_MS = 120_000; // a first swap_candidates call builds the in-color lists (1 to 2.5 s); generous on purpose

class UsageError extends Error {}

function append(session: string, row: TranscriptHeader | TranscriptEvent): void {
  if (row.kind !== "header" && !existsSync(session)) throw new UsageError(`${session} has no header; run init first`);
  appendFileSync(session, JSON.stringify(row) + "\n");
}

async function stdinText(): Promise<string> {
  const text = (await new Response(Bun.stdin.stream()).text()).trim();
  if (!text) throw new UsageError("the turn text on stdin is empty");
  return text;
}

type ServerConfig = { command: string; args: string[]; env?: Record<string, string> };

function serverConfig(): ServerConfig {
  const raw = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8")) as { mcpServers?: Record<string, Partial<ServerConfig>> };
  const cfg = raw.mcpServers?.[SERVER];
  if (!cfg || typeof cfg.command !== "string" || !Array.isArray(cfg.args)) throw new Error(`.mcp.json has no usable ${SERVER} server entry`);
  return { command: cfg.command, args: cfg.args, env: cfg.env };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolEvent> {
  const cfg = serverConfig();
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
  const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args, cwd: ROOT, env: { ...env, ...cfg.env }, stderr: "inherit" });
  const client = new Client({ name: "deck-tune-recorder", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    if (!tools.some((t) => t.name === name)) throw new UsageError(`${SERVER} has no tool ${name}; it lists ${tools.map((t) => t.name).join(", ")}`);
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
    const isError = res.isError === true;
    const content = Array.isArray(res.content) ? res.content : [];
    const text = content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("\n");
    const result = isError ? text : (res.structuredContent ?? JSON.parse(text));
    return { kind: "tool", server: SERVER, name, input: args, result, isError };
  } finally {
    await client.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const [cmd, session, ...rest] = argv;
  if (!cmd || !session) throw new UsageError("usage: deck-tune-record.ts <init|user|assistant|read|call|render> <session.jsonl> ...");
  switch (cmd) {
    case "init": {
      if (existsSync(session)) throw new UsageError(`${session} already exists`);
      const { values } = parseArgs({ args: rest, options: { title: { type: "string" }, note: { type: "string" }, "played-by": { type: "string" }, real: { type: "boolean" } } });
      if (!values.title || !values.note || !values["played-by"]) throw new UsageError("init needs --title, --note and --played-by");
      append(session, {
        kind: "header", agentPlayed: !values.real, playedBy: values["played-by"], skill: "plugin/skills/deck-tune/SKILL.md",
        title: values.title, note: values.note, recordedAt: new Date().toISOString(),
      });
      return;
    }
    case "user":
    case "assistant":
      append(session, { kind: cmd, text: await stdinText() });
      return;
    case "read": {
      const [path] = rest;
      if (!path) throw new UsageError("read needs a path");
      const abs = isAbsolute(path) ? path : join(ROOT, path);
      const content = readFileSync(abs, "utf8");
      append(session, { kind: "read", path: isAbsolute(path) ? relative(ROOT, abs) : path, content });
      process.stdout.write(content);
      return;
    }
    case "call": {
      const [name, json] = rest;
      if (!name || !json) throw new UsageError("call needs a tool name and JSON arguments");
      const args = JSON.parse(json) as unknown;
      if (typeof args !== "object" || args === null || Array.isArray(args)) throw new UsageError("tool arguments must be a JSON object");
      const event = await callTool(name, args as Record<string, unknown>);
      append(session, event);
      process.stdout.write(event.isError ? `ERROR: ${String(event.result)}\n` : JSON.stringify(event.result, null, 1) + "\n");
      return;
    }
    case "render": {
      const [out] = rest;
      if (!out) throw new UsageError("render needs an output path");
      writeFileSync(out, renderTranscript(readTranscript(session)));
      return;
    }
    default:
      throw new UsageError(`unknown command ${cmd}`);
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(e instanceof UsageError ? 64 : 1);
  });
}
