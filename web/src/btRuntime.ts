// Behaviour-tree interpreter (tick-based) for the trees parsed by bt.ts.
//
// Warhorse's executor is event-driven (docs/GAMELOGIC.md "Runtime
// architecture"); this is a standard tick interpreter whose node semantics
// follow the node names, their properties and how the shipped trees use them.
// Places where the semantics are a guess are marked ASSUMPTION; they are the
// candidates for checking against the game's code.
//
// World-facing nodes (GraphSearch, messages, quests, animation, …) and Lua go
// through the host: unknown tags are reported and, by default, succeed.

import { parseExpr, quoted, isTextProp, type BtNode, type BtTree, type BtVariable, type Expr } from "./bt.ts";

export type Status = "success" | "failure" | "running";
export type Value = null | boolean | number | string | Value[] | { [k: string]: Value };

/** Variable scope: a tree instance's own variables, falling back to the including tree's. */
export class Scope {
  readonly vars = new Map<string, Value>();
  readonly decls = new Map<string, BtVariable>();
  readonly parent: Scope | null;
  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }
  private owner(name: string): Scope | null {
    for (let s: Scope | null = this; s; s = s.parent) if (s.vars.has(name)) return s;
    return null;
  }
  get(name: string): Value | undefined {
    return this.owner(name)?.vars.get(name);
  }
  set(name: string, v: Value): void {
    (this.owner(name) ?? this).vars.set(name, v);
  }
  declare(v: BtVariable): void {
    this.decls.set(v.name, v);
    this.vars.set(v.name, initialValue(v));
  }
  /** Reset a variable to its declared initial value (VarOperation Reinit). */
  reinit(name: string): void {
    for (let s: Scope | null = this; s; s = s.parent) {
      const d = s.decls.get(name);
      if (d) { s.vars.set(name, initialValue(d)); return; }
    }
    this.set(name, null);
  }
}

/** Declared initial value: scalars from `values`; struct types start as {}; wuids as null; arrays []. */
export function initialValue(v: BtVariable): Value {
  const scalar = (s: string): Value => {
    switch (v.type) {
      case "_bool": return s === "true" || s === "1";
      case "_int": case "_float": case "_double": return s === "" ? 0 : Number(s);
      case "_string": return s;
      default:
        // ASSUMPTION: namespaced value types (common:wuid, common:vec3, dialog:state, …) start empty;
        // other types are structs (workplace_params, nextBehavior, …) filled field by field
        return v.type.includes(":") ? (s === "" ? null : s) : {};
    }
  };
  if (v.form === "array") return v.values === "" ? [] : v.values.split(",").map((x) => scalar(x.trim()));
  return scalar(v.values);
}

/** Host services: clocks, globals ($__player, $__area, …), functions, Lua, world-facing nodes. */
export interface Host {
  /** game time in seconds (KCD's clock, 15× real time) */
  gameTime(): number;
  /** real (world) time in seconds */
  realTime(): number;
  random(): number;
  /** resolve an IncludeTree target (file relative to Libs/AI, tree name) */
  tree(file: string, name: string): BtTree | undefined;
  /** run Lua; `scope` gives `data.<var>` access */
  lua?(code: string, scope: Scope): void;
  /** a function call in an expression, e.g. alias('x') */
  call?(name: string, args: Value[]): Value | undefined;
  /** a node the interpreter does not implement: return a task, or undefined to use the default */
  node?(n: BtNode, ctx: Context): Task | undefined;
  /** called once per unsupported tag/property problem */
  report?(what: string): void;
}

export interface Context {
  host: Host;
  scope: Scope;
  eval(prop: string | undefined, fallback?: Value): Value;
}

export interface Task {
  tick(): Status;
  /** stop a running task (parent finished or aborted it) */
  abort(): void;
}

// ---- expressions ----

const exprCache = new Map<string, Expr | Error>();

function compile(src: string): Expr {
  let e = exprCache.get(src);
  if (!e) {
    try { e = parseExpr(src); } catch (err) { e = err as Error; }
    exprCache.set(src, e);
  }
  if (e instanceof Error) throw e;
  return e;
}

