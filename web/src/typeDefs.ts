// Libs/AI/TypeDefinitions.xml: the AI system's struct types and enums (1,000
// types, 189 enums). Types nest, and a nested type's name joins the path with
// ':' (<Type name="dialog"><Type name="state"> = "dialog:state", the variable
// type trees declare); a nested type inherits its parents' members.
//
//   <Type name="cutsceneData"><Member name="mode" type="enum:cutsceneMode">$enum:cutsceneMode.video</Member>…
//   <Enum name="cutsceneMode"><sequence/><video/>…</Enum>
//
// Enum values are represented as "<enum>.<value>" strings, the same as the
// behaviour-tree runtime's $enum:… expressions and the Lua enum_<name> tables.

import { parseXml, type XmlNode } from "./xml.ts";
import type { Value } from "./btRuntime.ts";

export interface Member {
  name: string;
  type: string;
  /** default as written (may be empty) */
  value: string;
}

export class TypeDefs {
  readonly types = new Map<string, Member[]>();
  /** lower-cased name → spelling and values */
  readonly enums = new Map<string, { name: string; values: string[] }>();

  constructor(xml: string) {
    const root = parseXml(xml).children.find((c) => c.tag === "TypeDefinitions");
    const walk = (n: XmlNode, prefix: string, inherited: Member[]) => {
      for (const c of n.children) {
        if (c.tag === "Type" && c.attrs.name) {
          const name = prefix ? `${prefix}:${c.attrs.name}` : c.attrs.name;
          const own = c.children.filter((m) => m.tag.toLowerCase() === "member" && m.attrs.name).map((m) => ({ name: m.attrs.name, type: m.attrs.type ?? "", value: m.text ?? m.attrs.value ?? "" }));
          const members = [...inherited, ...own];
          this.types.set(name.toLowerCase(), members);
          walk(c, name, members);
        } else if (c.tag === "Enum" && c.attrs.name) {
          this.enums.set(c.attrs.name.toLowerCase(), { name: c.attrs.name, values: c.children.map((v) => v.tag) });
        }
      }
    };
    if (root) walk(root, "", []);
  }

  /** Default value of a type: scalars from the member text, structs member by member. */
  defaultOf(type: string, text = "", depth = 0): Value {
    const t = type.replace(/^_/, "");
    switch (t) {
      case "bool": return text.trim() === "true" || text.trim() === "1";
      case "int": case "int64": case "float": case "double": return text.trim() === "" ? 0 : Number(text) || 0;
      case "string": return text;
    }
    if (t.startsWith("enum:")) {
      const e = t.slice(5);
      const m = /^\$enum:([\w]+)\.(\w+)$/.exec(text.trim());
      if (m) return `${m[1]}.${m[2]}`;
      const en = this.enums.get(e.toLowerCase());
      return en?.values[0] ? `${en.name}.${en.values[0]}` : null;
    }
    const members = this.types.get(t.toLowerCase());
    if (!members || depth > 6) return null; // common:wuid, common:vec3, unknown types: empty
    const o: Record<string, Value> = {};
    for (const m of members) o[m.name] = this.defaultOf(m.type, m.value, depth + 1);
    return o;
  }

  /** Lua source defining enum_<name> tables ({ value = "name.value" }). */
  luaEnums(): string {
    const out: string[] = [];
    for (const { name, values } of this.enums.values()) {
      out.push(`enum_${name.replace(/[^\w]/g, "_")} = { ${values.map((v) => `[${JSON.stringify(v)}] = ${JSON.stringify(`${name}.${v}`)}`).join(", ")} }`);
    }
    return out.join("\n");
  }
}
