#!/usr/bin/env python3
"""Compare our TypeScript texture decodes with Pillow's decoders.

Reads OUT_DIR/manifest.json written by scripts/test-textures.ts, wraps each
sample's raw mip in a one-mip DDS, decodes it with Pillow and diffs channels.

usage: python3 -I scripts/compare_pillow.py OUT_DIR
"""
import collections
import io
import json
import os
import struct
import sys

from PIL import Image

out_dir = sys.argv[1]
manifest = json.load(open(os.path.join(out_dir, "manifest.json")))
stats = collections.defaultdict(lambda: {"n": 0, "max": 0, "bad": 0, "px": 0, "skip": 0, "why": ""})

for s in manifest:
    raw = open(os.path.join(out_dir, s["id"] + ".bin"), "rb").read()
    ours = open(os.path.join(out_dir, s["id"] + ".out"), "rb").read()
    w, h = s["w"], s["h"]
    pf = bytes.fromhex(s["pf"])
    hdr = struct.pack("<4sIIIIIII44s", b"DDS ", 124, 0x1007 | 0x20000, h, w, 0, 0, 1, b"\0" * 44)
    hdr += pf + struct.pack("<IIIII", 0x1000, 0, 0, 0, 0)
    if s["dx10"]:
        dx10 = bytearray(bytes.fromhex(s["dx10"]))
        # Pillow lacks BC1/BC3 _SRGB (decoding is identical) and decodes
        # BC5_UNORM (84) as signed; BC5_TYPELESS (83) is its unsigned path.
        code = struct.unpack_from("<I", dx10, 0)[0]
        struct.pack_into("<I", dx10, 0, {72: 71, 78: 77, 84: 83}.get(code, code))
        struct.pack_into("<II", dx10, 4, 3, 0)  # TEXTURE2D, no cube flag
        struct.pack_into("<I", dx10, 12, 1)     # array size
        hdr += bytes(dx10)
    st = stats[s["fmt"]]
    try:
        im = Image.open(io.BytesIO(hdr + raw))
        im.load()
    except Exception as e:
        st["skip"] += 1
        st["why"] = f"{type(e).__name__}: {e}"[:80]
        continue

    if s["kind"] == "hdr":
        f = struct.unpack(f"<{w * h * 4}f", ours)
        mine = bytes(max(0, min(255, round(v * 255))) if v == v else 0 for v in f)  # clamp, NaN -> 0
    else:
        mine = ours
    mode = im.mode
    ref = im.tobytes()
    chans = {"L": [0], "LA": [0, 3], "RGB": [0, 1, 2], "RGBA": [0, 1, 2, 3]}[mode] if mode in ("L", "LA", "RGB", "RGBA") else None
    if chans is None:
        ref = im.convert("RGBA").tobytes(); mode = "RGBA"; chans = [0, 1, 2, 3]
    if "BC5" in s["fmt"] or s["fmt"] == "ATI2":
        chans = [0, 1]  # B is reconstructed differently (or not at all)
    rstride = {"L": 1, "LA": 2, "RGB": 3, "RGBA": 4}[mode]
    ref_index = {"L": {0: 0}, "LA": {0: 0, 3: 1}, "RGB": {0: 0, 1: 1, 2: 2}, "RGBA": {0: 0, 1: 1, 2: 2, 3: 3}}[mode]
    worst = bad = 0
    for i in range(w * h):
        d = max(abs(mine[i * 4 + c] - ref[i * rstride + ref_index[c]]) for c in chans)
        worst = max(worst, d)
        bad += d > 2
    st["n"] += 1; st["px"] += w * h; st["bad"] += bad; st["max"] = max(st["max"], worst)
    if worst > 2 and "first_bad" not in st:
        st["first_bad"] = f"{s['stem']} mip{s['level']} {w}x{h} pillow={mode}"

print(f"{'format':32s} {'samples':>7} {'skipped':>7} {'max diff':>8} {'px > 2':>8}")
for k, v in sorted(stats.items()):
    pct = 100 * v["bad"] / v["px"] if v["px"] else 0
    print(f"{k:32s} {v['n']:>7} {v['skip']:>7} {v['max']:>8} {pct:>7.2f}%  {v.get('first_bad', '')}{v['why']}")
