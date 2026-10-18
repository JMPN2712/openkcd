// File-name filter for the asset VFS: everything the texture and model
// viewers need (textures, geometry, materials, character data).
import { TEXTURE_RE } from "./texture.ts";
import { MODEL_RE, MTL_RE } from "./model.ts";

// Libs/Tables/*.xml: the game database (character composition, items, …)
const TABLE_RE = /^libs\/tables\/.*\.xml$/;
// .cdf: character definitions
const CDF_RE = /\.cdf$/;
// animation clips, databases and the per-skeleton animation lists
export const ANIM_RE = /\.(caf|dba|chrparams)$/;

export const ASSET_RE = { test: (n: string) => TEXTURE_RE.test(n) || MODEL_RE.test(n) || MTL_RE.test(n) || TABLE_RE.test(n) || CDF_RE.test(n) || ANIM_RE.test(n) };
