// The dialogue condition language (topic2sequence entry conditions, dialogue_functions), from the
// research note dialogue.md: AND / OR / & / | / !, comparisons, a little arithmetic, numbers and
// quoted strings, function calls with an optional actor index (`GetActorMoney()[0]`,
// `HasSoulTag('x')['tailor']`), and bare identifiers naming a dialogue_functions entry. Values
// are numbers or strings; true is 1, false 0, and a condition holds when non-zero. An error
// (division by zero, an actor index outside the participants, a name nobody has) fails the
// whole condition.

export type CondValue = number | string;

type Node =
  | { k: "lit"; v: CondValue }
  | { k: "call"; name: string; args: Node[]; actor?: number | string }
  | { k: "ref"; name: string }
  | { k: "not"; e: Node }
  | { k: "neg"; e: Node }
  | { k: "bin"; op: string; a: Node; b: Node };

/** What conditions read from the game: function values for an actor (participant index, or -1 for a named entity). */
export interface ConditionHost {
  /**
   * Call a condition function. `actor` is the participant index the call acts on (0 unless
   * indexed), or a name when indexed by name. Return undefined for a function the host doesn't know
   * (it counts as 0 and is reported once).
   */
  call(name: string, args: CondValue[], actor: number | string): CondValue | undefined;
  /** a named condition's expression (dialogue_functions) */
  named(name: string): string | undefined;
  /** report something unsupported once */
  report?(what: string): void;
}

class CondError extends Error {}

const KEYWORDS: Record<string, string> = { and: "&", or: "|" };

function tokenize(text: string): string[] {
  // Lua-style comments run to the end of the line (a few conditions keep an old clause after "--")
  const src = text.replace(/--[^\n]*/g, "");
  const out: string[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([A-Za-z_][\w.]*)|(&&|\|\||==|!=|~=|<=|>=|[&|!<>=+\-*/%(),[\]]))/y;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1] !== undefined || m[2] !== undefined) out.push(m[1] ?? m[2]);
    else if (m[3] !== undefined) out.push(KEYWORDS[m[3].toLowerCase()] ?? m[3]);
    else if (m[4] !== undefined) out.push(m[4] === "&&" ? "&" : m[4] === "||" ? "|" : m[4] === "~=" ? "!=" : m[4]);
    if (src.slice(re.lastIndex).trim() === "") break;
  }
  if (src.slice(re.lastIndex).trim() !== "") throw new CondError(`unexpected "${src.slice(re.lastIndex).trim().slice(0, 12)}"`);
  return out;
}

function parse(src: string): Node {
  const t = tokenize(src);
  let i = 0;
  const peek = () => t[i];
  const eat = (x?: string) => { const v = t[i++]; if (x !== undefined && v !== x) throw new CondError(`expected ${x}, got ${v ?? "end"}`); return v; };
  const or = (): Node => { let a = and(); while (peek() === "|") { eat(); a = { k: "bin", op: "|", a, b: and() }; } return a; };
  const and = (): Node => { let a = not(); while (peek() === "&") { eat(); a = { k: "bin", op: "&", a, b: not() }; } return a; };
  const not = (): Node => (peek() === "!" ? (eat(), { k: "not", e: not() }) : cmp());
  const cmp = (): Node => {
    const a = add();
    const op = peek();
    if (op === "==" || op === "!=" || op === "<" || op === ">" || op === "<=" || op === ">=" || op === "=") { eat(); return { k: "bin", op: op === "=" ? "==" : op, a, b: add() }; }
    return a;
  };
  const add = (): Node => { let a = mul(); while (peek() === "+" || peek() === "-") { const op = eat(); a = { k: "bin", op, a, b: mul() }; } return a; };
  const mul = (): Node => { let a = unary(); while (peek() === "*" || peek() === "/" || peek() === "%") { const op = eat(); a = { k: "bin", op, a, b: unary() }; } return a; };
  const unary = (): Node => (peek() === "-" ? (eat(), { k: "neg", e: unary() }) : primary());
  const primary = (): Node => {
    const v = eat();
    if (v === undefined) throw new CondError("unexpected end");
    if (v === "(") { const e = or(); eat(")"); return e; }
    if (/^\d/.test(v)) return { k: "lit", v: Number(v) };
    if (v[0] === "'" || v[0] === '"') return { k: "lit", v: v.slice(1, -1).replace(/\\(.)/g, "$1") };
    if (/^[A-Za-z_]/.test(v)) {
      if (v === "true" || v === "false") return { k: "lit", v: v === "true" ? 1 : 0 };
      if (peek() !== "(") return { k: "ref", name: v };
      eat("(");
      const args: Node[] = [];
      if (peek() !== ")") { args.push(or()); while (peek() === ",") { eat(); args.push(or()); } }
      eat(")");
      let actor: number | string | undefined;
      if (peek() === "[") {
        eat();
        const a = eat();
        actor = a[0] === "'" || a[0] === '"' ? a.slice(1, -1) : Number(a);
        eat("]");
      }
      return { k: "call", name: v, args, actor };
    }
    throw new CondError(`unexpected ${v}`);
  };
  const e = or();
  if (i < t.length) throw new CondError(`unexpected ${t[i]}`);
  return e;
}

