// The conditions of an agent's workflow ("Only if", "If", a watch's "when"): small expressions over the results of
// earlier steps, such as `signups.weekly vs lastYear < -5%` or `len(alerts) > 0 and not quiet`. They are parsed here
// and evaluated in code, never with eval, so a run with nothing to report never wakes the model. The app knows nothing
// of what the values mean: they are whatever the servers' tools returned, as JSON.
//
//   or / and / not            logic, lowest first
//   == != < <= > >= (= is ==) comparisons: numbers by value (numeric text counts as a number), text by order
//   a vs b                    change of a against b, as a fraction: (a - b) / |b|; 5% is 0.05
//   + - * /                   arithmetic; + also joins text
//   a.b, a[0], a["key"]       paths into JSON results; a missing step is null
//   abs min max round len count sum avg first last exists contains lower upper number change
//
// Text is in "double" or 'single' quotes; true, false and null are themselves.

/** A condition that cannot be parsed or evaluated, with what is wrong. */
export class ConditionError extends Error {}

/** A JSON value, as a step's result or an expression's. */
export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };

type Node =
  | { kind: "literal"; value: Value }
  | { kind: "name"; name: string }
  | { kind: "member"; object: Node; key: Node }
  | { kind: "call"; name: string; args: Node[] }
  | { kind: "unary"; op: "-" | "not"; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node };

type Token = { kind: "number" | "string" | "name" | "key" | "op" | "end"; text: string; value?: Value; at: number };

/** The longest a condition may be, as checkAgent allows it. */
export const MAX_CONDITION = 500;
const MAX_DEPTH = 40;
const WORDS = new Set(["and", "or", "not", "vs", "true", "false", "null"]);
const OPERATORS = ["==", "!=", "<=", ">=", "<", ">", "=", "+", "-", "*", "/", "(", ")", "[", "]", ".", ","];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    const at = i;
    // After ".", a key as written: digits (an index: a.1.2 is a[1][2], never a[1.2]) or a name in its own case (a.True).
    const previous = tokens[tokens.length - 1];
    const key = previous?.kind === "op" && previous.text === "." ? /^(?:\d+|[A-Za-z_$][A-Za-z0-9_$]*)/.exec(source.slice(i)) : null;
    if (key) {
      tokens.push({ kind: "key", text: key[0], at });
      i += key[0].length;
      continue;
    }
    const number = /^(\d+(?:\.\d+)?)(?:[eE][+-]?\d+)?(%?)/.exec(source.slice(i));
    if (number) {
      const value = Number(number[0].replace("%", ""));
      tokens.push({ kind: "number", text: number[0], value: number[2] ? value / 100 : value, at });
      i += number[0].length;
      continue;
    }
    if (char === '"' || char === "'") {
      let text = "";
      i++;
      while (i < source.length && source[i] !== char) {
        if (source[i] === "\\" && i + 1 < source.length) i++;
        text += source[i++];
      }
      if (i >= source.length) throw new ConditionError(`Text that starts at ${at + 1} has no closing quote.`);
      i++;
      tokens.push({ kind: "string", text, value: text, at });
      continue;
    }
    const name = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(i));
    if (name) {
      const word = name[0];
      const lower = word.toLowerCase();
      if (WORDS.has(lower)) tokens.push({ kind: lower === "true" || lower === "false" || lower === "null" ? "name" : "op", text: lower, at });
      else tokens.push({ kind: "name", text: word, at });
      i += word.length;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (!op) throw new ConditionError(`"${char}" at ${at + 1} is not part of a condition.`);
    tokens.push({ kind: "op", text: op === "=" ? "==" : op, at });
    i += op.length;
  }
  tokens.push({ kind: "end", text: "", at: source.length });
  return tokens;
}

class Parser {
  #i = 0;
  #depth = 0;
  constructor(readonly tokens: Token[]) {}

  get #next(): Token {
    return this.tokens[this.#i];
  }

