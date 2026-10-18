#!/usr/bin/env python3
"""Read-only survey of CryEngine .pak archives: parses each ZIP's EOCD and
central directory (never reads file data), checks a sample of local headers,
and reports compression methods, flags, ZIP64 use, extra fields and per-
extension totals.

usage: python3 -I pak_survey.py GAME_ROOT [--json OUT.json]
"""
import collections
import json
import os
import struct
import sys

EOCD_SIG, EOCD64_SIG, EOCD64_LOC_SIG = 0x06054B50, 0x06064B50, 0x07064B50
CDH_SIG, LFH_SIG = 0x02014B50, 0x04034B50


def find_eocd(f, size):
    tail = min(size, 65536 + 22)
    f.seek(size - tail)
    buf = f.read(tail)
    i = buf.rfind(struct.pack("<I", EOCD_SIG))
    if i < 0:
        raise ValueError("no EOCD record")
    return size - tail + i, buf[i:]


def survey(path):
    size = os.path.getsize(path)
    r = {"path": path, "size": size, "issues": []}
    with open(path, "rb") as f:
        head = f.read(4)
        r["starts_with_lfh"] = head == struct.pack("<I", LFH_SIG)
        eocd_off, eocd = find_eocd(f, size)
        (_, disk, cd_disk, n_disk, n_total, cd_size, cd_off, clen) = struct.unpack_from("<IHHHHIIH", eocd)
        r["comment_len"] = clen
        if clen:
            r["comment"] = eocd[22:22 + clen][:64].hex()
        zip64 = False
        if 0xFFFFFFFF in (cd_size, cd_off) or 0xFFFF in (n_total,):
            f.seek(eocd_off - 20)
            loc = f.read(20)
            if struct.unpack_from("<I", loc)[0] == EOCD64_LOC_SIG:
                zip64 = True
                e64_off = struct.unpack_from("<Q", loc, 8)[0]
                f.seek(e64_off)
                e64 = f.read(56)
                n_total, cd_size, cd_off = struct.unpack_from("<QQQ", e64, 32)
        r["zip64"] = zip64
        if disk or cd_disk:
            r["issues"].append(f"multi-disk fields disk={disk} cd_disk={cd_disk}")
        r["entries"] = n_total
        f.seek(cd_off)
        cd = f.read(cd_size)
    if len(cd) != cd_size:
        r["issues"].append("central directory truncated")

    methods, flags, extras = collections.Counter(), collections.Counter(), collections.Counter()
    by_ext = collections.defaultdict(lambda: [0, 0, 0])  # count, uncompressed, compressed
    top_dirs = collections.Counter()
    sample, files, o = [], 0, 0
    while o + 46 <= len(cd):
        sig, = struct.unpack_from("<I", cd, o)
        if sig != CDH_SIG:
            r["issues"].append(f"bad CD signature at +{o}: {sig:#x}")
            break
        (vmade, vneed, flag, method, mtime, mdate, crc, csize, usize,
         nlen, xlen, cmlen, dstart, iattr, eattr, lho) = struct.unpack_from("<HHHHHHIIIHHHHHII", cd, o + 4)
        name = cd[o + 46:o + 46 + nlen].decode("utf-8" if flag & 0x800 else "cp437", "replace")
        xo = o + 46 + nlen
        xe = xo + xlen
        while xo + 4 <= xe:
            hid, hlen = struct.unpack_from("<HH", cd, xo)
            extras[f"{hid:#06x}"] += 1
            if hid == 0x0001:  # zip64 extra
                vals = list(struct.unpack_from("<%dQ" % (hlen // 8), cd, xo + 4))
                if usize == 0xFFFFFFFF: usize = vals.pop(0)
                if csize == 0xFFFFFFFF: csize = vals.pop(0)
                if lho == 0xFFFFFFFF: lho = vals.pop(0)
            xo += 4 + hlen
        o = xe + cmlen
        if name.endswith("/"):
            continue
        files += 1
        methods[method] += 1
        flags[f"{flag:#06x}"] += 1
        base = name.rsplit("/", 1)[-1].lower()
        ext = base.rsplit(".", 1)[-1] if "." in base else "(none)"
        # CryEngine split mips: foo.dds.1 ... foo.dds.9, foo.dds.1a
        if ext.rstrip("a").isdigit() and ".dds." in base:
            ext = "dds.N (mip)"
        e = by_ext[ext]
        e[0] += 1; e[1] += usize; e[2] += csize
        top_dirs[name.split("/", 1)[0].lower() if "/" in name else "(root)"] += usize
        if len(sample) < 8 or files % 5000 == 0:
            sample.append((name, lho, nlen, method))
    r["files"] = files
    r["methods"] = dict(methods)
    r["flags"] = dict(flags)
    r["extra_fields"] = dict(extras)
    r["by_ext"] = {k: v for k, v in by_ext.items()}
    r["top_dirs"] = dict(top_dirs)
    r["uncompressed"] = sum(v[1] for v in by_ext.values())

    # verify a sample of local headers agree with the central directory
    with open(path, "rb") as f:
        for name, lho, nlen, method in sample:
            f.seek(lho)
            lh = f.read(30)
            if len(lh) < 30 or struct.unpack_from("<I", lh)[0] != LFH_SIG:
                r["issues"].append(f"bad local header for {name}")
                continue
            lmethod, lnlen = struct.unpack_from("<H", lh, 8)[0], struct.unpack_from("<H", lh, 26)[0]
            if lmethod != method or lnlen != nlen:
                r["issues"].append(f"LFH mismatch for {name}: method {lmethod}/{method} nlen {lnlen}/{nlen}")
    return r


def main():
    root = sys.argv[1]
    out_json = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None
    paks = sorted(os.path.join(dp, fn) for dp, _, fns in os.walk(root)
                  for fn in fns if fn.lower().endswith(".pak"))
    results = []
    for p in paks:
        try:
            r = survey(p)
        except Exception as e:
            r = {"path": p, "size": os.path.getsize(p), "issues": [f"parse error: {e}"]}
        rel = os.path.relpath(p, root)
        r["path"] = rel
        results.append(r)
        print(f"{rel:70s} {r['size'] / 2**20:10.1f} MiB  files={r.get('files', '?'):>6}  "
              f"methods={r.get('methods')}  zip64={r.get('zip64')}  "
              f"flags={r.get('flags')}  extra={r.get('extra_fields')}"
              f"{'  ISSUES: ' + '; '.join(r['issues']) if r['issues'] else ''}")
    if out_json:
        with open(out_json, "w") as f:
            json.dump(results, f, indent=1)


if __name__ == "__main__":
    main()
