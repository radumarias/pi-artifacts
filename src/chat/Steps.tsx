import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { createContext, use, useMemo, useState, type ReactNode } from "react";
import { MCP_DISCOVER_TOOL, MCP_TOOL_SEPARATOR, PUBLISH_TOOL } from "../../shared/protocol.ts";
import { clip } from "../../shared/util.ts";
import { Linkified } from "./Linkified.tsx";
import { Spark } from "./Thinking.tsx";
import { unansweredCalls, type RunningTool } from "./useChat.ts";

/** The finished calls, by call id, and every call some assistant entry made: a result without one shows on its own. */
export interface StepResults {
  results: ReadonlyMap<string, ToolResultMessage>;
  calls: ReadonlySet<string>;
}

/**
 * The calls of the current round, whether a run is on, and the newest assistant entry's calls still without a result
 * (the ones a run has yet to start). Changes with every chunk of tool output.
 */
export interface StepsLive {
  tools: ReadonlyMap<string, RunningTool>;
  busy: boolean;
  unanswered: ReadonlySet<string>;
}

// Two contexts, so a step that has its result never re-renders for another step's output.
const ResultsContext = createContext<StepResults>({ results: new Map(), calls: new Set() });
const LiveContext = createContext<StepsLive>({ tools: new Map(), busy: false, unanswered: new Set() });

export function stepResults(entries: readonly EntryRecord[]): StepResults {
  const results = new Map<string, ToolResultMessage>();
  const calls = new Set<string>();
  for (const entry of entries) {
    const message = entry.model?.[0];
    if (entry.kind === "pi.tool-result" && message?.role === "toolResult") results.set(message.toolCallId, message);
    else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
      for (const block of message.content) if (block?.type === "toolCall") calls.add(block.id);
    }
  }
  return { results, calls };
}

export function stepsLive(tools: readonly RunningTool[], busy: boolean, unanswered: ReadonlySet<string> = new Set()): StepsLive {
  return { tools: new Map(tools.map((tool) => [tool.toolCallId, tool])), busy, unanswered };
}

/** What the step panels read from the chat. */
export function StepsProvider({ entries, tools, busy, children }: { entries: readonly EntryRecord[]; tools: readonly RunningTool[]; busy: boolean; children: ReactNode }) {
  const results = useMemo(() => stepResults(entries), [entries]);
  const unanswered = useMemo(() => unansweredCalls(entries), [entries]);
  const live = useMemo(() => stepsLive(tools, busy, unanswered), [tools, busy, unanswered]);
  return (
    <ResultsContext value={results}>
      <LiveContext value={live}>{children}</LiveContext>
    </ResultsContext>
  );
}

/**
 * Where a call is. `writing`: the model is still streaming its arguments; `starting`: written, not started yet;
 * `stopped`: it ended without a result (stopped, or the tool faulted).
 */
export type StepStatus = "writing" | "starting" | "running" | "done" | "error" | "stopped";

/**
 * Where a call without a result is: its slot in the current round, else what the run says. A call of an earlier
 * round that never got a result (its run was stopped) stays stopped while a later run goes on.
 */
export function liveStatus(live: StepsLive, callId: string, streaming: boolean): StepStatus {
  const slot = live.tools.get(callId)?.status;
  if (slot) return slot === "pending" ? "starting" : slot;
  if (!live.busy) return "stopped";
  if (streaming) return "writing";
  return live.unanswered.has(callId) ? "starting" : "stopped";
}

/** Each status's text and icon (the spark when it has none), and its tone: color, and the shimmer while active. */
const STATUS: Record<StepStatus, { text: string; icon?: string; tone?: "active" | "done" | "error" }> = {
  writing: { text: "Writing…", tone: "active" },
  starting: { text: "Starting…", tone: "active" },
  running: { text: "Running…", tone: "active" },
  done: { text: "Done", icon: "✓", tone: "done" },
  error: { text: "Failed", icon: "✕", tone: "error" },
  stopped: { text: "Stopped", icon: "■" },
};

/** The built-in tools by what they do; an MCP tool reads as its server and tool, anything else by its name. */
const LABELS: Record<string, string> = {
  run_python: "Python",
  run_bash: "Bash",
  [PUBLISH_TOOL]: "Publish artifact",
  artifact_read: "Read artifact",
  artifact_history: "Artifact history",
  artifact_diff: "Compare versions",
  files_list: "List files",
  files_read: "Read file",
  files_write: "Write file",
  skill_propose: "Propose skill",
  [MCP_DISCOVER_TOOL]: "List MCP servers",
};

/** What a call's long text arguments are, where the key alone says less. */
const INPUT_LABELS: Record<string, Record<string, string>> = {
  run_python: { code: "Python" },
  run_bash: { script: "Bash" },
  [PUBLISH_TOOL]: { html: "HTML" },
};

export function stepLabel(name: string): string {
  if (LABELS[name]) return LABELS[name];
  let split = name.indexOf(MCP_TOOL_SEPARATOR);
  if (split <= 0) return name;
  // A server slug can end in "_" ("Reports (beta)" is "reports_beta_"): the separator is the last two of the run.
  while (name[split + MCP_TOOL_SEPARATOR.length] === "_") split++;
  return `${name.slice(0, split)} › ${name.slice(split + MCP_TOOL_SEPARATOR.length)}`;
}

