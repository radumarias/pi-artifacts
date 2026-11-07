// Limits on what agents change: autonomy levels, guardrails, and the actions that wait for their owner.
//
// Every MCP call whose tool is not read-only goes through one gate in the hub (worker/agents/limits/gate.ts), with who
// is calling and why. The caller's level decides what happens: 1 Inform refuses, 2 Recommend makes a proposal card
// the owner presses to run, 3 Approve queues an action that waits for the owner and expires, 4 Run calls it. Before
// any of that, the guardrails are checked against the call's input: rules on a tool's arguments, from its own input
// schema, so the app stays generic. The strictest rule that fires wins: block, then approve, then warn. An action the
// owner approves runs exactly as stored: nothing the model says later changes it.

import type { AgentColor, AutonomyLevel, StepInput } from "./agents.ts";
import type { RunRef } from "./runs.ts";
import { isObject, isTimeZone } from "./util.ts";

export const GUARDRAIL_KINDS = ["min", "max", "maxChange", "never", "quietDates", "callsPerDay"] as const;
export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number];
/** What a rule that fires does, strictest first. */
export const GUARDRAIL_EFFECTS = ["block", "approve", "warn"] as const;
export type GuardrailEffect = (typeof GUARDRAIL_EFFECTS)[number];

export const KIND_LABELS: Record<GuardrailKind, string> = {
  min: "At least",
  max: "At most",
  maxChange: "Changes at most",
  never: "Never",
  quietDates: "Quiet dates",
  callsPerDay: "Calls per day",
};
export const EFFECT_LABELS: Record<GuardrailEffect, string> = { block: "Blocks it", approve: "Needs approval", warn: "Warns" };
/** The kinds that read an argument of the call's input; the others look only at when and how often. */
export const ARG_KINDS: readonly GuardrailKind[] = ["min", "max", "maxChange", "never"];
/** The kinds of rule on the call itself, not on an argument (their tool may be "*"). */
export const PLAIN_KINDS: readonly GuardrailKind[] = GUARDRAIL_KINDS.filter((kind) => !ARG_KINDS.includes(kind));

/** A day range, both ends included: "MM-DD" every year (it may wrap the year: "12-30" to "01-02"), or "YYYY-MM-DD" once. */
export type QuietRange = { from: string; to: string };

/** One guardrail: a rule on calls of one tool of one server ("*": any), and what it does when it fires. */
export interface GuardrailRule {
  /** Unique within its list. */
  id: string;
  server: string;
  /** "*": every tool of the server that changes data. A rule on an argument names one tool. */
  tool: string;
  /** The argument it reads, as a path into the call's input ("discount", "deal.amount"); for min, max, maxChange, never. */
  arg?: string;
  kind: GuardrailKind;
  /**
   * min, max, maxChange: a number (maxChange: the largest change versus the current value, an amount, or a percentage
   * with `percent`); callsPerDay: how many calls a day are fine; never: the values the argument may never take (text
   * may use * for any characters, as in "*@example.com"); quietDates: the ranges.
   */
  value: number | (string | number)[] | QuietRange[];
  percent?: true;
  /**
   * maxChange: where the current value is read: a read-only tool of the same server, its input ({{input.x}} fills in
   * from the call's own input), and the path of the value in its result.
   */
  current?: { tool: string; input: StepInput; path: string };
  /** quietDates and callsPerDay: the time zone their days are in; UTC when absent. */
  tz?: string;
  effect: GuardrailEffect;
  /** Why it is there, in the owner's words: shown with what it held. */
  note?: string;
}

/** Rules one agent, or one user for all their agents, may have. */
export const MAX_GUARDRAILS = 30;
/** How long an action waits for its owner before it expires, by default, and at most. */
export const DEFAULT_APPROVAL_HOURS = 12;
export const MAX_APPROVAL_HOURS = 7 * 24;
export const MAX_QUIET_RANGES = 20;
export const MAX_NEVER_VALUES = 50;

