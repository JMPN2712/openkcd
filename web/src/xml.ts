// Tiny XML tag tokenizer for CryEngine's plain-text XML (.mtl, .cdf, …).
// Used instead of DOMParser so the same code runs in Node tests and the browser.

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e]);

export function parseXml(text: string): XmlNode {
  const root: XmlNode = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const attrRe = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const m of text.replace(/<!--[\s\S]*?-->/g, "").matchAll(tagRe)) {
    const [, close, tag, attrText, selfClose] = m;
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of attrText.matchAll(attrRe)) attrs[a[1]] = unescape(a[2] ?? a[3] ?? "");
    const node: XmlNode = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}
