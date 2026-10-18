#!/usr/bin/env python3
"""Summarise pak_survey.py JSON output as Markdown tables.

usage: python3 -I pak_report.py paks.json
"""
import collections
import json
import re
import sys

MiB = 2 ** 20
paks = json.load(open(sys.argv[1]))


def owner(path):
    p = path.lower()
    if "_hd" in p:
        return "HD Texture Pack"
    m = re.search(r"dlc(\d)", p)
    if m:
        return {"1": "DLC1", "2": "DLC2 Hans Capon", "3": "DLC3 Band of Bastards",
                "4": "DLC4 A Woman's Lot"}.get(m.group(1), "DLC" + m.group(1))
    if p.startswith("data/patch/"):
        return "Base (patch)"
    return "Base"


# --- per pak table
print("| Pak | Size (MiB) | Files | Uncompressed (MiB) | Methods | ZIP64 | Owner |")
print("|---|---:|---:|---:|---|---|---|")
for r in paks:
    meth = ", ".join(f"{k}:{v}" for k, v in sorted(r.get("methods", {}).items()))
    print(f"| `{r['path']}` | {r['size'] / MiB:,.1f} | {r.get('files', '?'):,} | "
          f"{r.get('uncompressed', 0) / MiB:,.1f} | {meth} | {'yes' if r.get('zip64') else ''} | {owner(r['path'])} |")

# --- global stats
print()
methods, flags, extras = collections.Counter(), collections.Counter(), collections.Counter()
for r in paks:
    methods.update(r.get("methods", {}))
    flags.update(r.get("flags", {}))
    extras.update(r.get("extra_fields", {}))
print(f"paks: {len(paks)}, zip64: {sum(1 for r in paks if r.get('zip64'))}, "
      f"comments: {sum(1 for r in paks if r.get('comment_len'))}, "
      f"issues: {sum(1 for r in paks if r.get('issues'))}")
print(f"methods: {dict(methods)}\nflags: {dict(flags)}\nextra fields: {dict(extras)}")

# --- by owner
print("\n| Owner | Paks | On disk (GiB) | Files |")
print("|---|---:|---:|---:|")
own = collections.defaultdict(lambda: [0, 0, 0])
for r in paks:
    o = own[owner(r["path"])]
    o[0] += 1; o[1] += r["size"]; o[2] += r.get("files", 0)
for k, (n, s, f) in sorted(own.items()):
    print(f"| {k} | {n} | {s / 2**30:,.2f} | {f:,} |")

# --- by extension
ext = collections.defaultdict(lambda: [0, 0, 0])
for r in paks:
    for k, (n, u, c) in r.get("by_ext", {}).items():
        e = ext[k]
        e[0] += n; e[1] += u; e[2] += c
print("\n| Extension | Files | Uncompressed (MiB) | Compressed (MiB) |")
print("|---|---:|---:|---:|")
for k, (n, u, c) in sorted(ext.items(), key=lambda kv: -kv[1][1])[:45]:
    print(f"| `{k}` | {n:,} | {u / MiB:,.0f} | {c / MiB:,.0f} |")
tu = sum(v[1] for v in ext.values()); tc = sum(v[2] for v in ext.values())
print(f"| **total** | {sum(v[0] for v in ext.values()):,} | {tu / MiB:,.0f} | {tc / MiB:,.0f} |")

# --- top-level dirs inside paks
top = collections.Counter()
for r in paks:
    top.update(r.get("top_dirs", {}))
print("\n| Top dir inside paks | Uncompressed (MiB) |\n|---|---:|")
for k, v in top.most_common(25):
    print(f"| `{k}` | {v / MiB:,.0f} |")