/** Thrown by checkRules with what to fix. */
export class GuardrailError extends Error {}

function fail(message: string): never {
  throw new GuardrailError(message);
}

const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ARG_PATH = /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+){0,5}$/;

function name(value: unknown, what: string, { star = true } = {}): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) fail(`A rule needs ${what}.`);
  const trimmed = value.trim();
  if (trimmed === "*" && !star) fail(`A rule on an argument names one ${what.replace(/^an? /, "")}, not "*".`);
  return trimmed;
}

function finite(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${what} is a number.`);
  return value;
}

/** One rule, checked and trimmed. Throws a GuardrailError with what to fix. */
export function checkRule(input: unknown): GuardrailRule {
  if (!isObject(input)) fail("A rule is an object.");
  const kind = input.kind;
  if (!(GUARDRAIL_KINDS as readonly unknown[]).includes(kind)) fail(`A rule's kind is one of ${GUARDRAIL_KINDS.join(", ")}.`);
  const effect = input.effect ?? "block";
  if (!(GUARDRAIL_EFFECTS as readonly unknown[]).includes(effect)) fail(`A rule ${GUARDRAIL_EFFECTS.join(", ")}s.`);
  const onArg = ARG_KINDS.includes(kind as GuardrailKind);
  const server = name(input.server, "a server");
  const tool = name(input.tool, "a tool", { star: !onArg });
  if (onArg && server === "*") fail('A rule on an argument names one server, not "*".');
  const id = typeof input.id === "string" && /^[a-z0-9]{1,16}$/.test(input.id) ? input.id : undefined;
  if (!id) fail("A rule needs an id: up to 16 lowercase letters or digits.");
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 200) : undefined;
  const base = { id, server, tool, kind: kind as GuardrailKind, effect: effect as GuardrailEffect, ...(note && { note }) };
  let arg: string | undefined;
  if (onArg) {
    if (typeof input.arg !== "string" || !ARG_PATH.test(input.arg))
      fail(`A ${KIND_LABELS[kind as GuardrailKind].toLowerCase()} rule names an argument of the tool.`);
    arg = input.arg;
  }
  const tz = input.tz ?? undefined;
  if (tz !== undefined && (typeof tz !== "string" || !isTimeZone(tz))) fail('A rule\'s time zone is one such as "Europe/Bucharest".');
  const zone = (kind === "quietDates" || kind === "callsPerDay") && tz ? { tz: tz as string } : {};
  switch (kind as GuardrailKind) {
    case "min":
    case "max":
      return { ...base, arg, value: finite(input.value, "Its limit") };
    case "maxChange": {
      const value = finite(input.value, "The largest change");
      if (value < 0) fail("The largest change is 0 or more.");
      const current = input.current;
      if (!isObject(current)) fail("A change rule says where the current value is read: {tool, input, path}.");
      const readTool = name(current.tool, "a tool to read the current value with", { star: false });
      const readInput = current.input === undefined ? {} : current.input;
      if (!isObject(readInput) || JSON.stringify(readInput).length > 2_000) fail("The current value's read takes an object as its input.");
      if (typeof current.path !== "string" || !(current.path === "" || ARG_PATH.test(current.path)))
        fail("The current value's path is like data.amount.");
      return {
        ...base,
        arg,
        value,
        ...(input.percent === true && { percent: true as const }),
        current: { tool: readTool, input: JSON.parse(JSON.stringify(readInput)) as StepInput, path: current.path },
      };
    }
    case "never": {
      const values = input.value;
      if (!Array.isArray(values) || !values.length || values.length > MAX_NEVER_VALUES) fail(`A never rule lists 1 to ${MAX_NEVER_VALUES} values.`);
      const kept = values.map((value) => {
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value === "string" && value.trim() && value.length <= 200) return value.trim();
        return fail("A never rule's values are numbers or text.");
      });
      return { ...base, arg, value: [...new Set(kept)] };
    }
    case "quietDates": {
      const ranges = input.value;
      if (!Array.isArray(ranges) || !ranges.length || ranges.length > MAX_QUIET_RANGES) fail(`Quiet dates are 1 to ${MAX_QUIET_RANGES} ranges.`);
      const kept = ranges.map((range): QuietRange => {
        if (!isObject(range) || typeof range.from !== "string" || typeof range.to !== "string") fail("A quiet range is {from, to}.");
        const yearly = MONTH_DAY.test(range.from) && MONTH_DAY.test(range.to);
        const once = DATE.test(range.from) && DATE.test(range.to);
        if (!yearly && !once) fail('A quiet range\'s days are both "MM-DD" (every year) or both "YYYY-MM-DD" (once).');
        if (once && range.from > range.to) fail("A quiet range ends on or after it starts.");
        return { from: range.from, to: range.to };
      });
      return { ...base, value: kept, ...zone };
    }
    case "callsPerDay": {
      const value = finite(input.value, "Calls per day");
      if (!Number.isInteger(value) || value < 0 || value > 10_000) fail("Calls per day is a whole number from 0 to 10000.");
      return { ...base, value, ...zone };
    }
  }
}

