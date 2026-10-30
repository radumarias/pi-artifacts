import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Linkified } from "./Linkified.tsx";
import { Spark } from "./Thinking.tsx";
import type { RunningTool } from "./useChat.ts";

/** What the step panels read from the chat. Built once per change to the entries or the running tools, not per token. */
export interface StepsView {
  /** Each finished call's result, by call id. */
  results: ReadonlyMap<string, ToolResultMessage>;
  /** Every call some assistant entry made: a result without one shows on its own. */
  calls: ReadonlySet<string>;
  running: ReadonlyMap<string, RunningTool>;
  busy: boolean;
  /** Panels the reader opened, so one stays open when its streaming message becomes an entry and remounts. */
  opened: Set<string>;
}

export const StepsContext = createContext<StepsView>({ results: new Map(), calls: new Set(), running: new Map(), busy: false, opened: new Set() });

export function stepsView(entries: readonly EntryRecord[], tools: readonly RunningTool[], busy: boolean, opened: Set<string>): StepsView {
  const results = new Map<string, ToolResultMessage>();
  const calls = new Set<string>();
  for (const entry of entries) {
    const message = entry.model?.[0];
    if (entry.kind === "pi.tool-result" && message?.role === "toolResult") results.set(message.toolCallId, message);
    else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
      for (const block of message.content) if (block?.type === "toolCall") calls.add(block.id);
    }
  }
  return { results, calls, running: new Map(tools.map((tool) => [tool.toolCallId, tool])), busy, opened };
}

/**
 * Where a call is. `writing`: the model is still streaming its arguments; `starting`: written, not started yet;
 * `stopped`: the run ended without a result (stopped, or the tool faulted).
 */
export type StepStatus = "writing" | "starting" | "running" | "done" | "error" | "stopped";

export function stepStatus(view: StepsView, callId: string, streaming: boolean): StepStatus {
  const result = view.results.get(callId);
  if (result) return result.isError ? "error" : "done";
  if (view.running.has(callId)) return "running";
  if (!view.busy) return "stopped";
  return streaming ? "writing" : "starting";
}

const STATUS: Record<StepStatus, string> = {
  writing: "Writing…",
  starting: "Starting…",
  running: "Running…",
  done: "Done",
  error: "Failed",
  stopped: "Stopped",
};

const ACTIVE = new Set<StepStatus>(["writing", "starting", "running"]);

/** The built-in tools by what they do; an MCP tool reads as its server and tool, anything else by its name. */
const LABELS: Record<string, string> = {
  run_python: "Python",
  run_bash: "Bash",
  artifact_publish: "Publish artifact",
  artifact_read: "Read artifact",
  artifact_history: "Artifact history",
  artifact_diff: "Compare versions",
  files_list: "List files",
  files_read: "Read file",
  files_write: "Write file",
  skill_propose: "Propose skill",
  mcp_discover: "List MCP servers",
};

/** What a call's long text arguments are, where the key alone says less. */
const INPUT_LABELS: Record<string, Record<string, string>> = {
  run_python: { code: "Python" },
  run_bash: { script: "Bash" },
  artifact_publish: { html: "HTML" },
};

export function stepLabel(name: string): string {
  if (LABELS[name]) return LABELS[name];
  // An MCP tool's agent name is the server's slug and the tool's name (worker/agent/mcp.ts).
  const split = name.indexOf("__");
  return split > 0 ? `${name.slice(0, split)} › ${name.slice(split + 2)}` : name;
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

/** Most of a page or a long output is not worth the DOM it takes; the model saw at most 16 000 characters anyway. */
const MAX_SHOWN = 20_000;

function clipped(text: string): string {
  return text.length <= MAX_SHOWN ? text : `${text.slice(0, MAX_SHOWN)}\n… ${text.length - MAX_SHOWN} more characters`;
}

function resultText(result: ToolResultMessage): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

function seconds(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/**
 * One step of the agent, collapsed to a line: an icon, what it is, a hint and where it is. Opened, it shows what the
 * step was given and what came back. The body is only rendered while open, so a long history of steps stays cheap.
 */
function Panel({ id, tone, icon, label, hint, status, children }: {
  id?: string;
  /** Colors the icon and status, and makes an active status shimmer like the thinking indicator. */
  tone?: "active" | "done" | "error" | "stopped";
  icon: ReactNode;
  label: string;
  hint?: string;
  status?: string;
  children: () => ReactNode;
}) {
  const view = useContext(StepsContext);
  const [open, setOpen] = useState(() => id !== undefined && view.opened.has(id));
  return (
    <details
      className={tone ? `step ${tone}` : "step"}
      open={open}
      onToggle={(event) => {
        const now = event.currentTarget.open;
        if (id !== undefined) {
          if (now) view.opened.add(id);
          else view.opened.delete(id);
        }
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
        <Linkified text={clipped(text)} />
      </pre>
    </div>
  );
}

const ICONS: Partial<Record<StepStatus, string>> = { done: "✓", error: "✕", stopped: "■" };

/** A tool call: code it runs, an MCP call, a publish. `call` is undefined for a result whose call is not in the chat. */
export function ToolStep({ id, name, call, streaming = false }: { id: string; name: string; call?: ToolCall; streaming?: boolean }) {
  const view = useContext(StepsContext);
  const status = stepStatus(view, id, streaming);
  const result = view.results.get(id);
  const tone = ACTIVE.has(status) ? "active" : (status as "done" | "error" | "stopped");
  const time = result?.durationMs !== undefined ? ` · ${seconds(result.durationMs)}` : "";
  return (
    <Panel id={id} tone={tone} icon={ICONS[status] ?? <Spark />} label={stepLabel(name)} hint={stepHint(call?.arguments)} status={STATUS[status] + time}>
      {() => {
        const output = result ? resultText(result) : view.running.get(id)?.output;
        return (
          <>
            {inputSections(name, call?.arguments).map((section) => (
              <Section key={section.label} {...section} />
            ))}
            {call?.argumentsError && <Section label="Invalid arguments" text={call.argumentsError} error />}
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
  const view = useContext(StepsContext);
  return view.calls.has(message.toolCallId) ? null : <ToolStep id={message.toolCallId} name={message.toolName} />;
}

/** What the model thought before answering, when the provider sends it. */
export function ThoughtStep({ text }: { text: string }) {
  return (
    <Panel icon="✻" label="Thought process" hint={text.trimStart().slice(0, 200).split("\n")[0]}>
      {() => <div className="step-thought">{text.trim()}</div>}
    </Panel>
  );
}
