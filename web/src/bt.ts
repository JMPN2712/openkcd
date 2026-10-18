// KCD behaviour trees (Libs/AI/**/*.xml): parsing. 4,927 trees drive quests,
// NPC daily life, dialogue flow, combat and crime (docs/GAMELOGIC.md).
//
//   <BehaviorTrees><BehaviorTree name=…>
//     <Variables><Variable name= type= values= form="single|array" isPersistent=/>…</Variables>
//     <Root OneTimeOnly= FailState=><OnInit>…</OnInit><Behavior>…</Behavior></Root>
//     <EditorData>…</EditorData>            (editor layout: ignored)
//
// Node properties are written in quotes when typed by the editor
// (condition="&quot;$x ~= $__null&quot;"): the content is an expression or plain
// text depending on the property. Unquoted values are raw literals (enum names,
// message types, variable names). Expressions are Lua-flavoured: $var.field
// paths, 'strings', numbers, == ~= != < <= > >=, and/or/not/!, + - * / %,
// ?:, assignments (= += -= *= /=) and comma-separated lists, calls f(…).

import { parseXml, type XmlNode } from "./xml.ts";

export interface BtVariable {
  name: string;
  type: string;
  values: string;
  form: string;
  persistent: boolean;
}

export interface BtNode {
  tag: string;
  /** raw property values (XML-unescaped; quoted ones keep their quotes) */
  props: Record<string, string>;
  children: BtNode[];
}

export interface BtTree {
  file: string;
  name: string;
  variables: BtVariable[];
  /** variables expected from an including tree */
  forward: BtVariable[];
  root: BtNode | null;
}

const SKIP_PROPS = new Set(["canSkip", "saveVersion", "nodeLabel"]);

function toNode(x: XmlNode): BtNode {
  const props: Record<string, string> = {};
  for (const [k, v] of Object.entries(x.attrs)) if (!SKIP_PROPS.has(k)) props[k] = v;
  return { tag: x.tag, props, children: x.children.filter((c) => c.tag !== "OutputBreakpoints").map(toNode) };
}

const toVar = (v: XmlNode): BtVariable => ({
  name: v.attrs.name ?? "", type: v.attrs.type ?? "", values: v.attrs.values ?? "", form: v.attrs.form ?? "single", persistent: v.attrs.isPersistent === "1",
});

/** All trees of one Libs/AI file. `file` is relative to Libs/AI (as IncludeTree's File names it). */
export function parseTreeFile(xml: string, file: string): BtTree[] {
  const doc = parseXml(xml);
  const top = doc.tag === "BehaviorTrees" ? doc : doc.children.find((c) => c.tag === "BehaviorTrees");
  if (!top) return [];
  return top.children.filter((t) => t.tag === "BehaviorTree").map((t) => {
    const editor = t.children.find((c) => c.tag === "EditorData");
    const root = t.children.find((c) => c.tag === "Root");
    return {
      file,
      name: t.attrs.name ?? "",
      variables: (t.children.find((c) => c.tag === "Variables")?.children ?? []).map(toVar),
      forward: (editor?.children.find((c) => c.tag === "ForwardDeclarations")?.children ?? []).map(toVar),
      root: root ? toNode(root) : null,
    };
  });
}

/**
 * Quoted properties whose content is plain text, not an expression: Lua code,
 * messages, GUIDs, include targets, flag sets ("Intersection|And").
 */
const TEXT_PROP = /^(code|onEnter|onExit|onUpdate|onInit|Message|message|File|Name|SetOperationChoice|Pattern|[Cc]ategory|Categories|HelperCategories|conditions|type|SubGraph|\w*GUID|\w*Guid|\w*guid|\w*Id)$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a quoted property holds plain text (pass the content to also recognise GUID values). */
export function isTextProp(prop: string, content = ""): boolean {
  return TEXT_PROP.test(prop) || GUID.test(content.trim());
}