  #take(text?: string): Token | undefined {
    const token = this.#next;
    if (token.kind === "end") return undefined;
    if (text !== undefined && (token.kind !== "op" || token.text !== text)) return undefined;
    this.#i++;
    return token;
  }

  #expect(text: string): void {
    if (!this.#take(text)) throw new ConditionError(`Expected "${text}" at ${this.#next.at + 1}${this.#next.text ? `, found "${this.#next.text}"` : ""}.`);
  }

  #deeper<T>(parse: () => T): T {
    if (++this.#depth > MAX_DEPTH) throw new ConditionError("The condition nests too deep.");
    try {
      return parse();
    } finally {
      this.#depth--;
    }
  }

  parse(): Node {
    const node = this.#or();
    if (this.#next.kind !== "end") throw new ConditionError(`Unexpected "${this.#next.text}" at ${this.#next.at + 1}.`);
    return node;
  }

  #binary(ops: readonly string[], operand: () => Node, once = false): Node {
    let left = operand();
    while (this.#next.kind === "op" && ops.includes(this.#next.text)) {
      const op = this.#take()!.text;
      left = { kind: "binary", op, left, right: operand() };
      if (once) break;
    }
    return left;
  }

  #or = (): Node => this.#binary(["or"], this.#and);
  #and = (): Node => this.#binary(["and"], this.#not);
  #not = (): Node => (this.#take("not") ? { kind: "unary", op: "not", operand: this.#deeper(this.#not) } : this.#compare());
  #compare = (): Node => this.#binary(["==", "!=", "<", "<=", ">", ">="], this.#vs, true);
  #vs = (): Node => this.#binary(["vs"], this.#add, true);
  #add = (): Node => this.#binary(["+", "-"], this.#mul);
  #mul = (): Node => this.#binary(["*", "/"], this.#unary);
  #unary = (): Node => (this.#take("-") ? { kind: "unary", op: "-", operand: this.#deeper(this.#unary) } : this.#postfix());

  #postfix(): Node {
    let node = this.#primary();
    for (;;) {
      if (this.#take(".")) {
        const key = this.#next;
        if (key.kind !== "key") throw new ConditionError(`Expected a name after "." at ${key.at + 1}.`);
        this.#i++;
        // a.0 is a[0].
        node = { kind: "member", object: node, key: { kind: "literal", value: /^\d/.test(key.text) ? Number(key.text) : key.text } };
      } else if (this.#take("[")) {
        const key = this.#deeper(this.#or);
        this.#expect("]");
        node = { kind: "member", object: node, key };
      } else return node;
    }
  }

  #primary(): Node {
    const token = this.#next;
    if (token.kind === "number" || token.kind === "string") {
      this.#i++;
      return { kind: "literal", value: token.value! };
    }
    if (token.kind === "name") {
      this.#i++;
      if (token.text === "true" || token.text === "false") return { kind: "literal", value: token.text === "true" };
      if (token.text === "null") return { kind: "literal", value: null };
      if (this.#take("(")) {
        const name = token.text.toLowerCase();
        if (!Object.hasOwn(FUNCTIONS, name)) throw new ConditionError(`There is no function "${token.text}"; there are ${Object.keys(FUNCTIONS).join(", ")}.`);
        const args: Node[] = [];
        if (!this.#take(")")) {
          do args.push(this.#deeper(this.#or));
          while (this.#take(","));
          this.#expect(")");
        }
        return { kind: "call", name, args };
      }
      return { kind: "name", name: token.text };
    }
    if (this.#take("(")) {
      const node = this.#deeper(this.#or);
      this.#expect(")");
      return node;
    }
    throw new ConditionError(token.kind === "end" ? "The condition ends too soon." : `Unexpected "${token.text}" at ${token.at + 1}.`);
  }
}

/** A condition parsed, ready to evaluate as often as needed. Throws a ConditionError with what is wrong. */
export function parseCondition(source: string): Node {
  if (typeof source !== "string" || !source.trim()) throw new ConditionError("A condition is empty.");
  if (source.length > MAX_CONDITION) throw new ConditionError(`A condition is at most ${MAX_CONDITION} characters.`);
  return new Parser(tokenize(source)).parse();
}

/** What is wrong with a condition, or null when it parses. */
export function conditionProblem(source: string): string | null {
  try {
    parseCondition(source);
    return null;
  } catch (error) {
    if (error instanceof ConditionError) return error.message;
    throw error;
  }
}

/** The names a condition reads at its top level ("signups" of `signups.weekly > 3`): what earlier steps must provide. */
export function conditionNames(source: string): string[] {
  const names = new Set<string>();
  const walk = (node: Node): void => {
    if (node.kind === "name") names.add(node.name);
    else if (node.kind === "member") {
      walk(node.object);
      walk(node.key);
    } else if (node.kind === "call") node.args.forEach(walk);
    else if (node.kind === "unary") walk(node.operand);
    else if (node.kind === "binary") {
      walk(node.left);
      walk(node.right);
    }
  };
  walk(parseCondition(source));
  return [...names];
}

