// What the Limits tab and the action cards say about guardrails and waiting actions, and the rule editor's form: pure,
// so it is tested without a browser.

import {
  ARG_KINDS,
  checkRule,
  EFFECT_LABELS,
  KIND_LABELS,
  type GuardrailEffect,
  type GuardrailKind,
  type GuardrailRule,
  type PendingActionView,
  type QuietRange,
  schemaHasPath,
} from "../../../shared/limits.ts";
import type { ToolInfo } from "../../../shared/protocol.ts";
import { errorMessage, listSome, plural, randomHex } from "../../../shared/util.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12-24" as "24 Dec", "2026-12-24" as "24 Dec 2026"; anything else as it is. */
export function dayText(day: string): string {
  const parts = day.split("-");
  const [year, month, date] = parts.length === 3 ? parts : [undefined, ...parts];
  const name = MONTHS[Number(month) - 1];
  if (!name || !date) return day;
  return `${Number(date)} ${name}${year ? ` ${year}` : ""}`;
}

/** A quiet range in words: "24 Dec–26 Dec every year", "2 Jan 2027–4 Jan 2027". */
export function rangeText(range: QuietRange): string {
  const yearly = range.from.length === 5;
  return `${dayText(range.from)}–${dayText(range.to)}${yearly ? " every year" : ""}`;
}

/** What a rule's limit is, in words: "At most 10", "Never *@example.com", "Quiet dates 24 Dec–26 Dec every year". */
export function limitText(rule: GuardrailRule): string {
  const zone = rule.tz ? ` (${rule.tz})` : "";
  switch (rule.kind) {
    case "min":
    case "max":
      return `${KIND_LABELS[rule.kind]} ${rule.value as number}`;
    case "maxChange":
      return `${KIND_LABELS.maxChange} ${rule.value as number}${rule.percent ? "%" : ""}`;
    case "never": {
      return `Never ${listSome((rule.value as (string | number)[]).map(String), 4)}`;
    }
    case "quietDates":
      return `Quiet dates ${(rule.value as QuietRange[]).map(rangeText).join(", ")}${zone}`;
    case "callsPerDay":
      return `At most ${plural(rule.value as number, "call")} a day${zone}`;
  }
}

/** What a rule is on: "mail.send · to", "crm (any change)"; empty for every tool of every server. */
export function targetText(rule: Pick<GuardrailRule, "server" | "tool" | "arg">): string {
  if (rule.server === "*") return rule.tool === "*" ? "" : `${rule.tool} on any server`;
  const tool = rule.tool === "*" ? `${rule.server} (any change)` : `${rule.server}.${rule.tool}`;
  return rule.arg ? `${tool} · ${rule.arg}` : tool;
}

/** A rule in one line, as the list shows it: "crm.update_deal · discount — At most 10 — Needs approval". */
export function ruleLine(rule: GuardrailRule): string {
  return [targetText(rule), limitText(rule), EFFECT_LABELS[rule.effect]].filter(Boolean).join(" — ");
}

/**
 * What is wrong with a rule by its server's tools as listed now (null before they are read): the gate matches a rule
 * by its tool's name, so one on a tool the server no longer lists checks no call, and (as `hitsFor` reads it) one on an
 * argument its tool no longer has fires on every call to it. Null when nothing is.
 */
export function ruleWarning(
  rule: Pick<GuardrailRule, "server" | "tool" | "arg">,
  tools: readonly ToolInfo[] | null,
): { on: "tool" | "arg"; text: string } | null {
  if (!tools || rule.server === "*" || !rule.tool || rule.tool === "*") return null;
  const tool = tools.find((each) => each.name === rule.tool);
  if (!tool)
    return { on: "tool", text: `${rule.server} lists no tool ${rule.tool} now, so this rule checks no call. If it was renamed, pick its new name.` };
  if (rule.arg && schemaHasPath(tool.inputSchema, rule.arg) === false)
    return { on: "arg", text: `${rule.tool} has no argument ${rule.arg} now, so this rule fires on every call to it.` };
  return null;
}

/** A new rule's id: 8 random lowercase hex characters, new among `taken`. */
export function newRuleId(taken: readonly { id: string }[] = []): string {
  for (;;) {
    const id = randomHex(4);
    if (!taken.some((rule) => rule.id === id)) return id;
  }
}

/** A quiet range as the form edits it: every year ("MM-DD") or once ("YYYY-MM-DD"). */
export interface RangeDraft {
  yearly: boolean;
  from: string;
  to: string;
}

/** A rule as the editor's form holds it: everything as typed, numbers and JSON as text. */
export interface RuleDraft {
  id: string;
  server: string;
  tool: string;
  arg: string;
  kind: GuardrailKind | "";
  /** min, max, maxChange, callsPerDay. */
  number: string;
  percent: boolean;
  currentTool: string;
  /** The current value's read input, as JSON text. */
  currentInput: string;
  currentPath: string;
  /** never: one value a line. */
  values: string;
  ranges: RangeDraft[];
  tz: string;
  effect: GuardrailEffect;
  note: string;
}

export const blankRange = (): RangeDraft => ({ yearly: true, from: "", to: "" });