/** A quoted property's content, or null for a raw (unquoted) value. */
export function quoted(v: string | undefined): string | null {
  return v !== undefined && v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : null;
}

// ---- expressions ----

export type Expr =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "dur"; v: number }                 // '2s', '1.5h' … in seconds
  | { k: "bool"; v: boolean }
  | { k: "var"; path: string[] }            // $a.b.c
  | { k: "name"; v: string }                // bare identifier (enum value, function name)
  | { k: "index"; of: Expr; at: Expr }      // a[b]
  | { k: "call"; fn: Expr; args: Expr[] }
  | { k: "un"; op: string; e: Expr }       // ! - and # (length of an array variable)
  | { k: "bin"; op: string; a: Expr; b: Expr }
  | { k: "cond"; c: Expr; a: Expr; b: Expr }
  | { k: "assign"; op: string; target: Expr; e: Expr }
  | { k: "list"; items: Expr[] };

type Tok = { t: "num" | "dur" | "str" | "var" | "name" | "op" | "end"; v: string };

const DURATION: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };

const OPS = ["==", "~=", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "&&", "||", "&", "|", "#", "~", "<", ">", "=", "!", "+", "-", "*", "/", "%", "?", ":", "(", ")", "[", "]", ",", "."];

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (s.startsWith("//", i)) { const nl = s.indexOf("\n", i); i = nl < 0 ? s.length : nl + 1; continue; }
    if (c === "'" || c === '"') {
      const j = s.indexOf(c, i + 1);
      if (j < 0) throw new Error(`unterminated string at ${i}`);
      out.push({ t: "str", v: s.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    // times of day (05:15) and durations (2s, 500ms, 10m, 1.5h, 2d; "1m 30s" adds up), in seconds
    const tod = /^(\d{1,2}):(\d{2})\b/.exec(s.slice(i));
    if (tod) { out.push({ t: "dur", v: String(Number(tod[1]) * 3600 + Number(tod[2]) * 60) }); i += tod[0].length; continue; }
    const dur = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)(?=\d|\b)/.exec(s.slice(i));
    if (dur) {
      const v = Number(dur[1]) * DURATION[dur[2]];
      const prev = out[out.length - 1];
      if (prev?.t === "dur") prev.v = String(Number(prev.v) + v);
      else out.push({ t: "dur", v: String(v) });
      i += dur[0].length;
      continue;
    }
    // names may start with a digit (objective "1stDate_talkMonastery")
    const dname = /^\d+[A-Za-z_]\w*/.exec(s.slice(i));
    if (dname && !/^\d+[eE][-+]?\d+$/.test(dname[0])) { out.push({ t: "name", v: dname[0] }); i += dname[0].length; continue; }
    const num = /^\d+(\.\d+)?([eE][-+]?\d+)?/.exec(s.slice(i));
    if (num) { out.push({ t: "num", v: num[0] }); i += num[0].length; continue; }
    if (c === "$") {
      // $name, or namespaced $enum:cutsceneMode (then .value)
      const m = /^\$\w+(:[A-Za-z_]\w*)?/.exec(s.slice(i));
      if (!m) throw new Error(`bad variable at ${i}`);
      out.push({ t: "var", v: m[0].slice(1) });
      i += m[0].length;
      continue;
    }
    const id = /^[A-Za-z_]\w*/.exec(s.slice(i));
    if (id) { out.push({ t: "name", v: id[0] }); i += id[0].length; continue; }
    const op = OPS.find((o) => s.startsWith(o, i));
    if (!op) throw new Error(`unexpected '${c}' at ${i}`);
    out.push({ t: "op", v: op });
    i += op.length;
  }
  out.push({ t: "end", v: "" });
  return out;
}

