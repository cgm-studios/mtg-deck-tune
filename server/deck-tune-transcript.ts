// MV-17: a recorded deck-tune session as data. A transcript is a JSONL file: one header line, then every user turn,
// assistant turn, file read and mtg-deck tool call in the order they happened, each tool call with its full result.
// The recorder (deck-tune-record.ts) writes them, the code checks (deck-tune-checks.ts) and the Assay judge stage
// (deck-tune-eval.ts) read them, and renderTranscript turns one into the markdown a person or a judge reads.

import { readFileSync } from "node:fs";

export type TranscriptHeader = {
  kind: "header";
  /** True when an agent played both the skill and a scripted player; false only for a real player session. */
  agentPlayed: boolean;
  playedBy: string; // the model or person who wrote the assistant turns
  skill: string; // path of the SKILL.md the assistant turns follow, relative to the repo root
  title: string;
  note: string;
  recordedAt: string; // ISO date-time of the first event
};

export type UserTurn = { kind: "user"; text: string };
export type AssistantTurn = { kind: "assistant"; text: string };
export type ReadEvent = { kind: "read"; path: string; content: string };
export type ToolEvent = {
  kind: "tool";
  server: string;
  name: string;
  input: Record<string, unknown>;
  result: unknown; // the tool's structured content, or its error text when isError
  isError: boolean;
};
export type TranscriptEvent = UserTurn | AssistantTurn | ReadEvent | ToolEvent;
export type Transcript = { header: TranscriptHeader; events: TranscriptEvent[] };

export class TranscriptError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";

function parseHeader(v: unknown, where: string): TranscriptHeader {
  if (!isRecord(v) || v.kind !== "header") throw new TranscriptError(`${where}: the first line must be a header object`);
  for (const key of ["playedBy", "skill", "title", "note", "recordedAt"] as const) {
    if (!isString(v[key]) || !v[key]) throw new TranscriptError(`${where}: header.${key} must be a non-empty string`);
  }
  if (typeof v.agentPlayed !== "boolean") throw new TranscriptError(`${where}: header.agentPlayed must be a boolean`);
  return v as TranscriptHeader;
}

function parseEvent(v: unknown, where: string): TranscriptEvent {
  if (!isRecord(v)) throw new TranscriptError(`${where}: each line must be a JSON object`);
  switch (v.kind) {
    case "user":
    case "assistant":
      if (!isString(v.text)) throw new TranscriptError(`${where}: a ${v.kind} turn needs text`);
      return { kind: v.kind, text: v.text };
    case "read":
      if (!isString(v.path) || !isString(v.content)) throw new TranscriptError(`${where}: a read needs path and content`);
      return { kind: "read", path: v.path, content: v.content };
    case "tool":
      if (!isString(v.server) || !isString(v.name) || !isRecord(v.input) || typeof v.isError !== "boolean" || !("result" in v)) {
        throw new TranscriptError(`${where}: a tool event needs server, name, input, result and isError`);
      }
      return { kind: "tool", server: v.server, name: v.name, input: v.input, result: v.result, isError: v.isError };
    default:
      throw new TranscriptError(`${where}: unknown event kind ${JSON.stringify(v.kind)}`);
  }
}

export function parseTranscript(text: string, source = "transcript"): Transcript {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new TranscriptError(`${source}: empty transcript`);
  const rows = lines.map((l, i) => {
    try {
      return JSON.parse(l) as unknown;
    } catch (e) {
      throw new TranscriptError(`${source}:${i + 1}: not JSON (${e instanceof Error ? e.message : String(e)})`);
    }
  });
  const header = parseHeader(rows[0], `${source}:1`);
  return { header, events: rows.slice(1).map((r, i) => parseEvent(r, `${source}:${i + 2}`)) };
}

export function readTranscript(path: string): Transcript {
  return parseTranscript(readFileSync(path, "utf8"), path);
}

export function serializeTranscript(t: Transcript): string {
  return [t.header, ...t.events].map((r) => JSON.stringify(r)).join("\n") + "\n";
}

// ---------- rendering ----------

const RESULT_CHARS = 6000; // a tool result longer than this is cut in the render (the JSONL keeps it whole)

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n... (${s.length - max} more characters in the JSONL)`;
}

/** A swap_candidates result shown as its candidate lines (reason and the deck delta), the way the skill reads it. */
function renderSwapResult(result: Record<string, unknown>): string {
  const lines: string[] = [];
  const before = result.before as Record<string, unknown> | undefined;
  if (before) lines.push(`before: ${JSON.stringify(before)}`);
  if (Array.isArray(result.roles)) lines.push(`roles: ${JSON.stringify(result.roles)}`);
  const cands = Array.isArray(result.candidates) ? result.candidates : [];
  cands.forEach((c, i) => {
    if (!isRecord(c)) return;
    const name = (side: unknown) => (isRecord(side) && isString(side.name) ? `${side.name} (MV ${side.manaValue})` : "none");
    // under target is the alarm; a drop that stays at target is shown plainly. Sessions recorded before belowTarget
    // existed have no such field and keep their old "DROPS ROLE" mark.
    const flag = c.belowTarget === true ? " | UNDER TARGET"
      : !c.dropsRole ? ""
      : c.belowTarget === false ? " | drops a role, still at or above target" : " | DROPS ROLE";
    lines.push(`${i + 1}. out ${name(c.out)} | in ${name(c.in)} | ${String(c.reason)} | delta ${JSON.stringify(c.delta)}${flag}`);
  });
  if (Array.isArray(result.notes) && result.notes.length) lines.push(`notes: ${JSON.stringify(result.notes)}`);
  return lines.join("\n");
}

export function renderEvent(e: TranscriptEvent): string {
  switch (e.kind) {
    case "user":
      return `### Player\n\n${e.text}`;
    case "assistant":
      return `### Claude\n\n${e.text}`;
    case "read":
      return `### Read \`${e.path}\`\n\n\`\`\`\n${clip(e.content, RESULT_CHARS)}\n\`\`\``;
    case "tool": {
      const body = e.isError
        ? `ERROR: ${String(e.result)}`
        : e.name === "swap_candidates" && isRecord(e.result)
          ? renderSwapResult(e.result)
          : clip(JSON.stringify(e.result), RESULT_CHARS);
      return `### Tool \`${e.server}.${e.name}\`\n\ninput: \`${JSON.stringify(e.input)}\`\n\n\`\`\`\n${body}\n\`\`\``;
    }
  }
}

export function renderTranscript(t: Transcript): string {
  const h = t.header;
  const banner = h.agentPlayed
    ? `> AGENT-PLAYED, not a real player session. ${h.playedBy} wrote every assistant turn by following \`${h.skill}\`, and the "Player" turns are scripted stand-ins. Every tool call and result is real: recorded from the mtg-deck MCP over stdio.`
    : `> A real player session. Assistant turns by ${h.playedBy}, following \`${h.skill}\`.`;
  return [`# ${h.title}`, banner, `${h.note}\n\nRecorded ${h.recordedAt}.`, ...t.events.map(renderEvent)].join("\n\n") + "\n";
}