/** A name of a path, for messages: `signups.weekly`. */
function describe(node: Node): string {
  if (node.kind === "name") return node.name;
  if (node.kind === "member") {
    const key = node.key.kind === "literal" ? node.key.value : "[…]";
    return typeof key === "number" ? `${describe(node.object)}[${key}]` : `${describe(node.object)}.${String(key)}`;
  }
  if (node.kind === "call") return `${node.name}(…)`;
  if (node.kind === "literal") return JSON.stringify(node.value);
  return "the value";
}

/** A value as a number, when it is one or numeric text ("1,234.5" and "12%" too); else undefined. */
function numeric(value: Value): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/,/g, "");
  const percent = text.endsWith("%");
  const number = Number(percent ? text.slice(0, -1) : text);
  if (!text || Number.isNaN(number)) return undefined;
  return percent ? number / 100 : number;
}

function needNumber(value: Value, node: Node): number {
  const number = numeric(value);
  if (number === undefined) {
    throw new ConditionError(value === null ? `${describe(node)} is missing.` : `${describe(node)} is not a number (it is ${preview(value)}).`);
  }
  return number;
}

function preview(value: Value): string {
  const json = JSON.stringify(value);
  return json.length > 40 ? `${json.slice(0, 39)}…` : json;
}

/** Whether a value counts as true: not null, false, 0, "", or an empty list or object. */
export function truthy(value: Value): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function equal(a: Value, b: Value): boolean {
  const x = numeric(a);
  const y = numeric(b);
  if (x !== undefined && y !== undefined && (typeof a === "number" || typeof b === "number")) return x === y;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(op: string, a: Value, b: Value, left: Node, right: Node): boolean {
  if (op === "==") return equal(a, b);
  if (op === "!=") return !equal(a, b);
  let order: number;
  if (typeof a === "string" && typeof b === "string" && (numeric(a) === undefined || numeric(b) === undefined)) order = a < b ? -1 : a > b ? 1 : 0;
  else order = needNumber(a, left) - needNumber(b, right);
  return op === "<" ? order < 0 : op === "<=" ? order <= 0 : op === ">" ? order > 0 : order >= 0;
}

/** The numbers of a list, or of one field (a path) of each of its items: sum(regions, "signups"). */
function numbersOf(args: Value[], name: string): number[] {
  const [list, path] = args;
  if (!Array.isArray(list)) throw new ConditionError(`${name}() takes a list.`);
  const items = typeof path === "string" ? list.map((item) => path.split(".").reduce<Value>((at, key) => member(at, key), item)) : list;
  return items.flatMap((item) => (numeric(item) === undefined ? [] : [numeric(item)!]));
}

const FUNCTIONS: Record<string, (args: Value[], nodes: Node[]) => Value> = {
  abs: ([x], [node]) => Math.abs(needNumber(x ?? null, node)),
  min: (args, nodes) => (Array.isArray(args[0]) && args.length === 1 ? Math.min(...numbersOf(args, "min")) : Math.min(...args.map((x, i) => needNumber(x, nodes[i])))),
  max: (args, nodes) => (Array.isArray(args[0]) && args.length === 1 ? Math.max(...numbersOf(args, "max")) : Math.max(...args.map((x, i) => needNumber(x, nodes[i])))),
  round: ([x, digits], nodes) => {
    const scale = 10 ** (digits === undefined ? 0 : needNumber(digits, nodes[1]));
    return Math.round(needNumber(x ?? null, nodes[0]) * scale) / scale;
  },
  len: ([x]) => (Array.isArray(x) || typeof x === "string" ? x.length : x && typeof x === "object" ? Object.keys(x).length : 0),
  count: ([x]) => (Array.isArray(x) ? x.length : x && typeof x === "object" ? Object.keys(x).length : x === null ? 0 : 1),
  sum: (args) => numbersOf(args, "sum").reduce((a, b) => a + b, 0),
  avg: (args) => {
    const numbers = numbersOf(args, "avg");
    if (!numbers.length) throw new ConditionError("avg() of an empty list.");
    return numbers.reduce((a, b) => a + b, 0) / numbers.length;
  },
  first: ([x]) => (Array.isArray(x) ? (x[0] ?? null) : null),
  last: ([x]) => (Array.isArray(x) ? (x[x.length - 1] ?? null) : null),
  exists: ([x]) => x !== null && x !== undefined,
  contains: ([haystack, needle]) => {
    if (typeof haystack === "string") return haystack.toLowerCase().includes(String(needle ?? "").toLowerCase());
    if (Array.isArray(haystack)) return haystack.some((item) => equal(item, needle ?? null));
    if (haystack && typeof haystack === "object" && typeof needle === "string") return Object.hasOwn(haystack, needle);
    return false;
  },
  lower: ([x]) => (typeof x === "string" ? x.toLowerCase() : x),
  upper: ([x]) => (typeof x === "string" ? x.toUpperCase() : x),
  number: ([x]) => numeric(x ?? null) ?? null,
  change: ([a, b], [left, right]) => change(needNumber(a ?? null, left), needNumber(b ?? null, right ?? left)),
};

/** The condition language in one paragraph, as the models that write conditions read it (the compiler, agent_propose). */
export const CONDITIONS_HELP =
  'Conditions are small expressions over the results by their names: numbers, "text", comparisons (< <= > >= == !=), and/or/not, + - * /, ' +
  "paths (sales.total, rows[0].value), a vs b (the change of a against b as a fraction), percentages (5% is 0.05), and the functions " +
  `${Object.keys(FUNCTIONS).join(", ")}. Never free text: a condition the language does not parse is refused.`;

function change(now: number, before: number): number {
  if (before === 0) throw new ConditionError("A change against 0 is not a number.");
  return (now - before) / Math.abs(before);
}

/** A key of an object, or an index of a list (negative from the end); null when it has none. */
function member(object: Value, key: Value): Value {
  if (object === null || typeof object !== "object") return null;
  if (Array.isArray(object)) {
    const index = numeric(key);
    if (index === undefined || !Number.isInteger(index)) return null;
    return object[index < 0 ? object.length + index : index] ?? null;
  }
  const name = String(key);
  return Object.hasOwn(object, name) ? object[name] : null;
}

function evaluateNode(node: Node, scope: Readonly<Record<string, Value>>): Value {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "name":
      return Object.hasOwn(scope, node.name) ? scope[node.name] : null;
    case "member":
      return member(evaluateNode(node.object, scope), evaluateNode(node.key, scope));
    case "call":
      return FUNCTIONS[node.name](
        node.args.map((arg) => evaluateNode(arg, scope)),
        node.args,
      );
    case "unary": {
      const value = evaluateNode(node.operand, scope);
      return node.op === "not" ? !truthy(value) : -needNumber(value, node.operand);
    }
    case "binary": {
      if (node.op === "and") return truthy(evaluateNode(node.left, scope)) && truthy(evaluateNode(node.right, scope));
      if (node.op === "or") return truthy(evaluateNode(node.left, scope)) || truthy(evaluateNode(node.right, scope));
      const a = evaluateNode(node.left, scope);
      const b = evaluateNode(node.right, scope);
      switch (node.op) {
        case "+":
          if (typeof a === "string" || typeof b === "string") return `${a ?? ""}${b ?? ""}`;
          return needNumber(a, node.left) + needNumber(b, node.right);
        case "-":
          return needNumber(a, node.left) - needNumber(b, node.right);
        case "*":
          return needNumber(a, node.left) * needNumber(b, node.right);
        case "/": {
          const divisor = needNumber(b, node.right);
          if (divisor === 0) throw new ConditionError(`${describe(node.right)} is 0: cannot divide by it.`);
          return needNumber(a, node.left) / divisor;
        }
        case "vs":
          return change(needNumber(a, node.left), needNumber(b, node.right));
        default:
          return compare(node.op, a, b, node.left, node.right);
      }
    }
  }
}

/** A condition's value over `scope` (the results of earlier steps, by name). Throws a ConditionError. */
export function evaluate(condition: string | Node, scope: Readonly<Record<string, Value>>): Value {
  const value = evaluateNode(typeof condition === "string" ? parseCondition(condition) : condition, scope);
  if (typeof value === "number" && !Number.isFinite(value)) throw new ConditionError("The condition comes to a number too large to compare.");
  return value;
}

/** Whether a condition holds over `scope`. Throws a ConditionError. */
export function holds(condition: string | Node, scope: Readonly<Record<string, Value>>): boolean {
  return truthy(evaluate(condition, scope));
}