/** A list of rules, checked; ids made unique. Throws a GuardrailError with what to fix. */
export function checkRules(input: unknown): GuardrailRule[] {
  if (!Array.isArray(input)) fail("Rules are a list.");
  if (input.length > MAX_GUARDRAILS) fail(`There are at most ${MAX_GUARDRAILS} rules.`);
  const rules = input.map(checkRule);
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) fail("Two rules have the same id.");
  return rules;
}

/** The call a rule is checked against. `at`: when it is made, epoch ms. */
export interface GuardedCall {
  server: string;
  tool: string;
  input: StepInput;
  at: number;
}

/** What a rule needs besides the call: the current value it changes (maxChange), the calls already made today (callsPerDay). */
export interface RuleFacts {
  current?: number | null;
  callsToday?: number;
}

export function ruleApplies(rule: Pick<GuardrailRule, "server" | "tool">, call: Pick<GuardedCall, "server" | "tool">): boolean {
  return (rule.server === "*" || rule.server === call.server) && (rule.tool === "*" || rule.tool === call.tool);
}

/** The value at a dot path (`a.b.0`) of a JSON value; undefined when there is none. "" is the value itself. */
export function valueAt(value: unknown, path: string): unknown {
  if (!path) return value;
  let found: unknown = value;
  for (const part of path.split(".")) {
    if (Array.isArray(found) && /^\d+$/.test(part)) found = found[Number(part)];
    else if (isObject(found) && Object.hasOwn(found, part)) found = found[part];
    else return undefined;
  }
  return found;
}

/**
 * An argument's values: each element of a list, else the value itself; none when the call does not set it. A path
 * through a list of objects (`items.amount`) reads that field of each of them.
 */
export function argValues(input: StepInput, path: string): unknown[] {
  let found: unknown[] = [input];
  for (const part of path.split(".")) {
    found = found.flatMap((value): unknown[] => {
      if (Array.isArray(value)) {
        if (/^\d+$/.test(part)) return value.length > Number(part) ? [value[Number(part)]] : [];
        return value.flatMap((item) => (isObject(item) && Object.hasOwn(item, part) ? [item[part]] : []));
      }
      return isObject(value) && Object.hasOwn(value, part) ? [value[part]] : [];
    });
  }
  return found.flatMap((value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]));
}

/**
 * Whether a tool's input schema has an argument at `path` (through objects' properties and lists' items); undefined
 * when the schema does not say (no properties listed, or it allows any others), so nothing can be told from it.
 */
export function schemaHasPath(schema: unknown, path: string): boolean | undefined {
  return hasPath(schema, path.split("."));
}

/**
 * `parts` under a schema node: a list's elements stand for it (an index names one of them, a field's name reads it of
 * each), and a node of choices (anyOf, oneOf, allOf) has a path when any of them has it.
 */
