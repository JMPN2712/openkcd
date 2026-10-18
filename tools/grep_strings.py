#!/usr/bin/env python3
"""Read-only: extract printable ASCII + UTF-16LE strings from a binary and
print those matching a regex (case-insensitive), deduplicated.

usage: python3 -I grep_strings.py FILE REGEX [min_len] [max_hits]
"""
import mmap
import re
import sys

path, pattern = sys.argv[1], re.compile(sys.argv[2].encode(), re.I)
min_len = int(sys.argv[3]) if len(sys.argv) > 3 else 5
max_hits = int(sys.argv[4]) if len(sys.argv) > 4 else 400

with open(path, "rb") as f:
    mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    ascii_re = re.compile(rb"[\x20-\x7e]{%d,}" % min_len)
    utf16_re = re.compile(rb"(?:[\x20-\x7e]\x00){%d,}" % min_len)
    seen = set()
    for rx, dec in ((ascii_re, lambda b: b), (utf16_re, lambda b: b.decode("utf-16le").encode())):
        for m in rx.finditer(mm):
            s = dec(m.group())
            if s in seen or not pattern.search(s):
                continue
            seen.add(s)
            print(s.decode("latin-1")[:300])
            if len(seen) >= max_hits:
                sys.exit(0)
