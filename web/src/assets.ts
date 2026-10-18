// File-name filter for the asset VFS: everything the texture and model
// viewers need (textures, geometry, materials).
import { TEXTURE_RE } from "./texture.ts";
import { MODEL_RE, MTL_RE } from "./model.ts";

export const ASSET_RE = { test: (n: string) => TEXTURE_RE.test(n) || MODEL_RE.test(n) || MTL_RE.test(n) };