function hasPath(schema: unknown, parts: readonly string[]): boolean | undefined {
  let node = schema;
  while (isObject(node) && schemaType(node) === "array") node = node.items;
  if (!parts.length) return true;
  const [part, ...rest] = parts;
  if (/^\d+$/.test(part)) return hasPath(node, rest);
  if (!isObject(node)) return undefined;
  const choices = [node.anyOf, node.oneOf, node.allOf].flatMap((list) => (Array.isArray(list) ? list : []));
  let own: boolean | undefined;
  if (isObject(node.properties)) {
    if (Object.hasOwn(node.properties, part)) own = hasPath(node.properties[part], rest);
    else own = node.additionalProperties === true || isObject(node.additionalProperties) ? undefined : false;
    // A node of plain types only (text, numbers, yes or no, null) has nothing under it either.
  } else own = choices.length || plainTypes(node) ? false : undefined;
  if (own === true) return true;
  let unknown = own === undefined;
  for (const choice of choices) {
    const found = hasPath(choice, parts);
    if (found === true) return true;
    if (found === undefined) unknown = true;
  }
  return unknown ? undefined : false;
}

const PLAIN_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);

/** Whether a schema node names its types and each is a plain one. */
function plainTypes(node: Record<string, unknown>): boolean {
  const types = Array.isArray(node.type) ? node.type : [node.type];
  return types.length > 0 && types.every((type) => typeof type === "string" && PLAIN_TYPES.has(type));
}

/** A number, or a string that is one; undefined otherwise. */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/**
 * Whether a value matches a never rule's value: the same, ignoring case, with * for any characters; a boolean as
 * "true" or "false". Text that lists several (joined by commas, semicolons or new lines, as recipients often are)
 * matches when any one of them does; and one written "Name <address>" by its address or its name, and by each word.
 */
export function matchesValue(pattern: string | number, value: unknown): boolean {
  return neverMatcher([pattern])(value) !== undefined;
}

/** A never rule's values as one check, made once (matchesValue): the first of them a value matches, else undefined. */
export function neverMatcher(patterns: readonly (string | number)[]): (value: unknown) => string | number | undefined {
  const tests = patterns.map((pattern) => ({ pattern, test: typeof pattern === "number" ? null : textTest(pattern) }));
  return (value) => {
    let names: string[] | null | undefined;
    for (const { pattern, test } of tests) {
      if (test === null) {
        if (asNumber(value) === pattern) return pattern;
        continue;
      }
      names ??= namesIn(value);
      if (names?.some(test)) return pattern;
    }
    return undefined;
  };
}

