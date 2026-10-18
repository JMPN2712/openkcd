#!/usr/bin/env python3
"""Read-only decoder for KCD's navmesh (recast.pak: recast/rdnavmesh_*.nav):
Detour's tile format, version 14, with Warhorse's vertex packing. Written from
the format note in the research notes (navmesh-format.md) and Detour's public
documentation. Decodes every tile and checks it: indices in range, every
internal neighbour sharing its edge in reverse, and the last tile ending at the
end of the file.

usage: python3 -I navmesh.py LEVEL_PAK_DIR [NAME]   (NAME default "1")
"""
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pakread as pr  # noqa: E402

MAGIC = 0x444E4156  # 'DNAV'
VERSION = 14
NAV_SETTINGS_BYTES = 56
COUNTS = ("magic", "version", "x", "y", "layer", "user_id", "polys", "verts", "packed_verts",
          "max_links", "runtime_count", "detail_meshes", "detail_verts", "detail_tris",
          "bv_nodes", "offmesh", "offmesh_base")
# packed vertex fields per axis: (shift, bits), quantised over the tile bounds
PACKED = ((21, 11), (10, 11), (0, 10))
POLY_BYTES, DETAIL_MESH_BYTES, DETAIL_TRI_BYTES, OFFMESH_BYTES = 28, 10, 4, 52
EXTERNAL_LINK = 0x8000


def decode_tile(b, o):
    """Decode the tile at byte offset o. Returns (tile, offset after it)."""
    h = dict(zip(COUNTS, struct.unpack_from("<17i", b, o)))
    if h["magic"] != MAGIC or h["version"] != VERSION:
        raise ValueError(f"no DNAV v{VERSION} tile at byte {o}")
    p = o + 17 * 4
    h["walkable_height"], h["walkable_radius"], h["walkable_climb"], h["setting4"] = struct.unpack_from("<4f", b, p)
    bmin = struct.unpack_from("<3f", b, p + 16)
    bmax = struct.unpack_from("<3f", b, p + 28)
    h["bv_quant"], = struct.unpack_from("<f", b, p + 40)
    p += 44
    verts = []
    for _ in range(h["packed_verts"]):
        word, = struct.unpack_from("<I", b, p)
        p += 4
        v = []
        for axis, (shift, bits) in enumerate(PACKED):
            top = (1 << bits) - 1
            v.append(bmin[axis] + ((word >> shift) & top) / top * (bmax[axis] - bmin[axis]))
        verts.append(tuple(v))
    for _ in range(h["verts"] - h["packed_verts"]):
        verts.append(struct.unpack_from("<3f", b, p))
        p += 12
    polys = []
    for _ in range(h["polys"]):
        idx = struct.unpack_from("<6H", b, p)
        nei = struct.unpack_from("<6H", b, p + 12)
        area, count = b[p + 24], b[p + 25]
        polys.append({"verts": idx[:count], "neis": nei[:count], "area": area})
        p += POLY_BYTES
    p += h["detail_meshes"] * DETAIL_MESH_BYTES + h["detail_verts"] * 12 + h["detail_tris"] * DETAIL_TRI_BYTES
    offmesh = []
    for _ in range(h["offmesh"]):
        offmesh.append((struct.unpack_from("<3f", b, p), struct.unpack_from("<3f", b, p + 12), struct.unpack_from("<f", b, p + 24)[0]))
        p += OFFMESH_BYTES
    return {"header": h, "bmin": bmin, "bmax": bmax, "verts": verts, "polys": polys, "offmesh": offmesh}, p


def check_tile(t):
    """(shared internal edges, bad entries) for one tile."""
    polys, nverts = t["polys"], len(t["verts"])
    shared = bad = 0
    for poly in polys:
        vs = poly["verts"]
        if len(vs) == 2:
            continue  # off-mesh connection
        if not 3 <= len(vs) <= 6 or any(v >= nverts for v in vs):
            bad += 1
            continue
        for j, code in enumerate(poly["neis"]):
            if code == 0 or code & EXTERNAL_LINK:
                continue
            if code - 1 >= len(polys):
                bad += 1
                continue
            a, c = vs[j], vs[(j + 1) % len(vs)]
            other = polys[code - 1]["verts"]
            m = len(other)
            if any(other[i] == c and other[(i + 1) % m] == a for i in range(m)):
                shared += 1
            else:
                bad += 1
    return shared, bad


def main():
    level = sys.argv[1]
    name = sys.argv[2] if len(sys.argv) > 2 else "1"
    pak = os.path.join(level, "recast.pak")
    entries = {e.name.lower(): e for e in pr.entries(pak)}
    nav = pr.read(pak, entries[f"recast/rdnavmesh_{name}.nav"])
    count, = struct.unpack_from("<i", nav, NAV_SETTINGS_BYTES)
    o = NAV_SETTINGS_BYTES + 4
    polys = verts = shared = bad = 0
    for i in range(count):
        t, o = decode_tile(nav, o)
        s, b_ = check_tile(t)
        polys += len(t["polys"])
        verts += len(t["verts"])
        shared += s
        bad += b_
        if i == 0:
            h = t["header"]
            print("first tile:", {"x": h["x"], "y": h["y"], "polys": h["polys"], "verts": h["verts"], "bmin": t["bmin"], "bmax": t["bmax"]})
    if o != len(nav):
        raise ValueError(f"tiles end at {o}, file is {len(nav)} bytes")
    print(f"{name}: {count} tiles, {polys} polys, {verts} verts; internal edges shared {shared}, bad {bad}")


if __name__ == "__main__":
    main()
