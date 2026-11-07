// What an agent's draft card and page say of a definition in words: its state, its instructions as numbered steps, and
// the "at a glance" rows (scope, runs, reads, tells, knows), each with the field a Change opens and whether the model
// guessed it (Assumed). Plain functions, so the tests read them without a browser.

import { WEEKDAYS, type AgentDefinition, type AgentStep, type AgentTrigger, type Weekday } from "../../shared/agents.ts";

/** What the header's pill says of an agent. */
export function stateLabel(agent: Pick<AgentDefinition, "origin" | "enabled" | "copiedFrom">): { text: string; tone: "on" | "draft" | "off" } {
  if (agent.enabled) return { text: "On", tone: "on" };
  if (agent.origin === "agent") return { text: "Proposed by pi · off", tone: "draft" };
  return { text: agent.copiedFrom ? "Your copy · off" : "Draft · off", tone: agent.copiedFrom ? "draft" : "off" };
}

/** The numbered steps of a Markdown list that makes up the instructions' start (each item's first line), or null without one. */
export function instructionSteps(instructions: string): { steps: string[]; rest: string } | null {
  const lines = instructions.split("\n");
  const steps: string[] = [];
  let at = 0;
  // Leading text before the list stays out of the steps (an intro line).
  while (at < lines.length && !/^\s*\d+[.)]\s+/.test(lines[at])) at++;
  if (at === lines.length) return null;
  const intro = lines.slice(0, at).join("\n").trim();
  for (; at < lines.length; at++) {
    const item = lines[at].match(/^\s*\d+[.)]\s+(.*)$/);
    if (item) {
      steps.push(item[1].trim());
      continue;
    }
    // A line that goes on the item before it (indented, or wrapped text), until a blank line or other block.
    if (steps.length && /^\s{2,}\S/.test(lines[at]) && !/^\s*([-*+]|\d+[.)])\s/.test(lines[at])) {
      steps[steps.length - 1] += ` ${lines[at].trim()}`;
      continue;
    }
    if (!lines[at].trim() && /^\s*\d+[.)]\s+/.test(lines[at + 1] ?? "")) continue;
    break;
  }
  const rest = [intro, lines.slice(at).join("\n").trim()].filter(Boolean).join("\n\n");
  return { steps, rest };
}

export const DAY_NAMES: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const WEEKEND: readonly Weekday[] = ["sat", "sun"];

/** The days a schedule names, in words: "Every day", "Weekdays", "Mon, Wed". */
function daysLabel(days: readonly Weekday[] | undefined): string {
  if (!days || days.length === 7) return "Every day";
  const set = new Set(days);
  if (set.size === 5 && WEEKEND.every((day) => !set.has(day))) return "Weekdays";
  if (set.size === 2 && WEEKEND.every((day) => set.has(day))) return "Weekends";
  return WEEKDAYS.filter((day) => set.has(day))
    .map((day) => DAY_NAMES[day])
    .join(", ");
}