const truthy = (v: Value | undefined) => v !== null && v !== undefined && v !== false && v !== 0;
// durations are often stored as strings ('10s', '1m 30s'): numeric contexts read them as seconds
const DUR_UNIT: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };
function seconds(s: string): number | null {
  const parts = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\b/g)];
  if (!parts.length || parts.map((m) => m[0]).join("").replace(/\s/g, "") !== s.replace(/\s/g, "")) return null;
  return parts.reduce((t, m) => t + Number(m[1]) * DUR_UNIT[m[2]], 0);
}
const num = (v: Value | undefined): number => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return Number(v);
  if (typeof v === "string" && v.trim() !== "") return isNaN(Number(v)) ? seconds(v.trim()) ?? 0 : Number(v);
  return 0;
};
const eq = (a: Value | undefined, b: Value | undefined) => (a ?? null) === (b ?? null) || (typeof a !== "object" && typeof b !== "object" && a != null && b != null && String(a) === String(b));

function lookup(scope: Scope, path: string[], host: Host): Value | undefined {
  const [head, ...rest] = path;
  let v: Value | undefined;
  if (head === "__null") v = null;
  else if (head.startsWith("enum:")) return [head.slice(5), ...rest].join(".");
  else v = scope.get(head);
  for (const f of rest) {
    if (v === null || v === undefined || typeof v !== "object") return undefined;
    v = Array.isArray(v) ? (f === "size" ? v.length : v[Number(f)]) : (v as Record<string, Value>)[f];
  }
  void host;
  return v;
}

function assignPath(scope: Scope, path: string[], v: Value): void {
  if (path.length === 1) { scope.set(path[0], v); return; }
  let obj = scope.get(path[0]);
  if (obj === null || obj === undefined || typeof obj !== "object") { obj = {}; scope.set(path[0], obj); }
  for (let i = 1; i < path.length - 1; i++) {
    const o = obj as Record<string, Value>;
    if (o[path[i]] === null || typeof o[path[i]] !== "object") o[path[i]] = {};
    obj = o[path[i]];
  }
  (obj as Record<string, Value>)[path[path.length - 1]] = v;
}

export function evaluate(e: Expr, scope: Scope, host: Host): Value | undefined {
  switch (e.k) {
    case "num": case "dur": return e.v;
    case "str": return e.v;
    case "bool": return e.v;
    case "name": return e.v; // bare identifiers are enum values / names
    case "var": return lookup(scope, e.path, host);
    case "index": {
      const o = evaluate(e.of, scope, host), at = evaluate(e.at, scope, host);
      if (o === null || o === undefined || typeof o !== "object") return undefined;
      return Array.isArray(o) ? o[num(at)] : (o as Record<string, Value>)[String(at)];
    }
    case "call": {
      const name = e.fn.k === "name" ? e.fn.v : e.fn.k === "var" ? e.fn.path.join(".") : "?";
      const args = e.args.map((a) => evaluate(a, scope, host) ?? null);
      return host.call?.(name, args);
    }
    case "un": {
      if (e.op === "#") {
        const v = evaluate(e.e, scope, host);
        return Array.isArray(v) ? v.length : typeof v === "string" ? v.length : 0;
      }
      const v = evaluate(e.e, scope, host);
      return e.op === "!" ? !truthy(v) : -num(v);
    }
    case "bin": {
      if (e.op === "&&") return truthy(evaluate(e.a, scope, host)) && truthy(evaluate(e.b, scope, host));
      if (e.op === "||") return truthy(evaluate(e.a, scope, host)) || truthy(evaluate(e.b, scope, host));
      const a = evaluate(e.a, scope, host), b = evaluate(e.b, scope, host);
      switch (e.op) {
        case "==": return eq(a, b);
        case "!=": return !eq(a, b);
        case "<": return num(a) < num(b);
        case "<=": return num(a) <= num(b);
        case ">": return num(a) > num(b);
        case ">=": return num(a) >= num(b);
        case "+": return typeof a === "string" || typeof b === "string" ? `${a ?? ""}${b ?? ""}` : num(a) + num(b);
        case "-": return num(a) - num(b);
        case "*": return num(a) * num(b);
        case "/": return num(a) / num(b);
        case "%": return num(a) % num(b);
      }
      return undefined;
    }
    case "cond": return truthy(evaluate(e.c, scope, host)) ? evaluate(e.a, scope, host) : evaluate(e.b, scope, host);
    case "assign": {
      if (e.target.k !== "var") return undefined;
      let v = evaluate(e.e, scope, host) ?? null;
      if (e.op !== "=") {
        const cur = lookup(scope, e.target.path, host);
        v = e.op === "+=" ? num(cur) + num(v) : e.op === "-=" ? num(cur) - num(v) : e.op === "*=" ? num(cur) * num(v) : num(cur) / num(v);
      }
      // ASSUMPTION: assignment copies structs (behaviour-tree variables are values)
      assignPath(scope, e.target.path, typeof v === "object" && v !== null ? structuredClone(v) : v);
      return v;
    }
    case "list": {
      let last: Value | undefined;
      for (const x of e.items) last = evaluate(x, scope, host);
      return last;
    }
  }
}