/** A never rule's text value as a test of one name: the same, ignoring case, with * for any characters. */
function textTest(pattern: string): (name: string) => boolean {
  const wanted = pattern.trim().toLowerCase();
  if (!wanted.includes("*")) return (name) => name === wanted;
  const regex = new RegExp(
    `^${wanted
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "s",
  );
  return (name) => regex.test(name);
}

/**
 * What a value may be matched by, lowercased: itself; and for text each entry of the list it may be, as written and as
 * mail libraries read it (normalAddresses), by namesOf. Null for a value that is not text, a number or a boolean.
 */
function namesIn(value: unknown): string[] | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  const text = String(value).trim().toLowerCase();
  if (typeof value !== "string") return [text];
  const entries = [text, normalAddresses(text)].flatMap((one) => one.split(LIST_SPLIT)).flatMap((entry) => [entry, normalAddresses(entry)]);
  return [text, ...entries.flatMap(namesOf)];
}

/** What joins the entries of a list of recipients. */
const LIST_SPLIT = /[,;\n]+/;

/**
 * Text as mail libraries read an address in it: without (comments), no spaces around the @, without a group's name
 * before it ("team: a@b.example;") or a trailing ";".
 */
function normalAddresses(text: string): string {
  return text
    .replace(/\([^()]*\)/g, " ")
    .replace(/\s*@\s*/g, "@")
    .replace(/^[^"<>@:,;]*:/, "")
    .replace(/;\s*$/, "")
    .trim();
}

/**
 * What one entry of a list may be matched by: itself, each <…> in it and what follows its last "<" (the address a mail
 * server takes, also behind a quoted name holding brackets of its own: "a<b>"<x@y>), the name before it, and each word.
 */
function namesOf(entry: string): string[] {
  const trimmed = entry.trim();
  if (!trimmed) return [];
  // An address need not be a word of its own ("Name<address>" has no space before it).
  const bracketed = [...trimmed.matchAll(/<([^<>]*)>/g)].map((match) => match[1].trim());
  const last = trimmed.includes("<") ? trimmed.slice(trimmed.lastIndexOf("<") + 1).replace(/>\s*$/, "").trim() : "";
  const name = bracketed.length ? trimmed.replace(/<[^<>]*>\s*$/, "").trim().replace(/^"(.*)"$/, "$1").trim() : "";
  const words = trimmed.split(/\s+/).map((word) => word.replace(/^[<"'(]+|[>"'),]+$/g, ""));
  return [trimmed, ...bracketed, last, name, ...words].filter(Boolean);
}

/** How deep a never rule reads into an object or a list. */
const NEVER_DEPTH = 6;

/**
 * The text, number and yes-or-no values in a value (itself, when it is one), and the keys of its objects (recipients
 * kept as {"ann@x.example": true}); null when they lie deeper than NEVER_DEPTH.
 */
function leavesOf(value: unknown, depth = 0): unknown[] | null {
  if (value === null || value === undefined) return [];
  if (typeof value !== "object") return [value];
  if (depth >= NEVER_DEPTH) return null;
  const leaves: unknown[] = Array.isArray(value) ? [] : Object.keys(value);
  for (const each of Array.isArray(value) ? value : Object.values(value)) {
    const found = leavesOf(each, depth + 1);
    if (found === null) return null;
    leaves.push(...found);
  }
  return leaves;
}

/** A value as JSON in a rule's words: its start when long. */
function excerptJson(value: unknown): string {
  const json = JSON.stringify(value) ?? String(value);
  return json.length > 120 ? `${json.slice(0, 119)}…` : json;
}

/** The day `at` falls on in `tz`, as "YYYY-MM-DD". */
export function dayIn(at: number, tz = "UTC"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

/** Whether a day ("YYYY-MM-DD") is inside a quiet range. */
export function inQuietRange(day: string, range: QuietRange): boolean {
  if (DATE.test(range.from)) return day >= range.from && day <= range.to;
  const monthDay = day.slice(5);
  // A yearly range that wraps the year ("12-30" to "01-02") holds from its start to the year's end and on from January.
  return range.from <= range.to ? monthDay >= range.from && monthDay <= range.to : monthDay >= range.from || monthDay <= range.to;
}

/** Why a rule fires for a call, in words; null when it does not. */
export function violation(rule: GuardrailRule, call: GuardedCall, facts: RuleFacts = {}): string | null {
  if (!ruleApplies(rule, call)) return null;
  const where = rule.arg ? `${rule.arg} of ${call.server}.${call.tool}` : `${call.server}.${call.tool}`;
  switch (rule.kind) {
    case "min":
    case "max": {
      const limit = rule.value as number;
      for (const value of argValues(call.input, rule.arg!)) {
        const number = asNumber(value);
        // A value that is not a number cannot be checked against a number: held, rather than let through.
        if (number === undefined) return `${where} is ${JSON.stringify(value)}, not a number`;
        if (rule.kind === "min" && number < limit) return `${where} is ${number}, under ${limit}`;
        if (rule.kind === "max" && number > limit) return `${where} is ${number}, over ${limit}`;
      }
      return null;
    }
    case "maxChange": {
      const values = argValues(call.input, rule.arg!);
      if (!values.length) return null;
      const current = facts.current;
      if (current === undefined || current === null) return `the current value of ${where} could not be read, so its change cannot be checked`;
      const limit = rule.value as number;
      for (const value of values) {
        const number = asNumber(value);
        if (number === undefined) return `${where} is ${JSON.stringify(value)}, not a number`;
        const change = Math.abs(number - current);
        if (rule.percent) {
          const percent = current === 0 ? (change === 0 ? 0 : Infinity) : (change / Math.abs(current)) * 100;
          if (percent > limit)
            return `${where} goes from ${current} to ${number}, a change of ${Number.isFinite(percent) ? `${Math.round(percent * 10) / 10}%` : "more than any percentage"}, over ${limit}%`;
        } else if (change > limit) return `${where} goes from ${current} to ${number}, a change of ${change}, over ${limit}`;
      }
      return null;
    }
    case "never": {
      // An object or a list (a recipient as {email}, a field a server turned from text into objects) is checked by
      // each text, number and yes-or-no in it; one nested too deep to read through fails closed.
      const match = neverMatcher(rule.value as (string | number)[]);
      for (const value of argValues(call.input, rule.arg!)) {
        const leaves = leavesOf(value);
        if (leaves === null) return `${where} is ${excerptJson(value)}, nested too deep for a never rule to check`;
        const hit = leaves.find((leaf) => match(leaf) !== undefined);
        if (hit !== undefined) return `${where} is ${excerptJson(hit)}, which is never allowed`;
      }
      return null;
    }
    case "quietDates": {
      const day = dayIn(call.at, rule.tz);
      const range = (rule.value as QuietRange[]).find((one) => inQuietRange(day, one));
      return range ? `${day} is a quiet date (${range.from} to ${range.to})` : null;
    }
    case "callsPerDay": {
      const made = facts.callsToday ?? 0;
      // What it counts: the tool called, or every tool the rule is on ("*").
      const counted = rule.tool !== "*" ? `${call.server}.${call.tool}` : rule.server === "*" ? "Tools that change data" : `${call.server}'s tools`;
      return made >= (rule.value as number) ? `${counted} ${rule.tool === "*" ? "were" : "was"} called ${made} times today, the most a day` : null;
    }
  }
}

