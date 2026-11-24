// This machine's paths for the scripts and harnesses: the game folder, the GOG installers, Chrome.
// Read from (first found): environment variables, then `.openkcd.json` at the repository root
// (gitignored; tools/setup.sh writes it), then the defaults below. So a new machine needs no
// edits to any script: run tools/setup.sh once, or set OPENKCD_GAME_ROOT.
//   .openkcd.json: { "gameRoot": "/path/to/game", "installers": "/path/to/gog", "chrome": "/path/to/chrome" }
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** the repository's root folder */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface LocalConfig {
  /** the installed game (holds Data, Engine, Localization, Bin); read-only */
  gameRoot?: string;
  /** the folder with the GOG offline installers (setup_*.exe and .bin slices); read-only */
  installers?: string;
  /** the Chrome binary the headless harnesses start */
  chrome?: string;
}

const file = join(REPO_ROOT, ".openkcd.json");
const tilde = (p: string | undefined) => (p?.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** `.openkcd.json`, or {} when there is none */
export const localConfig: LocalConfig = (() => {
  if (!existsSync(file)) return {};
  try {
    const c = JSON.parse(readFileSync(file, "utf8")) as LocalConfig;
    return { gameRoot: tilde(c.gameRoot), installers: tilde(c.installers), chrome: tilde(c.chrome) };
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message}`);
  }
})();

/** The game folder scripts read by default (--root overrides it per run). */
export const defaultGameRoot = tilde(process.env.OPENKCD_GAME_ROOT) ?? localConfig.gameRoot ?? join(homedir(), "kcd1");

/** The GOG installers folder (OPENKCD_INSTALLERS, .openkcd.json, else ~/Downloads/kingdom_come_deliverance). */
export const defaultInstallers = tilde(process.env.OPENKCD_INSTALLERS) ?? localConfig.installers ?? join(homedir(), "Downloads", "kingdom_come_deliverance");