// ---- nodes ----

const leaf = (f: () => Status): Task => ({ tick: f, abort: () => {} });
const constant = (s: Status): Task => leaf(() => s);

/** A child slot that (re)creates its task when started again. */
class Slot {
  private task: Task | null = null;
  private readonly make: () => Task;
  constructor(make: () => Task) { this.make = make; }
  tick(): Status {
    this.task ??= this.make();
    const s = this.task.tick();
    if (s !== "running") this.task = null;
    return s;
  }
  abort(): void {
    this.task?.abort();
    this.task = null;
  }
  get active(): boolean { return this.task !== null; }
}

export class Runner {
  readonly host: Host;
  private reported = new Set<string>();
  constructor(host: Host) { this.host = host; }

  report(what: string): void {
    if (this.reported.has(what)) return;
    this.reported.add(what);
    this.host.report?.(what);
  }

  get problems(): string[] { return [...this.reported]; }

  /** Instantiate a tree: its variables in a new scope under `parent`, its Root as a task. */
  instantiate(tree: BtTree, parent: Scope | null = null): { task: Task; scope: Scope } {
    const scope = new Scope(parent);
    for (const v of tree.variables) scope.declare(v);
    const root = tree.root;
    if (!root) return { task: constant("success"), scope };
    return { task: this.make(root, scope), scope };
  }

  private ctx(scope: Scope, n: BtNode): Context {
    return {
      host: this.host,
      scope,
      eval: (prop, fallback = null) => {
        const raw = prop === undefined ? undefined : n.props[prop];
        if (raw === undefined) return fallback;
        const q = quoted(raw);
        if (q === null || isTextProp(prop!, q)) return q ?? raw;
        if (q.trim() === "") return fallback;
        try {
          return evaluate(compile(q), scope, this.host) ?? null;
        } catch (err) {
          this.report(`${n.tag}.${prop}: ${(err as Error).message}`);
          return fallback;
        }
      },
    };
  }

