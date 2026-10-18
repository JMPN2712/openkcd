// Terrain colour from levels/<name>/terrain/cover.ctc (CryEngine compiled
// terrain texture). Verified on Rataje (docs/LEVELS.md):
//
//   "CRY\0", u8 fileType (100), u8 flags, u16 version (9)
//   u16 layerCount (2), u16 flags, f32 brightness
//   per layer: u16 sectorPixels (256), u16, u32 format (BC1), u32 bytesPerSector (32768)
//   u16 nodeCount (5461 = the terrain quadtree), then u16 slot[nodeCount]
//     (0xFFFF = none), nodes in the terrain tree's depth-first order
//   slots × (layer 0: colour, layer 1: normal map), each 256² BC1
//
// Only depths 0–5 are textured (1365 slots), so the finest colour is
// 128 m / 256 px = 0.5 m per pixel. Tiles are stored X-major like the
// heightmap: image rows run along world x, columns along world y (found by
// correlating the normal layer with heightmap slopes: R ≈ −∂h/∂x, B ≈ −∂h/∂y,
// r = −0.91 / −0.90).
//
// Each depth is a mosaic that halves the previous one, so depths 5…0 form a
// ready-made mip chain. Mosaics keep the X-major layout (row = world x,
// column = world y); sample them at uv = (y, x) / size.

export interface CoverMosaic {
  depth: number;
  /** pixels per side */
  size: number;
  /** BC1 blocks, row-major, (size/4)² × 8 bytes */
  bc1: Uint8Array;
}

export interface Cover {
  worldSize: number;
  brightness: number;
  /** mosaics from the finest depth down to the root (a mip chain) */
  mosaics: CoverMosaic[];
}

export function parseCover(bytes: Uint8Array, worldSize: number, layer = 0): Cover {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2]) !== "CRY") throw new Error("not a CryEngine cover.ctc");
  const layers = dv.getUint16(8, true);
  const brightness = dv.getFloat32(12, true);
  let o = 16;
  const sectorPx: number[] = [], sectorBytes: number[] = [];
  for (let i = 0; i < layers; i++, o += 12) {
    sectorPx.push(dv.getUint16(o, true));
    sectorBytes.push(dv.getUint32(o + 8, true));
  }
  const px = sectorPx[0];
  if (sectorBytes[0] !== (px * px) / 2) throw new Error(`cover layer 0 is not BC1 (${sectorBytes[0]} bytes for ${px}²)`);
  const nodes = dv.getUint16(o, true);
  o += 2;
  const slots = new Uint16Array(nodes);
  for (let i = 0; i < nodes; i++) slots[i] = dv.getUint16(o + i * 2, true);
  const data = o + nodes * 2;
  const slotBytes = sectorBytes.reduce((a, b) => a + b, 0);

  // walk the quadtree in the terrain's order to place each node's tile
  const byDepth = new Map<number, { x: number; y: number; slot: number }[]>();
  let next = 0;
  const walk = (depth: number, x: number, y: number, size: number) => {
    const slot = slots[next++];
    if (slot !== 0xffff) {
      if (!byDepth.has(depth)) byDepth.set(depth, []);
      byDepth.get(depth)!.push({ x, y, slot });
    }
    if (next >= nodes || size <= 64) return;
    const h = size / 2;
    walk(depth + 1, x, y, h);
    walk(depth + 1, x + h, y, h);
    walk(depth + 1, x, y + h, h);
    walk(depth + 1, x + h, y + h, h);
  };
  walk(0, 0, 0, worldSize);

  const mosaics: CoverMosaic[] = [];
  const blocksPerTile = px / 4;
  for (const depth of [...byDepth.keys()].sort((a, b) => b - a)) {
    const tiles = byDepth.get(depth)!;
    const per = 1 << depth;
    if (tiles.length !== per * per) continue; // only complete levels make a mosaic
    const node = worldSize / per;
    const bpr = per * blocksPerTile; // blocks per mosaic row
    const bc1 = new Uint8Array(bpr * bpr * 8);
    for (const t of tiles) {
      const tileRow = Math.round(t.x / node), tileCol = Math.round(t.y / node);
      const src = data + t.slot * slotBytes + sectorBytes.slice(0, layer).reduce((a, b) => a + b, 0);
      for (let by = 0; by < blocksPerTile; by++) {
        const dst = ((tileRow * blocksPerTile + by) * bpr + tileCol * blocksPerTile) * 8;
        bc1.set(bytes.subarray(src + by * blocksPerTile * 8, src + (by + 1) * blocksPerTile * 8), dst);
      }
    }
    mosaics.push({ depth, size: per * px, bc1 });
  }
  return { worldSize, brightness, mosaics };
}