/** How often a watch checks: "every 15 min", "every 2 h", "every day". */
function everyLabel(minutes: number): string {
  if (minutes % (24 * 60) === 0) return minutes === 24 * 60 ? "every day" : `every ${minutes / (24 * 60)} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "every hour" : `every ${minutes / 60} h`;
  return `every ${minutes} min`;
}

/** When an agent runs on its own, in words, and the time zone or condition under it; null for one that only answers. */
export function runsLabel(trigger: AgentTrigger | undefined): { value: string; note?: string } | null {
  if (!trigger) return null;
  if (trigger.kind === "schedule") return { value: `${daysLabel(trigger.days)} at ${trigger.at}`, note: trigger.tz };
  return { value: `Checks ${trigger.step.server} ${everyLabel(trigger.everyMinutes)}`, note: `when ${trigger.when}` };
}

/** Every step of a workflow, those inside an if's branches too. */
function allSteps(steps: readonly AgentStep[] | undefined): AgentStep[] {
  return (steps ?? []).flatMap((step) => (step.kind === "if" ? [step, ...allSteps(step.then), ...allSteps(step.else)] : [step]));
}

const unique = (items: readonly string[]) => [...new Set(items)];

/** One "at a glance" row. */
export interface GlanceRow {
  key: "scope" | "runs" | "reads" | "tells" | "knows";
  label: string;
  value: string;
  note?: string;
  /** The field a Change opens on the agent page. */
  field: string;
  /** The model guessed it: shown as Assumed until someone confirms it. */
  assumed: boolean;
}

/** The names the model may give in `assumed` for each row: a guessed field shows on the row it feeds. */
export const ASSUMED_FIELDS: Record<GlanceRow["key"], readonly string[]> = {
  scope: ["scope"],
  runs: ["trigger", "schedule", "runs", "when"],
  reads: ["servers", "reads", "sharedServers"],
  tells: ["tells", "tell", "recipients", "via", "delivery"],
  knows: ["knows", "skills", "skill", "memory"],
};

/** Whether the model guessed any of `fields`, as `assumed` names them (case and spacing aside). */
export function isAssumed(assumed: readonly string[] | undefined, fields: readonly string[]): boolean {
  const said = new Set((assumed ?? []).map((field) => field.toLowerCase().replace(/[^a-z]/g, "")));
  return fields.some((field) => said.has(field.toLowerCase()));
}

/** The "at a glance" rows of an agent, from its fields: what it runs on, when, what it reads, whom it tells, what it knows. */
export function glanceRows(agent: Pick<AgentDefinition, "name" | "trigger" | "scope" | "workflow" | "servers" | "assumed">): GlanceRow[] {
  const steps = allSteps(agent.workflow);
  const looks = steps.flatMap((step) => (step.kind === "look" ? [step.server] : []));
  const scopeOf = agent.scope?.list;
  const reads = unique([
    ...(agent.servers ?? []),
    ...looks,
    ...(scopeOf ? [scopeOf.server] : []),
    ...(agent.trigger?.kind === "watch" ? [agent.trigger.step.server] : []),
  ]);
  const tells = steps.flatMap((step) => (step.kind === "tell" ? [step] : []));
  const skills = unique(steps.flatMap((step) => (step.kind === "work" && step.skill ? [step.skill] : [])));
  const runs = runsLabel(agent.trigger);
  const row = (key: GlanceRow["key"], label: string, field: string, value: string, note?: string): GlanceRow => ({
    key,
    label,
    value,
    ...(note && { note }),
    field,
    assumed: isAssumed(agent.assumed, ASSUMED_FIELDS[key]),
  });
  return [
    scopeOf
      ? row("scope", "Scope", "scope", `Each item of ${scopeOf.server} ${scopeOf.tool}`, "checked one by one")
      : row("scope", "Scope", "scope", "One run at a time", "not per item"),
    runs
      ? row("runs", "Runs", "trigger", runs.value, runs.note)
      : row("runs", "Runs", "trigger", `When someone calls @${agent.name}`, "in a chat it is in"),
    row(
      "reads",
      "Reads",
      "servers",
      reads.length ? reads.join(", ") : agent.servers ? "No servers" : "Every server",
      // Without a list it may use every server: those its steps name are only the ones it surely reads.
      agent.servers ? (reads.length ? undefined : "it may use") : reads.length ? "and any other: it may use every server" : "it may use",
    ),
    tells.length
      ? row(
          "tells",
          "Tells",
          "workflow",
          unique(tells.flatMap((step) => step.to)).join(", "),
          unique(
            tells.map((step) => (step.via === "chat" ? "in the chat" : step.via === "notify" ? "by a notification" : `through ${step.via.server}`)),
          ).join(", "),
        )
      : row("tells", "Tells", "workflow", "Whoever asked", "with a reply in the chat"),
    row(
      "knows",
      "Knows",
      "instructions",
      skills.length ? `${skills.join(", ")} ${skills.length === 1 ? "skill" : "skills"}` : "Your skills",
      "and what it is told in the chat",
    ),
  ];
}

/** What the page says on what it holds while a tab has changes not saved: leaving the tab, or a new version, would lose them. */
export const SAVE_FIRST = "Save or undo your changes first";