/** A rule that fired, and why. */
export interface RuleHit {
  rule: GuardrailRule;
  reason: string;
}

/** A hit in words, for the people and the model: its reason, and the owner's note. */
export function hitText(hit: RuleHit): string {
  return `${hit.reason}${hit.rule.note ? ` (${hit.rule.note})` : ""}`;
}

/** The kinds of rule that fit an argument of this JSON schema type (the rule editor's choices). */
export function kindsFor(type: string | undefined): GuardrailKind[] {
  if (type === "number" || type === "integer") return [...ARG_KINDS];
  if (type === "string" || type === "array" || type === "boolean" || type === undefined) return ["never"];
  return [];
}

/** One argument of a tool, as the rule editor offers it: its path, JSON schema type and description. */
export interface ToolArg {
  path: string;
  type?: string;
  description?: string;
  /** The values its schema allows (`enum`), for a never rule's choices. */
  values?: (string | number)[];
}

/** A JSON schema property's type, the first that is not "null" when it lists several. */
export function schemaType(property: Record<string, unknown>): string | undefined {
  const type = Array.isArray(property.type) ? property.type.find((one) => one !== "null") : property.type;
  return typeof type === "string" ? type : undefined;
}

/** The arguments a tool's input schema names, nested objects' too (to 3 levels), for the rule editor. */
export function toolArgs(schema: unknown, prefix = "", depth = 0): ToolArg[] {
  if (!isObject(schema) || !isObject(schema.properties) || depth > 2) return [];
  return Object.entries(schema.properties).flatMap(([key, property]): ToolArg[] => {
    if (!isObject(property)) return [];
    const path = prefix ? `${prefix}.${key}` : key;
    const type = schemaType(property);
    if (type === "object") return toolArgs(property, path, depth + 1);
    const items = isObject(property.items) ? property.items : undefined;
    // A list of objects: a rule reads a field of each of them (`items.amount`).
    if (type === "array" && items && schemaType(items) === "object") return toolArgs(items, path, depth + 1);
    const choices = (Array.isArray(property.enum) ? property.enum : Array.isArray(items?.enum) ? items.enum : undefined)?.filter(
      (value): value is string | number => typeof value === "string" || typeof value === "number",
    );
    const description = typeof property.description === "string" ? property.description.slice(0, 200) : undefined;
    const itemType = type === "array" && typeof items?.type === "string" ? (items.type as string) : undefined;
    return [
      {
        path,
        type: itemType === "number" || itemType === "integer" ? itemType : type,
        ...(description && { description }),
        ...(choices?.length && { values: choices }),
      },
    ];
  });
}