/** Lines that say nothing about what a script does: blank, a shebang, shell options. */
const BOILERPLATE = /^\s*($|#!|set -)/;

/** One line on what the call does: the first telling line of its first text argument, or its arguments in short. */
export function stepHint(args: Record<string, unknown> | undefined): string {
  const values = Object.values(args ?? {});
  const first = values.find((value): value is string => typeof value === "string" && value.trim() !== "");
  if (first !== undefined) {
    // Only the head: this runs on every streamed token, and the argument may be a whole page.
    const lines = first.slice(0, 2_000).split("\n");
    return (lines.find((line) => !BOILERPLATE.test(line)) ?? lines.find((line) => line.trim()) ?? "").trim().slice(0, 200);
  }
  return values.length ? JSON.stringify(args).slice(0, 200) : "";
}

export interface StepSection {
  label: string;
  text: string;
}

/** A call's arguments to show: long or multi-line text (code, a page) each in its own block, then the rest as JSON. */
export function inputSections(name: string, args: Record<string, unknown> | undefined): StepSection[] {
  const sections: StepSection[] = [];
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (typeof value === "string" && (value.includes("\n") || value.length > 120)) sections.push({ label: INPUT_LABELS[name]?.[key] ?? key, text: value });
    else rest[key] = value;
  }
  if (Object.keys(rest).length) sections.push({ label: sections.length ? "Arguments" : "Input", text: JSON.stringify(rest, null, 2) });
  return sections;
}

/** A page or a long output is not worth all the DOM it takes. A tool's result is already cut to what the model saw. */
const MAX_SHOWN = 20_000;

function resultText(result: ToolResultMessage): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

function seconds(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** Panels the reader opened, by key: one stays open when its streaming message becomes an entry and remounts. */
const opened = new Set<string>();

/**
 * One step of the agent, collapsed to a line: an icon, what it is, a hint and where it is. Opened, it shows what the
 * step was given and what came back. The body is only rendered while open, so a long history of steps stays cheap.
 */
function Panel({ openKey, tone, icon, label, hint, status, children }: {
  openKey: string;
  tone?: "active" | "done" | "error";
  icon: ReactNode;
  label: string;
  hint: string;
  status?: string;
  children: () => ReactNode;
}) {
  const [open, setOpen] = useState(() => opened.has(openKey));
  return (
    <details
      className={tone ? `step ${tone}` : "step"}
      open={open}
      onToggle={(event) => {
        const now = event.currentTarget.open;
        if (now) opened.add(openKey);
        else opened.delete(openKey);
        setOpen(now);
      }}
    >
      <summary>
        <span className="step-icon">{icon}</span>
        <span className="step-label">{label}</span>
        {hint && <span className="step-hint">{hint}</span>}
        {status && <span className="step-status">{status}</span>}
        <svg className="step-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 4l4 4-4 4" />
        </svg>
      </summary>
      {open && <div className="step-body">{children()}</div>}
    </details>
  );
}

function Section({ label, text, error }: { label: string; text: string; error?: boolean }) {
  return (
    <div className={error ? "step-section error" : "step-section"}>
      <div className="step-section-label">{label}</div>
      <pre>
        <Linkified text={clip(text, MAX_SHOWN)} />
      </pre>
    </div>
  );
}

/** What a step is made from: a tool call, or for a result whose call is not in the chat, its id and name alone. */
type StepCall = Pick<ToolCall, "id" | "name"> & Partial<Pick<ToolCall, "arguments" | "argumentsError">>;

/** A tool call: code it runs, an MCP call, a publish. `streaming` while the model writes the message it is in. */
export function ToolStep({ call, streaming = false }: { call: StepCall; streaming?: boolean }) {
  const result = use(ResultsContext).results.get(call.id);
  // Read only while the call is unfinished: a finished step does not follow the live output of others.
  const live = result ? undefined : use(LiveContext);
  const status: StepStatus = result ? (result.isError ? "error" : "done") : liveStatus(live!, call.id, streaming);
  const { text, icon, tone } = STATUS[status];
  const time = result?.durationMs !== undefined ? ` · ${seconds(result.durationMs)}` : "";
  return (
    <Panel openKey={call.id} tone={tone} icon={icon ?? <Spark />} label={stepLabel(call.name)} hint={stepHint(call.arguments)} status={text + time}>
      {() => {
        const output = result ? resultText(result) : live!.tools.get(call.id)?.output;
        return (
          <>
            {inputSections(call.name, call.arguments).map((section, i) => (
              <Section key={i} {...section} />
            ))}
            {call.argumentsError && <Section label="Invalid arguments" text={call.argumentsError} error />}
            {output ? (
              <Section label={status === "error" ? "Error" : "Output"} text={output} error={status === "error"} />
            ) : (
              status === "stopped" && <p className="step-note">Stopped before it finished.</p>
            )}
          </>
        );
      }}
    </Panel>
  );
}

/** A result whose call no assistant entry holds: shown on its own, with what came back. Nothing when its call shows it. */
export function OrphanResult({ message }: { message: ToolResultMessage }) {
  return use(ResultsContext).calls.has(message.toolCallId) ? null : <ToolStep call={{ id: message.toolCallId, name: message.toolName }} />;
}

/** What the model thought before answering, when the provider sends it. `openKey` stays the same once the message lands. */
export function ThoughtStep({ openKey, text }: { openKey: string; text: string }) {
  return (
    <Panel openKey={openKey} icon="✻" label="Thought process" hint={stepHint({ text })}>
      {() => <div className="step-thought">{text.trim()}</div>}
    </Panel>
  );
}
