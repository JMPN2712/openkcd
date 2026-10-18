#!/usr/bin/env python3
"""Tolerant read-only CryEngine pak reader. Trusts the central directory only
(local headers may use backslashes and zeroed sizes), reads file data on
demand. Also usable as a CLI to sample files without extracting to disk.

usage:
  python3 -I pakread.py PAK list [GLOB]
  python3 -I pakread.py PAK head NAME [N]      # hex+ascii of first N bytes
  python3 -I pakread.py PAK cat NAME           # raw bytes to stdout
"""
import fnmatch
import struct
import sys
import zlib


class Entry:
    __slots__ = ("name", "method", "flag", "crc", "csize", "usize", "lho")


def entries(path):
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        tail = min(size, 65558)
        f.seek(size - tail)
        buf = f.read(tail)
        i = buf.rfind(b"PK\x05\x06")
        _, _, _, _, n, cd_size, cd_off, _ = struct.unpack_from("<IHHHHIIH", buf, i)
        f.seek(cd_off)
        cd = f.read(cd_size)
    o = 0
    for _ in range(n):
        (flag, method, crc, csize, usize, nlen, xlen, clen, lho) = struct.unpack_from(
            "<8xHH4xIII HHH8xI".replace(" ", ""), cd, o)
        e = Entry()
        e.name = cd[o + 46:o + 46 + nlen].decode("utf-8" if flag & 0x800 else "cp437").replace("\\", "/")
        e.method, e.flag, e.crc, e.csize, e.usize, e.lho = method, flag, crc, csize, usize, lho
        o += 46 + nlen + xlen + clen
        if not e.name.endswith("/"):
            yield e


def read(path, e, limit=None):
    with open(path, "rb") as f:
        f.seek(e.lho)
        lh = f.read(30)
        assert lh[:4] == b"PK\x03\x04", "bad local header"
        nlen, xlen = struct.unpack_from("<HH", lh, 26)
        f.seek(e.lho + 30 + nlen + xlen)
        if e.method == 0:
            return f.read(e.csize if limit is None else min(limit, e.csize))
        if e.method == 8:
            d = zlib.decompressobj(-15)
            out = d.decompress(f.read(e.csize), limit or 0)
            if limit is None:
                assert zlib.crc32(out) == e.crc, f"CRC mismatch on {e.name}"
            return out
        raise ValueError(f"unsupported method {e.method}")


def main():
    pak, cmd = sys.argv[1], sys.argv[2]
    es = {e.name.lower(): e for e in entries(pak)}
    if cmd == "list":
        g = sys.argv[3].lower() if len(sys.argv) > 3 else "*"
        for k, e in es.items():
            if fnmatch.fnmatch(k, g):
                print(f"{e.usize:>12} {e.csize:>12} m{e.method} {e.name}")
    elif cmd == "head":
        e = es[sys.argv[3].lower()]
        b = read(pak, e, int(sys.argv[4]) if len(sys.argv) > 4 else 64)
        print(b[:int(sys.argv[4]) if len(sys.argv) > 4 else 64])
    elif cmd == "cat":
        sys.stdout.buffer.write(read(pak, es[sys.argv[3].lower()]))


if __name__ == "__main__":
    main()
