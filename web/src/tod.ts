// The level's time of day (mission_mission0.xml <Environment>/<TimeOfDay>): per weather profile
// (<Profile Name="semicloudy_clear" Priority=…>), ~143 variables ("Sun color", "Sun intensity",
// "Fog color", "Night sky: Zenith color", …), each a spline over the day:
//   <Variable Name="Sun intensity" Value="98600.2"><Spline Keys="0.208323:60:36,0.209583:589.6:36,…"/>
//   <Variable Name="Sun color" Color="r,g,b"><Spline Keys="0.0275:(0.2158:0.2158:0.2158):36,…"/>
// Key times are fractions of the day; the last field is the key's tangent flags (ignored: keys
// are joined linearly here). A variable without keys holds its Value / Color all day.

import { parseXml, type XmlNode } from "./xml.ts";

export type TodValue = number | [number, number, number];

interface Spline {
  times: number[];
  values: TodValue[];
}

export interface TodProfile {
  name: string;
  priority: number;
  vars: Map<string, { value: TodValue; spline: Spline | null }>;
}

export interface TimeOfDay {
  /** the level's start time (hours) */
  time: number;
  profiles: TodProfile[];
}

function parseValue(s: string): TodValue {
  if (s.startsWith("(")) {
    const v = s.slice(1, -1).split(":").map(Number);
    return [v[0], v[1], v[2]];
  }
  return Number(s);
}

function parseVar(v: XmlNode): [string, { value: TodValue; spline: Spline | null }] {
  const name = v.attrs.Name ?? "";
  const value: TodValue = v.attrs.Color !== undefined ? (v.attrs.Color.split(",").map(Number) as [number, number, number]) : Number(v.attrs.Value ?? 0);
  const keys = v.children.find((c) => c.tag === "Spline")?.attrs.Keys ?? "";
  const times: number[] = [], values: TodValue[] = [];
  for (const k of keys.split(",").filter(Boolean)) {
    // "t:value:flags" or "t:(r:g:b):flags"
    const m = /^([-\d.e]+):(\([^)]*\)|[-\d.e]+):/.exec(k);
    if (!m) continue;
    times.push(Math.max(0, Math.min(1, Number(m[1]))));
    values.push(parseValue(m[2]));
  }
  return [name, { value, spline: times.length ? { times, values } : null }];
}

export function parseTimeOfDay(missionXml: string): TimeOfDay | null {
  const m = /<TimeOfDay[\s\S]*?<\/TimeOfDay>/.exec(missionXml);
  if (!m) return null;
  const root = parseXml(m[0]).children.find((c) => c.tag === "TimeOfDay");
  if (!root) return null;
  const profiles: TodProfile[] = [];
  const base = root.children.filter((c) => c.tag === "Variable");
  if (base.length) profiles.push({ name: "", priority: 0, vars: new Map(base.map(parseVar)) });
  for (const p of root.children.filter((c) => c.tag === "Profile")) {
    profiles.push({ name: p.attrs.Name ?? "", priority: Number(p.attrs.Priority ?? 0), vars: new Map(p.children.filter((c) => c.tag === "Variable").map(parseVar)) });
  }
  return { time: Number(root.attrs.Time ?? 12), profiles };
}

const lerp = (a: TodValue, b: TodValue, f: number): TodValue =>
  typeof a === "number" ? a + ((b as number) - a) * f : [0, 1, 2].map((i) => a[i] + ((b as number[])[i] - a[i]) * f) as [number, number, number];

/** A variable at `hours` (0–24), wrapping around midnight. */
export function sampleTod(p: TodProfile, name: string, hours: number): TodValue | undefined {
  const v = p.vars.get(name);
  if (!v) return undefined;
  const s = v.spline;
  if (!s) return v.value;
  const t = (((hours / 24) % 1) + 1) % 1;
  const n = s.times.length;
  if (n === 1) return s.values[0];
  let i = 0;
  while (i < n && s.times[i] <= t) i++;
  // between key i-1 and i, wrapping
  const a = (i - 1 + n) % n, b = i % n;
  let ta = s.times[a], tb = s.times[b];
  let tt = t;
  if (tb <= ta) { tb += 1; if (tt < ta) tt += 1; }
  const f = tb > ta ? (tt - ta) / (tb - ta) : 0;
  return lerp(s.values[a], s.values[b], f);
}

export const todNumber = (p: TodProfile, name: string, hours: number, d = 0): number => {
  const v = sampleTod(p, name, hours);
  return typeof v === "number" ? v : v ? (v[0] + v[1] + v[2]) / 3 : d;
};

export const todColor = (p: TodProfile, name: string, hours: number, d: [number, number, number] = [0, 0, 0]): [number, number, number] => {
  const v = sampleTod(p, name, hours);
  return Array.isArray(v) ? v : typeof v === "number" ? [v, v, v] : d;
};