  make(n: BtNode, scope: Scope): Task {
    const c = this.ctx(scope, n);
    const kids = n.children;
    const child = (tag: string) => kids.find((k) => k.tag === tag);
    const only = (k: BtNode | undefined): Slot | null => (k ? new Slot(() => this.make(k.children.length === 1 && ["Then", "Else", "Behavior", "OnInit", "LOD", "Detail", "Child"].includes(k.tag) ? k.children[0] : k, scope)) : null);
    const text = (prop: string) => { const v = n.props[prop]; return v === undefined ? "" : quoted(v) ?? v; };
    const flag = (prop: string, d = false) => { const v = c.eval(prop, d); return v === "true" ? true : v === "false" ? false : truthy(v); };

    switch (n.tag) {
      case "Root": {
        const init = only(child("OnInit")), body = only(child("Behavior"));
        let initDone = !init;
        return {
          tick: () => {
            if (!initDone) {
              const s = init!.tick();
              if (s === "running") return s;
              initDone = true;
              // ASSUMPTION: a failing OnInit fails the tree
              if (s === "failure") return s;
            }
            return body ? body.tick() : "success";
          },
          abort: () => { init?.abort(); body?.abort(); },
        };
      }
      case "Behavior": case "OnInit": case "Then": case "Else": case "Child":
        return kids[0] ? this.make(kids[0], scope) : constant("success");
      case "Sequence": case "Selector": {
        const slots = kids.map((k) => new Slot(() => this.make(k, scope)));
        const stopOn: Status = n.tag === "Sequence" ? "failure" : "success";
        let i = 0;
        return {
          tick: () => {
            while (i < slots.length) {
              const s = slots[i].tick();
              if (s === "running") return s;
              if (s === stopOn) { i = 0; return s; }
              i++;
            }
            i = 0;
            return n.tag === "Sequence" ? "success" : "failure";
          },
          abort: () => { slots[i]?.abort(); i = 0; },
        };
      }
      case "Parallel": {
        const slots = kids.map((k) => new Slot(() => this.make(k, scope)));
        const succAll = text("successMode") === "All", failAll = text("failureMode") === "All";
        let done: (Status | null)[] = slots.map(() => null);
        const finish = (s: Status): Status => { slots.forEach((x) => x.abort()); done = slots.map(() => null); return s; };
        return {
          tick: () => {
            slots.forEach((x, k) => { if (done[k] === null) { const s = x.tick(); if (s !== "running") done[k] = s; } });
            const ok = done.filter((s) => s === "success").length, bad = done.filter((s) => s === "failure").length;
            if (failAll ? bad === slots.length : bad > 0) return finish("failure");
            if (succAll ? ok === slots.length : ok > 0) return finish("success");
            // ASSUMPTION: when every child has finished without meeting a mode, the outcome follows the failures
            if (ok + bad === slots.length) return finish(bad ? "failure" : "success");
            return "running";
          },
          abort: () => finish("failure"),
        };
      }
      case "IfCondition": case "IfElseCondition": case "RandomGate": {
        const yes = n.tag === "IfCondition" ? only(kids[0]) : only(child("Then"));
        const no = n.tag === "IfCondition" ? null : only(child("Else"));
        let chosen: Slot | null | undefined; // undefined = not decided yet
        return {
          tick: () => {
            if (chosen === undefined) {
              const open = n.tag === "RandomGate" ? this.host.random() < num(c.eval("opensWithChance", 0.5)) : truthy(c.eval("condition", false));
              chosen = open ? yes : no;
              if (!chosen) {
                chosen = undefined;
                // ASSUMPTION: a closed condition without a branch succeeds, or fails with failOnCondition
                return flag("failOnCondition") ? "failure" : "success";
              }
            }
            const s = chosen!.tick();
            if (s !== "running") chosen = undefined;
            return s;
          },
          abort: () => { chosen?.abort(); chosen = undefined; },
        };
      }
      case "While": case "Loop": {
        const body = only(kids[0]);
        let iterations = 0;
        return {
          tick: () => {
            for (let guard = 0; guard < 1000; guard++) {
              if (!body?.active) {
                const go = n.tag === "While" ? truthy(c.eval("condition", false)) : (() => { const cnt = num(c.eval("count", -1)); return cnt < 0 || iterations < cnt; })();
                if (!go) { iterations = 0; return n.tag === "While" && flag("doFail") ? "failure" : "success"; }
              }
              if (!body) return "running";
              const s = body.tick();
              if (s === "running") return s;
              iterations++;
              // ASSUMPTION: Loop stops on a failing child; While only with propagateChildFail
              if (s === "failure" && (n.tag === "Loop" || flag("propagateChildFail"))) { iterations = 0; return "failure"; }
            }
            return "running"; // an instant loop: yield for this tick
          },
          abort: () => { body?.abort(); iterations = 0; },
        };
      }
      case "ForEach": {
        const body = only(kids[0]);
        const arrName = text("array"), it = text("iterator"), val = text("value"), brk = text("break");
        let idx: number | null = null;
        return {
          tick: () => {
            for (let guard = 0; guard < 10000; guard++) {
              const arr = scope.get(arrName);
              const list = Array.isArray(arr) ? arr : [];
              if (idx === null) idx = num(c.eval("startIndex", 0));
              if (idx >= list.length || (brk && truthy(scope.get(brk)))) { idx = null; return "success"; }
              if (!body?.active) {
                if (it) scope.set(it, idx);
                if (val) scope.set(val, list[idx] ?? null);
              }
              if (!body) { idx = null; return "success"; }
              const s = body.tick();
              if (s === "running") return s;
              // ASSUMPTION: a failing iteration does not stop the loop
              idx += Math.max(1, num(c.eval("step", 1)));
            }
            return "running";
          },
          abort: () => { body?.abort(); idx = null; },
        };
      }
      case "Wait": {
        let until: number | null = null;
        const clock = () => (text("timeType") === "WorldTime" ? this.host.realTime() : this.host.gameTime());
        return {
          tick: () => {
            if (until === null) {
              const d = num(c.eval("duration", 0));
              if (d < 0) return "running"; // -1: wait forever (until aborted)
              // ASSUMPTION: variation adds 0..variation seconds
              until = clock() + d + this.host.random() * num(c.eval("variation", 0));
            }
            if (clock() < until) return "running";
            until = null;
            return flag("doFail") ? "failure" : "success";
          },
          abort: () => { until = null; },
        };
      }
      case "Success": return constant("success");
      case "Fail": return constant("failure");
      case "Expression": return leaf(() => { c.eval("expressions"); return "success"; });
      case "VarOperation": return leaf(() => this.varOperation(n, scope, c));
      case "IncludeTree": {
        const file = String(c.eval("File", "")).replaceAll("\\", "/").toLowerCase();
        const name = String(c.eval("Name", "")).toLowerCase();
        let inner: Task | null = null;
        return {
          tick: () => {
            if (!inner) {
              const t = this.host.tree(file, name);
              if (!t) { this.report(`IncludeTree: ${file}#${name} not found`); return "failure"; }
              inner = this.instantiate(t, scope).task;
            }
            const s = inner.tick();
            if (s !== "running") inner = null;
            return s;
          },
          abort: () => { inner?.abort(); inner = null; },
        };
      }
      case "ExecuteLua": return leaf(() => { this.lua(text("code"), scope); return "success"; });
      case "LuaWrapper": {
        const body = only(kids[0]);
        let entered = false;
        const exit = () => { if (entered) { entered = false; this.lua(text("onExit"), scope); } };
        return {
          tick: () => {
            if (!entered) { entered = true; this.lua(text("onEnter"), scope); }
            const s = body ? body.tick() : "success";
            if (s !== "running") exit();
            return s;
          },
          abort: () => { body?.abort(); exit(); },
        };
      }
    }
    const custom = this.host.node?.(n, c);
    if (custom) return custom;
    this.report(`unsupported node ${n.tag}`);
    // unknown nodes with one child pass through to it; leaves succeed
    return kids.length === 1 ? this.make(kids[0], scope) : constant("success");
  }

  private lua(code: string, scope: Scope): void {
    if (!code.trim()) return;
    if (this.host.lua) this.host.lua(code, scope);
    else this.report("Lua (no runtime yet)");
  }

  private varOperation(n: BtNode, scope: Scope, c: Context): Status {
    const name = String(c.eval("varName", "")), target = String(c.eval("targetVarName", ""));
    const op = String(c.eval("operation", ""));
    const cur = scope.get(name);
    const arr = Array.isArray(cur) ? cur : [];
    const arg = () => c.eval("argument", null) as Value;
    switch (op) {
      case "Reinit": scope.reinit(name); return "success";
      case "PushBack": scope.set(name, [...arr, arg()]); return "success";
      case "Copy": scope.set(target, cur === undefined ? null : structuredClone(cur)); return "success";
      case "Size": scope.set(target, arr.length); return "success";
      case "Find": { const a = arg(); scope.set(target, arr.findIndex((x) => eq(x, a))); return "success"; }
      case "Erase": { const a = arg(); scope.set(name, arr.filter((x) => !eq(x, a))); return "success"; }
      case "Clear": scope.set(name, []); return "success";
    }
    this.report(`VarOperation ${op}`);
    void n;
    return "success";
  }
}
