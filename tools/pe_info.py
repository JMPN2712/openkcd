#!/usr/bin/env python3
"""Minimal read-only PE32+ inspector: sections, imports, export count,
VS_VERSIONINFO strings and PDB path. No third-party deps.

usage: python3 -I pe_info.py [--imports] FILE...
"""
import struct
import sys


def rva_to_off(sections, rva):
    for name, va, vsize, raw, rawsize in sections:
        if va <= rva < va + max(vsize, rawsize):
            return rva - va + raw
    return None


def cstr(buf, off):
    end = buf.index(b"\0", off)
    return buf[off:end].decode("latin-1")


def parse(path, show_imports):
    buf = open(path, "rb").read()
    pe = struct.unpack_from("<I", buf, 0x3C)[0]
    assert buf[pe:pe + 4] == b"PE\0\0", "not a PE file"
    machine, nsec, timestamp = struct.unpack_from("<HHI", buf, pe + 4)
    opt_size = struct.unpack_from("<H", buf, pe + 20)[0]
    opt = pe + 24
    magic = struct.unpack_from("<H", buf, opt)[0]
    dd = opt + (112 if magic == 0x20B else 96)
    dirs = [struct.unpack_from("<II", buf, dd + 8 * i) for i in range(16)]
    sections = []
    so = opt + opt_size
    for i in range(nsec):
        name = buf[so + 40 * i: so + 40 * i + 8].rstrip(b"\0").decode()
        vsize, va, rawsize, raw = struct.unpack_from("<IIII", buf, so + 40 * i + 8)
        sections.append((name, va, vsize, raw, rawsize))

    import datetime
    print(f"== {path}")
    print(f"  timestamp: {datetime.datetime.fromtimestamp(timestamp, datetime.UTC):%Y-%m-%d %H:%M} UTC")
    print("  sections: " + ", ".join(f"{s[0]}={s[4] // 1024}K" for s in sections))

    # exports
    erva, esz = dirs[0]
    if erva:
        eo = rva_to_off(sections, erva)
        nfuncs, nnames = struct.unpack_from("<II", buf, eo + 20)
        dllname = cstr(buf, rva_to_off(sections, struct.unpack_from("<I", buf, eo + 12)[0]))
        names_off = rva_to_off(sections, struct.unpack_from("<I", buf, eo + 32)[0])
        names = [cstr(buf, rva_to_off(sections, struct.unpack_from("<I", buf, names_off + 4 * i)[0]))
                 for i in range(min(nnames, 40))]
        print(f"  exports: {nfuncs} funcs as '{dllname}': {', '.join(names[:40])}")

    # imports
    irva, _ = dirs[1]
    if irva:
        io = rva_to_off(sections, irva)
        libs = []
        while True:
            oft, _, _, name_rva, ft = struct.unpack_from("<IIIII", buf, io)
            if not name_rva:
                break
            lib = cstr(buf, rva_to_off(sections, name_rva))
            funcs = []
            if show_imports:
                to = rva_to_off(sections, oft or ft)
                while True:
                    ent = struct.unpack_from("<Q", buf, to)[0]
                    if not ent:
                        break
                    if not ent >> 63:
                        funcs.append(cstr(buf, rva_to_off(sections, ent & 0x7FFFFFFF) + 2))
                    to += 8
            libs.append((lib, funcs))
            io += 20
        print("  imports: " + ", ".join(l for l, _ in libs))
        for lib, funcs in libs:
            if funcs:
                print(f"    {lib}: {', '.join(funcs[:25])}{' ...' if len(funcs) > 25 else ''}")

    # debug directory -> PDB path
    drva, dsz = dirs[6]
    if drva:
        do = rva_to_off(sections, drva)
        for i in range(dsz // 28):
            typ, _, _, ptr = struct.unpack_from("<12xIIII", buf, do + 28 * i)[0:4]
            if typ == 2:
                raw = struct.unpack_from("<I", buf, do + 28 * i + 24)[0]
                if buf[raw:raw + 4] == b"RSDS":
                    print(f"  pdb: {cstr(buf, raw + 24)}")

    # version resource strings (heuristic scan of UTF-16LE key/value pairs)
    i = buf.find("StringFileInfo".encode("utf-16le"))
    if i >= 0:
        for key in ("CompanyName", "FileDescription", "FileVersion", "ProductName",
                    "ProductVersion", "OriginalFilename", "LegalCopyright"):
            k = buf.find((key + "\0").encode("utf-16le"), i, i + 4000)
            if k < 0:
                continue
            v = k + len(key) * 2 + 2
            v += (-v) % 4  # values are DWORD aligned
            end = v
            while end < len(buf) - 1 and buf[end:end + 2] != b"\0\0":
                end += 2
            print(f"  {key}: {buf[v:end].decode('utf-16le', 'replace')}")


if __name__ == "__main__":
    args = sys.argv[1:]
    show = "--imports" in args
    for p in [a for a in args if a != "--imports"]:
        try:
            parse(p, show)
        except Exception as e:  # keep going on odd files
            print(f"== {p}\n  error: {e}")
