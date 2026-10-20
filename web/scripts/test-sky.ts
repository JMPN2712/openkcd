// Day and night from Rataje's time of day: profiles, sunrise/sunset, the sun's path, light levels.
// usage: node scripts/test-sky.ts [--root GAME_ROOT]

import { homedir } from "node:os";
import { join } from "node:path";
import { openRataje } from "./lib.ts";
import { daylight, pickProfile, skyAt, sunDirection } from "../src/sky.ts";

const args = process.argv.slice(2);
const root = args.includes("--root") ? args[args.indexOf("--root") + 1] : join(homedir(), "kcd1");
let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };

const lvl = await openRataje(root, { cover: false });
const tod = lvl.tod;
check(!!tod && tod.profiles.length >= 7, `time of day: ${tod?.profiles.map((p) => p.name || "(base)").join(", ")}; level starts at ${tod?.time.toFixed(2)} h`);
const p = pickProfile(tod!);
check(p.name === "semicloudy_clear", `profile used: ${p.name} (highest priority)`);
const { rise, set } = daylight(p);
check(Math.abs(rise - 5) < 0.3 && Math.abs(set - 21) < 0.3, `sunrise ${rise.toFixed(2)} h, sunset ${set.toFixed(2)} h (sun intensity spline)`);
const deg = (r: number) => (r * 180) / Math.PI;
const noon = sunDirection((rise + set) / 2, rise, set);
check(deg(Math.asin(noon[2])) > 50 && deg(Math.asin(noon[2])) < 70 && noon[1] < 0, `noon sun ${deg(Math.asin(noon[2])).toFixed(0)}° high, in the south`);
check(Math.abs(sunDirection(rise, rise, set)[2]) < 0.02 && Math.abs(sunDirection(set, rise, set)[2]) < 0.02, "sun on the horizon at sunrise and sunset");
const morning = sunDirection(8, rise, set);
check(morning[0] > 0.5, `08:00 sun in the east (x ${morning[0].toFixed(2)})`);
const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const at = (h: number) => skyAt(p, h);
for (const h of [0, 5, 6, 9, 12, 18, 20.5, 22]) {
  const s = at(h);
  console.log(`     ${String(h).padStart(4)} h: sun ${lum(s.lighting.sunColor).toFixed(3)} ambient ${lum(s.lighting.skyColor).toFixed(3)} horizon ${lum(s.horizon).toFixed(3)} fog ${s.lighting.fogDensity.toFixed(5)}/m night ${s.night.toFixed(2)} stars ${s.stars.toFixed(2)}`);
}
check(lum(at(12).lighting.sunColor) > 0.8 && lum(at(0).lighting.sunColor) < 0.15, "bright at noon, dark at midnight");
check(at(0).stars > 0 && at(12).stars === 0, "stars only at night");
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