export function blankDraft(taken: readonly { id: string }[]): RuleDraft {
  return {
    id: newRuleId(taken),
    server: "",
    tool: "",
    arg: "",
    kind: "",
    number: "",
    percent: false,
    currentTool: "",
    currentInput: "{}",
    currentPath: "",
    values: "",
    ranges: [blankRange()],
    tz: "",
    effect: "block",
    note: "",
  };
}

/** The form of a saved rule. */
export function draftOf(rule: GuardrailRule): RuleDraft {
  const draft = { ...blankDraft([]), id: rule.id, server: rule.server, tool: rule.tool, arg: rule.arg ?? "", kind: rule.kind, effect: rule.effect };
  draft.note = rule.note ?? "";
  draft.tz = rule.tz ?? "";
  if (rule.kind === "never") draft.values = (rule.value as (string | number)[]).map(String).join("\n");
  else if (rule.kind === "quietDates") draft.ranges = (rule.value as QuietRange[]).map((range) => ({ yearly: range.from.length === 5, ...range }));
  else draft.number = String(rule.value);
  if (rule.percent) draft.percent = true;
  if (rule.current) {
    draft.currentTool = rule.current.tool;
    draft.currentInput = JSON.stringify(rule.current.input, null, 2);
    draft.currentPath = rule.current.path;
  }
  return draft;
}

/** A number as typed; undefined for nothing typed (Number("") is 0, which would pass for a limit). */
const typedNumber = (text: string) => (text.trim() ? Number(text.trim()) : undefined);

/**
 * The rule a form stands for, before checkRule: only the fields its kind reads. `argType`: the argument's schema type.
 * A number's never values that read as numbers are numbers, and a yes-or-no's are only true or false. Throws with what
 * to fix when its read input is not JSON, or a yes-or-no value is neither.
 */
export function ruleInput(draft: RuleDraft, argType?: string): Record<string, unknown> {
  const numeric = argType === "number" || argType === "integer";
  const kind = draft.kind;
  const base: Record<string, unknown> = { id: draft.id, server: draft.server, tool: draft.tool, kind: kind || undefined, effect: draft.effect };
  if (draft.note.trim()) base.note = draft.note;
  if (kind && ARG_KINDS.includes(kind)) base.arg = draft.arg;
  if (kind === "quietDates" || kind === "callsPerDay") {
    if (draft.tz.trim()) base.tz = draft.tz.trim();
  }
  switch (kind) {
    case "min":
    case "max":
    case "callsPerDay":
      return { ...base, value: typedNumber(draft.number) };
    case "maxChange": {
      let input: unknown;
      try {
        input = draft.currentInput.trim() ? JSON.parse(draft.currentInput) : {};
      } catch {
        throw new Error('The current value\'s read input is not JSON: an object such as {"id": "{{input.id}}"}.');
      }
      return {
        ...base,
        value: typedNumber(draft.number),
        ...(draft.percent && { percent: true }),
        current: { tool: draft.currentTool, input, path: draft.currentPath.trim() },
      };
    }
    case "never": {
      const values = draft.values
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => (numeric && Number.isFinite(Number(line)) ? Number(line) : argType === "boolean" ? line.toLowerCase() : line));
      const odd = argType === "boolean" ? values.find((value) => value !== "true" && value !== "false") : undefined;
      if (odd !== undefined) throw new Error(`${draft.arg} is yes or no: pick true or false, not "${odd}".`);
      return { ...base, value: values };
    }
    case "quietDates":
      return { ...base, value: draft.ranges.map((range) => ({ from: range.from.trim(), to: range.to.trim() })) };
    default:
      return base;
  }
}

/** The form's rule, checked: the rule, or what to fix. */
export function ruleOf(draft: RuleDraft, argType?: string): { rule: GuardrailRule } | { error: string } {
  try {
    return { rule: checkRule(ruleInput(draft, argType)) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

/** How long until `at`, as an action's card says it: "expires in 11 h", "expires in 20 min"; "expired" once it passed. */
export function expiresText(at: number, now: number): string {
  const left = at - now;
  if (left <= 0) return "expired";
  const minutes = Math.round(left / 60_000);
  if (minutes < 1) return "expires in under a minute";
  if (minutes < 60) return `expires in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `expires in ${hours} h`;
  return `expires in ${Math.round(hours / 24)} days`;
}

/** An action's state as its card's last line says it, once it ended or while it runs; null while it waits. */
export function endedText(action: Pick<PendingActionView, "kind" | "status" | "result" | "expiresAt">, now: number): string | null {
  const result = action.result?.trim();
  switch (action.status) {
    case "pending":
      return action.expiresAt <= now ? "Expired" : null;
    case "running":
      return "Running…";
    case "done":
      return result ? `Ran · ${result}` : "Ran";
    case "failed":
      return result ? `Failed · ${result}` : "Failed";
    case "declined":
      return action.kind === "proposal" ? "Dismissed" : "Declined";
    case "expired":
      return "Expired";
  }
}

/** The buttons an action's owner gets: Run and Dismiss for a proposal, Approve and Decline for an approval. */
export function decisionLabels(kind: PendingActionView["kind"]): { approve: string; decline: string } {
  return kind === "proposal" ? { approve: "Run", decline: "Dismiss" } : { approve: "Approve", decline: "Decline" };
}