const BIN: Record<string, number> = {
  or: 1, "||": 1, "|": 1, and: 2, "&&": 2, "&": 2,
  "==": 3, "~=": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4,
  "+": 5, "-": 5, "*": 6, "/": 6, "%": 6,
};
const ASSIGN = new Set(["=", "+=", "-=", "*=", "/="]);

/** Parse a property expression (comma lists and assignments included). */
export function parseExpr(src: string): Expr {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => (peek().t === "op" || peek().t === "name") && peek().v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`expected '${v}' but found '${peek().v || "end"}'`);
    p++;
  };
  const primary = (): Expr => {
    const t = toks[p++];
    let e: Expr;
    if (t.t === "num") e = { k: "num", v: Number(t.v) };
    else if (t.t === "dur") e = { k: "dur", v: Number(t.v) };
    else if (t.t === "str") e = { k: "str", v: t.v };
    else if (t.t === "var") e = { k: "var", path: [t.v] };
    else if (t.t === "name") e = t.v === "true" || t.v === "false" ? { k: "bool", v: t.v === "true" } : { k: "name", v: t.v };
    else if (t.t === "op" && t.v === "(") { e = assignment(); expect(")"); }
    else throw new Error(`unexpected '${t.v || "end"}'`);
    for (;;) {
      if (isOp(".")) {
        p++;
        const f = toks[p++];
        if (f.t !== "name" && f.t !== "num") throw new Error(`bad field after '.'`);
        if (e.k === "var") e = { k: "var", path: [...e.path, f.v] };
        else e = { k: "index", of: e, at: { k: "str", v: f.v } };
      } else if (isOp("[")) {
        p++;
        const at = assignment();
        expect("]");
        e = { k: "index", of: e, at };
      } else if (isOp("(")) {
        p++;
        const args: Expr[] = [];
        if (!isOp(")")) {
          args.push(assignment());
          while (isOp(",")) { p++; args.push(assignment()); }
        }
        expect(")");
        e = { k: "call", fn: e, args };
      } else return e;
    }
  };
  const unary = (): Expr => {
    if (isOp("!") || isOp("not") || isOp("~") || isOp("-") || isOp("#")) {
      const op = toks[p++].v;
      // #name: the array variable's length (written without $)
      if (op === "#" && peek().t === "name") return { k: "un", op, e: { k: "var", path: [toks[p++].v] } };
      return { k: "un", op: op === "not" || op === "~" ? "!" : op, e: unary() };
    }
    return primary();
  };
  const binary = (min: number): Expr => {
    let a = unary();
    for (;;) {
      const t = peek();
      const prec = (t.t === "op" || t.t === "name") ? BIN[t.v] : undefined;
      if (prec === undefined || prec < min) return a;
      p++;
      const op = t.v === "and" || t.v === "&" ? "&&" : t.v === "or" || t.v === "|" ? "||" : t.v === "~=" ? "!=" : t.v;
      a = { k: "bin", op, a, b: binary(prec + 1) };
    }
  };
  const conditional = (): Expr => {
    const c = binary(1);
    if (!isOp("?")) return c;
    p++;
    const a = conditional();
    expect(":");
    return { k: "cond", c, a, b: conditional() };
  };
  const assignment = (): Expr => {
    const target = conditional();
    const t = peek();
    if (t.t === "op" && ASSIGN.has(t.v)) {
      p++;
      return { k: "assign", op: t.v, target, e: assignment() };
    }
    return target;
  };
  const items: Expr[] = [];
  if (peek().t !== "end") {
    items.push(assignment());
    for (;;) {
      if (isOp(",")) { p++; if (peek().t !== "end") items.push(assignment()); continue; }
      // statements on separate lines without a comma ("$a = 1 \n $b = 2")
      if (items[items.length - 1].k === "assign" && peek().t === "var") { items.push(assignment()); continue; }
      break;
    }
  }
  if (peek().t !== "end") throw new Error(`unexpected '${peek().v}'`);
  return items.length === 1 ? items[0] : { k: "list", items };
}
