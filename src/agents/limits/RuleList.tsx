import { useEffect, useId, useState, type KeyboardEvent } from "react";
import type { AgentServerInfo } from "../../../shared/agents.ts";
import {
  ARG_KINDS,
  EFFECT_LABELS,
  GUARDRAIL_EFFECTS,
  KIND_LABELS,
  kindsFor,
  MAX_GUARDRAILS,
  MAX_QUIET_RANGES,
  PLAIN_KINDS,
  toolArgs,
  type GuardrailEffect,
  type GuardrailKind,
  type GuardrailRule,
  type ToolArg,
} from "../../../shared/limits.ts";
import { isReadOnly, type ToolInfo } from "../../../shared/protocol.ts";
import { errorMessage } from "../../../shared/util.ts";
import { api } from "../../api.ts";
import { blankDraft, blankRange, draftOf, ruleLine, ruleOf, ruleWarning, type RangeDraft, type RuleDraft } from "./rules.ts";

/** A draft's kind when it is one on the call itself (it stays as the server or tool changes), else none. */
const plainKind = (draft: RuleDraft) => (draft.kind && PLAIN_KINDS.includes(draft.kind) ? draft.kind : "");

/** Each server's tools, read once for every editor open at once; a failed read is asked again next time. */
const toolReads = new Map<string, Promise<ToolInfo[]>>();
function readTools(server: string): Promise<ToolInfo[]> {
  let read = toolReads.get(server);
  if (!read) {
    read = api.serverTools(server);
    read.catch(() => toolReads.delete(server));
    toolReads.set(server, read);
  }
  return read;
}

function useServerTools(server: string): { tools: ToolInfo[] | null; error: string | null } {
  const [state, setState] = useState<{ server: string; tools: ToolInfo[] | null; error: string | null }>({ server, tools: null, error: null });
  useEffect(() => {
    if (!server || server === "*") return;
    let live = true;
    readTools(server).then(
      (tools) => live && setState({ server, tools, error: null }),
      (e: unknown) => live && setState({ server, tools: null, error: errorMessage(e) }),
    );
    return () => {
      live = false;
    };
  }, [server]);
  return state.server === server ? state : { tools: null, error: null };
}

/**
 * A list of rules, one line each ("mail.send · to — Never *@example.com — Blocks it"), with Edit and Remove, and "Add a
 * rule". The editor opens in place of the line it edits; a rule joins the list only once checkRule takes it. Nothing
 * here saves: the list's owner does, with its own Save.
 */