/** What an agent's limits are, as the Limits tab edits them (the fields of AgentInput it owns). */
export const LIMIT_FIELDS = ["autonomy", "guardrails", "approvalHours"] as const;

// ---- Actions that wait for the owner ----

/** A proposal (level 2: a card the owner presses) or an approval (level 3, or a rule that asks for one). */
export type ActionKind = "proposal" | "approval";
export type ActionStatus = "pending" | "running" | "done" | "failed" | "declined" | "expired";

/** Who made a call: pi, an agent of the owner's, or one of their pages. */
export interface ActionActor {
  name: string;
  agentId?: string;
  avatar?: string;
  color?: AgentColor;
}

/** How an actor is named in words and in the log of calls: "@name" for an agent, else its name (pi, a page). */
export function actorName(actor: Pick<ActionActor, "name" | "agentId">): string {
  return actor.agentId ? `@${actor.name}` : actor.name;
}

/**
 * An action waiting for its owner, or one that waited, as the owner and the chat see it: the exact call, why it waits,
 * and how it ended. Only the chat's owner may approve or decline it.
 */
export interface PendingActionView {
  id: string;
  /** The chat it came from (and runs in). */
  chatId: string;
  kind: ActionKind;
  actor: ActionActor;
  server: string;
  tool: string;
  input: StepInput;
  /** Why it waits: the level, or the rules that asked for approval. */
  why: string;
  /** Rules that warned about it. */
  warnings?: string[];
  createdAt: number;
  expiresAt: number;
  status: ActionStatus;
  decidedAt?: number;
  /** What running it came to: its result's start, or the error. */
  result?: string;
  /** The run it came from, when a run's step made it. */
  run?: RunRef;
}

/**
 * The entry a held call is placed as in the log of the chat it came from (a passive write): its card. The card's state
 * comes live from the chat (the `actions` socket message); `action` is how it was made.
 */
export const CHAT_ACTION_KIND = "chat.action";
export type ChatActionData = { action: PendingActionView };

/** The entry kind of what the app tells a session about an action it asked for: approved and run, declined, expired. */
export const APP_APPROVAL_KIND = "app.approval";

/** A call the gate let through, refused or held, as the owner's log of calls keeps it. */
export type CallOutcome = "ran" | "failed" | "refused" | "held" | "warned";
export interface CallLogView {
  id: number;
  at: number;
  chatId: string;
  actor: string;
  server: string;
  tool: string;
  outcome: CallOutcome;
  detail?: string;
}

/**
 * How far a caller may go: its level, and what to say about it. pi on its owner's own message, and an agent on its
 * owner's own turn, run (4) within the guardrails; anyone else's turn goes no further than Recommend (2), and a hand-off
 * no further than the turn that handed it.
 */
export interface CallerLevel {
  level: AutonomyLevel;
  /** Why it is that level, for the held call's card: "at Recommend, on a member's message". */
  because: string;
}

/** An action's call in one line: server.tool with its input, cut. */
export function callLine(call: Pick<PendingActionView, "server" | "tool" | "input">, max = 160): string {
  const input = JSON.stringify(call.input);
  return `${call.server}.${call.tool} ${input.length > max ? `${input.slice(0, max)}…` : input}`;
}
