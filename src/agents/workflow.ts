// The Workflow tab's steps as it edits them, in plain functions the tests read without a browser: each step with a key
// of its own (a card keeps its state as the list is reordered), an if's branches as lists of their own.

import { walkSteps, type AgentInput, type AgentStep } from "../../shared/agents.ts";
import { canonicalJson } from "../../shared/canonical.ts";
import { ASSUMED_FIELDS, withoutAssumed } from "./glance.ts";

/** A step as the tab edits it. An if's `then` and `else` are here, not in `step`, so each edits as a list. */
export interface Keyed {
  key: string;
  step: AgentStep;
  then?: Keyed[];
  else?: Keyed[];
}

let next = 0;

/** Steps with keys, their branches too. */
export function withKeys(steps: readonly AgentStep[]): Keyed[] {
  return steps.map((step) => ({
    key: `step-${++next}`,
    step,
    ...(step.kind === "if" && { then: withKeys(step.then), else: withKeys(step.else ?? []) }),
  }));
}

/** The steps as a definition keeps them: an if's branches put back, an empty "otherwise" left out. */
export function withoutKeys(steps: readonly Keyed[]): AgentStep[] {
  return steps.map(({ step, then, else: otherwise }) => {
    if (step.kind !== "if") return step;
    const { else: _, ...rest } = step;
    const elseSteps = withoutKeys(otherwise ?? []);
    return { ...rest, then: withoutKeys(then ?? []), ...(elseSteps.length && { else: elseSteps }) };
  });
}

/** `items` with the one at `from` moved to `to`. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const moved = [...items];
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item);
  return moved;
}

/** A new step of a kind, as the Add step button makes it: the fields to fill in, empty. */
export function newStep(kind: AgentStep["kind"]): AgentStep {
  switch (kind) {
    case "look":
    case "do":
      return { kind, server: "", tool: "", input: {} };
    case "work":
      return { kind, prompt: "" };
    case "onlyIf":
      return { kind, condition: "" };
    case "if":
      return { kind, condition: "", then: [] };
    case "tell":
      return { kind, to: ["owner"], via: "chat" };
    case "page":
      return { kind, artifactId: "", edit: "findings" };
    case "handOver":
      return { kind, agent: "" };
  }
}

/** The Workflow tab's parts the model may have guessed, as the "at a glance" rows name them (ASSUMED_FIELDS). */
export type WorkflowPart = "runs" | "scope" | "tells";

type WorkflowParts = Pick<AgentInput, "trigger" | "scope" | "workflow">;
const tellsOf = (workflow: WorkflowParts["workflow"]) => [...walkSteps(workflow ?? [])].filter(({ step }) => step.kind === "tell").map(({ step }) => step);

/** What is still assumed after a save from `before` to `after`: a part the user changed is theirs now. */
export function assumedAfter(assumed: readonly string[], before: WorkflowParts, after: WorkflowParts): string[] {
  const differs = (a: unknown, b: unknown) => canonicalJson(a ?? null) !== canonicalJson(b ?? null);
  let left = [...assumed];
  if (differs(before.trigger, after.trigger)) left = withoutAssumed(left, ASSUMED_FIELDS.runs);
  if (differs(before.scope, after.scope)) left = withoutAssumed(left, ASSUMED_FIELDS.scope);
  if (differs(tellsOf(before.workflow), tellsOf(after.workflow))) left = withoutAssumed(left, ASSUMED_FIELDS.tells);
  return left;
}