const cache = new Map<string, Node | CondError>();

function compiled(src: string): Node {
  let n = cache.get(src);
  if (!n) {
    try { n = parse(src); } catch (e) { n = e instanceof CondError ? e : new CondError(String(e)); }
    cache.set(src, n);
  }
  if (n instanceof CondError) throw n;
  return n;
}

const num = (v: CondValue) => (typeof v === "number" ? v : Number(v) || 0);
const truth = (v: CondValue) => (typeof v === "number" ? v !== 0 : v !== "" && v !== "0");

function run(n: Node, host: ConditionHost, depth: number): CondValue {
  switch (n.k) {
    case "lit": return n.v;
    case "not": return truth(run(n.e, host, depth)) ? 0 : 1;
    case "neg": return -num(run(n.e, host, depth));
    case "ref": {
      const src = host.named(n.name);
      if (src === undefined) { host.report?.(`condition name ${n.name}`); return 0; }
      if (depth > 32) throw new CondError("named conditions nest too deeply");
      return src.trim() ? run(compiled(src), host, depth + 1) : 1;
    }
    case "call": {
      const args = n.args.map((a) => run(a, host, depth));
      const v = host.call(n.name, args, n.actor ?? 0);
      if (v === undefined) { host.report?.(`condition function ${n.name}`); return 0; }
      return v;
    }
    case "bin": {
      if (n.op === "&") return truth(run(n.a, host, depth)) && truth(run(n.b, host, depth)) ? 1 : 0;
      if (n.op === "|") return truth(run(n.a, host, depth)) || truth(run(n.b, host, depth)) ? 1 : 0;
      const a = run(n.a, host, depth), b = run(n.b, host, depth);
      switch (n.op) {
        case "==": return (typeof a === "string" || typeof b === "string" ? String(a) === String(b) : a === b) ? 1 : 0;
        case "!=": return (typeof a === "string" || typeof b === "string" ? String(a) !== String(b) : a !== b) ? 1 : 0;
        case "<": return num(a) < num(b) ? 1 : 0;
        case ">": return num(a) > num(b) ? 1 : 0;
        case "<=": return num(a) <= num(b) ? 1 : 0;
        case ">=": return num(a) >= num(b) ? 1 : 0;
        case "+": return num(a) + num(b);
        case "-": return num(a) - num(b);
        case "*": return num(a) * num(b);
        case "/": if (num(b) === 0) throw new CondError("division by zero"); return num(a) / num(b);
        case "%": if (num(b) === 0) throw new CondError("modulo zero"); return num(a) % num(b);
      }
    }
  }
  throw new CondError("bad node");
}

/** Thrown by a ConditionHost.call to fail the whole condition (an actor that isn't there). */
export class ConditionFails extends CondError {}

/**
 * Whether a condition holds. `empty` is the value of an empty condition (true at follow-up topics,
 * false at entry points). A condition that doesn't parse or fails while evaluating doesn't hold.
 */
export function holds(src: string, host: ConditionHost, empty = true): boolean {
  // a condition that is all comment ("--1") is empty
  if (!src.replace(/--[^\n]*/g, "").trim()) return empty;
  try {
    return truth(run(compiled(src), host, 0));
  } catch (e) {
    if (!(e instanceof CondError)) throw e;
    if (!(e instanceof ConditionFails)) host.report?.(`condition "${src.slice(0, 60)}": ${e.message}`);
    return false;
  }
}

export type CondNode = Node;

/** A condition's syntax tree, for analysing it without a game (throws if it doesn't parse). */
export function parseCondition(src: string): CondNode {
  return compiled(src);
}

/** Parse a condition without evaluating it (tests: every condition in the tables parses). */
export function parses(src: string): string | null {
  if (!src.replace(/--[^\n]*/g, "").trim()) return null;
  try { compiled(src); return null; } catch (e) { return (e as Error).message; }
}