export function RuleList({
  rules,
  onChange,
  servers,
  serversError,
  empty,
  onEditing,
}: {
  rules: readonly GuardrailRule[];
  onChange: (rules: GuardrailRule[]) => void;
  /** The servers its rules may be on; null while they are read. */
  servers: readonly AgentServerInfo[] | null;
  serversError?: string | null;
  /** What it says when it has none. */
  empty: string;
  /** Whether a rule is being edited: what it holds is not in the list yet. */
  onEditing?: (editing: boolean) => void;
}) {
  // The rule being edited: its place in the list, or null for a new one.
  const [editing, setEditing] = useState<{ index: number | null; draft: RuleDraft } | null>(null);
  useEffect(() => onEditing?.(editing !== null), [editing, onEditing]);
  useEffect(() => () => onEditing?.(false), [onEditing]);
  const done = (rule: GuardrailRule) => {
    if (!editing) return;
    onChange(editing.index === null ? [...rules, rule] : rules.map((each, i) => (i === editing.index ? rule : each)));
    setEditing(null);
  };
  const editor = (index: number | null, draft: RuleDraft) => (
    <RuleEditor
      draft={draft}
      onDraft={(next) => setEditing({ index, draft: next })}
      servers={servers}
      serversError={serversError ?? null}
      onDone={done}
      onCancel={() => setEditing(null)}
    />
  );
  return (
    <div className="limit-rules">
      {rules.length === 0 && editing?.index !== null && <p className="skills-note">{empty}</p>}
      {rules.length > 0 && (
        <ul>
          {rules.map((rule, index) =>
            editing?.index === index ? (
              <li key={rule.id} className="editing">
                {editor(index, editing.draft)}
              </li>
            ) : (
              <li key={rule.id}>
                <span className="limit-rule-text">
                  <span>{ruleLine(rule)}</span>
                  {rule.note && <small>{rule.note}</small>}
                  <RuleLineWarning rule={rule} />
                </span>
                <span className="limit-rule-actions">
                  <button type="button" disabled={editing !== null} onClick={() => setEditing({ index, draft: draftOf(rule) })}>
                    Edit
                  </button>
                  <button type="button" disabled={editing !== null} onClick={() => onChange(rules.filter((_, i) => i !== index))}>
                    Remove
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      )}
      {editing?.index === null && editor(null, editing.draft)}
      {!editing && (
        <button
          type="button"
          className="limit-add"
          disabled={rules.length >= MAX_GUARDRAILS}
          title={rules.length >= MAX_GUARDRAILS ? `At most ${MAX_GUARDRAILS} rules` : undefined}
          onClick={() => setEditing({ index: null, draft: blankDraft(rules) })}
        >
          + Add a rule
        </button>
      )}
    </div>
  );
}

/** A saved rule's warning on its line, by its server's tools as listed now. */
function RuleLineWarning({ rule }: { rule: GuardrailRule }) {
  const { tools } = useServerTools(rule.tool === "*" ? "" : rule.server);
  const warning = ruleWarning(rule, tools);
  return warning ? <small className="rule-warn">{warning.text}</small> : null;
}

/** The argument a rule reads, as its tool's schema has it. */
function argOf(args: readonly ToolArg[], path: string): ToolArg | undefined {
  return args.find((arg) => arg.path === path);
}

/**
 * The editor of one rule, made from the tool's own input schema: a server, then one of its tools that change data
 * ("*" for every one), then an argument of it, then what the rule checks of that argument (kindsFor its type); with no
 * argument, when (quiet dates) and how often (calls per day). Then what the rule does when it fires, and a note.
 */
function RuleEditor({
  draft,
  onDraft,
  servers,
  serversError,
  onDone,
  onCancel,
}: {
  draft: RuleDraft;
  onDraft: (draft: RuleDraft) => void;
  servers: readonly AgentServerInfo[] | null;
  serversError: string | null;
  onDone: (rule: GuardrailRule) => void;
  onCancel: () => void;
}) {
  const ids = useId();
  const [error, setError] = useState<string | null>(null);
  const set = (change: Partial<RuleDraft>) => {
    setError(null);
    onDraft({ ...draft, ...change });
  };
  const { tools, error: toolsError } = useServerTools(draft.server);
  const writes = tools?.filter((tool) => !isReadOnly(tool)) ?? [];
  const reads = tools?.filter(isReadOnly) ?? [];
  const tool = draft.tool && draft.tool !== "*" ? tools?.find((each) => each.name === draft.tool) : undefined;
  const args = tool ? toolArgs(tool.inputSchema).filter((arg) => kindsFor(arg.type).length > 0) : [];
  const arg = draft.arg ? argOf(args, draft.arg) : undefined;
  const warning = ruleWarning(draft, tools);
  const onArg = draft.server !== "*" && draft.tool !== "*" && draft.tool !== "";
  // A saved rule on an argument its tool no longer lists (or before the tools are read) keeps the kinds it had.
  const kinds: readonly GuardrailKind[] = draft.arg ? (arg ? kindsFor(arg.type) : draft.kind ? [draft.kind] : ARG_KINDS) : PLAIN_KINDS;

  const pickServer = (server: string) =>
    set({
      server,
      tool: server === "*" ? "*" : "",
      arg: "",
      currentTool: "",
      kind: plainKind(draft),
    });
  const pickTool = (name: string) => set({ tool: name, arg: "", kind: plainKind(draft) });
  const pickArg = (path: string) => {
    const next = path ? argOf(args, path) : undefined;
    const allowed = path ? kindsFor(next?.type) : PLAIN_KINDS;
    set({ arg: path, kind: draft.kind && allowed.includes(draft.kind) ? draft.kind : path ? (allowed[0] ?? "") : "" });
  };

  const finish = () => {
    if (!draft.server) return setError("Pick a server.");
    if (!draft.tool) return setError("Pick a tool, or every tool that changes data.");
    if (!draft.kind) return setError("Pick what the rule checks.");
    const checked = ruleOf(draft, arg?.type);
    if ("error" in checked) setError(checked.error);
    else onDone(checked.rule);
  };
  // Enter in a field finishes the rule, rather than submitting the form around it (the agent's Save).
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      finish();
    }
  };

  const serverNames = servers?.map((server) => server.name) ?? [];
  const toolNames = writes.map((each) => each.name);
  return (
    <div className="rule-editor" onKeyDown={onKey} role="group" aria-label="Rule">
      <div className="rule-editor-row">
        <label className="rule-field">
          <span>Server</span>
          <select value={draft.server} onChange={(e) => pickServer(e.target.value)}>
            <option value="">Pick a server</option>
            <option value="*">Any server (quiet dates, calls per day)</option>
            {withCurrent(serverNames, draft.server).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {serversError && <small className="form-error">Could not read the servers: {serversError}</small>}
        </label>
        {draft.server && draft.server !== "*" && (
          <label className="rule-field">
            <span>Tool</span>
            <select value={draft.tool} onChange={(e) => pickTool(e.target.value)}>
              <option value="">{tools || toolsError ? "Pick a tool" : "Reading its tools…"}</option>
              <option value="*">Every tool that changes data</option>
              {withCurrent(toolNames, draft.tool).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {toolsError && <small className="form-error">Could not read its tools: {toolsError}</small>}
            {tools && !writes.length && <small>It has no tools that change data.</small>}
            {warning?.on === "tool" ? (
              <small className="rule-hint rule-warn">{warning.text}</small>
            ) : (
              tool?.description && <small className="rule-hint">{tool.description}</small>
            )}
          </label>
        )}
        {onArg && (
          <label className="rule-field">
            <span>Argument</span>
            <select value={draft.arg} onChange={(e) => pickArg(e.target.value)}>
              <option value="">None: when and how often</option>
              {withCurrent(
                args.map((each) => each.path),
                draft.arg,
              ).map((path) => {
                const type = argOf(args, path)?.type;
                return (
                  <option key={path} value={path}>
                    {type ? `${path} (${type})` : path}
                  </option>
                );
              })}
            </select>
            {warning?.on === "arg" ? (
              <small className="rule-hint rule-warn">{warning.text}</small>
            ) : (
              arg?.description && <small className="rule-hint">{arg.description}</small>
            )}
          </label>
        )}
        {draft.tool && (
          <label className="rule-field">
            <span>Checks</span>
            <select value={draft.kind} onChange={(e) => set({ kind: e.target.value as GuardrailKind })}>
              <option value="">Pick one</option>
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {draft.kind && <KindFields draft={draft} set={set} arg={arg} reads={reads} ids={ids} />}
      {draft.kind && (
        <div className="rule-editor-row">
          <label className="rule-field">
            <span>When it fires</span>
            <select value={draft.effect} onChange={(e) => set({ effect: e.target.value as GuardrailEffect })}>
              {GUARDRAIL_EFFECTS.map((effect) => (
                <option key={effect} value={effect}>
                  {EFFECT_LABELS[effect]}
                </option>
              ))}
            </select>
          </label>
          <label className="rule-field grow">
            <span>Note (optional)</span>
            <input
              value={draft.note}
              onChange={(e) => set({ note: e.target.value })}
              maxLength={200}
              placeholder="Why it is there: shown with what it held"
            />
          </label>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="rule-editor-actions">
        <button type="button" className="primary" onClick={finish}>
          Done
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** `names`, with `current` too when it is a name not among them (a saved rule's, or before the list is read). */
function withCurrent(names: readonly string[], current: string): string[] {
  return current && current !== "*" && !names.includes(current) ? [current, ...names] : [...names];
}

/** The time zones the browser knows, for the time zone field's suggestions. */
const ZONES: readonly string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

/** The fields of one kind of rule: a number, the values it never takes, or quiet dates. */
function KindFields({
  draft,
  set,
  arg,
  reads,
  ids,
}: {
  draft: RuleDraft;
  set: (change: Partial<RuleDraft>) => void;
  arg: ToolArg | undefined;
  reads: readonly ToolInfo[];
  ids: string;
}) {
  const zone = (
    <label className="rule-field">
      <span>Time zone</span>
      <input
        value={draft.tz}
        onChange={(e) => set({ tz: e.target.value })}
        placeholder="UTC"
        list={`${ids}-zones`}
        autoComplete="off"
        spellCheck={false}
      />
      <datalist id={`${ids}-zones`}>
        {ZONES.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <small>Its days are in this zone; UTC when empty.</small>
    </label>
  );
  switch (draft.kind) {
    case "min":
    case "max":
    case "callsPerDay":
      return (
        <div className="rule-editor-row">
          <label className="rule-field">
            <span>{draft.kind === "callsPerDay" ? "Calls a day" : draft.kind === "min" ? "At least" : "At most"}</span>
            <input
              type="number"
              inputMode="decimal"
              step={draft.kind === "callsPerDay" ? 1 : "any"}
              min={draft.kind === "callsPerDay" ? 0 : undefined}
              value={draft.number}
              onChange={(e) => set({ number: e.target.value })}
            />
            {draft.kind === "callsPerDay" && (
              <small className="rule-hint">
                Counted over every chat, but exact only within one: two chats calling at the same moment can both take the last call left.
              </small>
            )}
          </label>
          {draft.kind === "callsPerDay" && zone}
        </div>
      );
    case "maxChange":
      return (
        <>
          <div className="rule-editor-row">
            <label className="rule-field">
              <span>Changes at most</span>
              <input type="number" inputMode="decimal" step="any" min={0} value={draft.number} onChange={(e) => set({ number: e.target.value })} />
            </label>
            <label className="rule-check">
              <input type="checkbox" checked={draft.percent} onChange={(e) => set({ percent: e.target.checked })} />
              as a percentage of the current value
            </label>
          </div>
          <fieldset className="rule-current">
            <legend>Where the current value is read</legend>
            <div className="rule-editor-row">
              <label className="rule-field">
                <span>Read with</span>
                <select value={draft.currentTool} onChange={(e) => set({ currentTool: e.target.value })}>
                  <option value="">Pick a tool that only reads</option>
                  {withCurrent(
                    reads.map((tool) => tool.name),
                    draft.currentTool,
                  ).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="rule-field">
                <span>Path in its result</span>
                <input
                  value={draft.currentPath}
                  onChange={(e) => set({ currentPath: e.target.value })}
                  placeholder="data.amount"
                  spellCheck={false}
                />
              </label>
            </div>
            <label className="rule-field">
              <span>Its input, as JSON</span>
              <textarea
                className="code"
                rows={3}
                value={draft.currentInput}
                onChange={(e) => set({ currentInput: e.target.value })}
                placeholder={'{"id": "{{input.id}}"}'}
                spellCheck={false}
              />
              <small>{"{{input.x}}"} fills in from the call's own input.</small>
            </label>
          </fieldset>
        </>
      );
    case "never":
      return <NeverValues draft={draft} set={set} arg={arg} />;
    case "quietDates":
      return (
        <>
          <QuietRanges ranges={draft.ranges} onChange={(ranges) => set({ ranges })} />
          <div className="rule-editor-row">{zone}</div>
        </>
      );
    default:
      return null;
  }
}

/**
 * A never rule's values, one a line (* for any characters), with the argument's own choices to pick from when it has
 * them; a yes-or-no argument's only as its two choices (typed text would never match it).
 */
function NeverValues({ draft, set, arg }: { draft: RuleDraft; set: (change: Partial<RuleDraft>) => void; arg: ToolArg | undefined }) {
  const lines = draft.values
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const toggle = (value: string) => set({ values: (lines.includes(value) ? lines.filter((line) => line !== value) : [...lines, value]).join("\n") });
  const boolean = arg?.type === "boolean";
  // A saved rule with other values (typed before, or the argument was text then) keeps its text to fix them in.
  const yesNo = boolean && lines.every((line) => line === "true" || line === "false");
  const choices = boolean ? ["true", "false"] : arg?.values;
  return (
    <div className="rule-field">
      {yesNo ? (
        <span>Never these values</span>
      ) : (
        <label className="rule-field">
          <span>Never these values</span>
          <textarea
            rows={3}
            value={draft.values}
            onChange={(e) => set({ values: e.target.value })}
            placeholder={"*@example.com\narchived"}
            spellCheck={false}
          />
          <small>One a line; * stands for any characters. Text matches ignoring case.</small>
        </label>
      )}
      {choices && (
        <div className="chips rule-choices" role="group" aria-label="Its choices">
          {choices.map((value) => (
            <button
              key={String(value)}
              type="button"
              className="chip"
              aria-pressed={lines.includes(String(value))}
              onClick={() => toggle(String(value))}
            >
              {String(value)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Quiet dates: day ranges, both ends included, every year (MM-DD) or once (a date). */
function QuietRanges({ ranges, onChange }: { ranges: readonly RangeDraft[]; onChange: (ranges: RangeDraft[]) => void }) {
  const year = new Date().getFullYear();
  const change = (index: number, range: RangeDraft) => onChange(ranges.map((each, i) => (i === index ? range : each)));
  // Switching keeps the days: a date loses its year, a month and day gets this one.
  const switchTo = (range: RangeDraft, yearly: boolean): RangeDraft => {
    const convert = (day: string) => (yearly ? (day.length === 10 ? day.slice(5) : day) : day.length === 5 ? `${year}-${day}` : day);
    return { yearly, from: convert(range.from), to: convert(range.to) };
  };
  return (
    <fieldset className="rule-ranges">
      <legend>Quiet dates</legend>
      {ranges.map((range, index) => (
        <div key={index} className="rule-range">
          <select
            value={range.yearly ? "yearly" : "once"}
            onChange={(e) => change(index, switchTo(range, e.target.value === "yearly"))}
            aria-label="How often"
          >
            <option value="yearly">Every year</option>
            <option value="once">Once</option>
          </select>
          {range.yearly ? (
            <>
              <input
                value={range.from}
                onChange={(e) => change(index, { ...range, from: e.target.value })}
                placeholder="12-24"
                aria-label="From (MM-DD)"
                size={6}
              />
              <span aria-hidden="true">to</span>
              <input
                value={range.to}
                onChange={(e) => change(index, { ...range, to: e.target.value })}
                placeholder="12-26"
                aria-label="To (MM-DD)"
                size={6}
              />
            </>
          ) : (
            <>
              <input type="date" value={range.from} onChange={(e) => change(index, { ...range, from: e.target.value })} aria-label="From" />
              <span aria-hidden="true">to</span>
              <input type="date" value={range.to} onChange={(e) => change(index, { ...range, to: e.target.value })} aria-label="To" />
            </>
          )}
          {ranges.length > 1 && (
            <button
              type="button"
              className="icon-button"
              onClick={() => onChange(ranges.filter((_, i) => i !== index))}
              aria-label="Remove this range"
              title="Remove this range"
            >
              ×
            </button>
          )}
        </div>
      ))}
      {ranges.length < MAX_QUIET_RANGES && (
        <button type="button" className="link-button" onClick={() => onChange([...ranges, blankRange()])}>
          Add a range
        </button>
      )}
      <small>Every year: month and day, as 12-24. A range may wrap the year, as 12-30 to 01-02.</small>
    </fieldset>
  );
}
