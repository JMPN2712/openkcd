#!/bin/sh
# Clean-room audit of a range of commits (a pull request): no game files,
# large binaries or decompiler output in the files, and no internals
# wording in commit messages. Run before opening a PR and in CI:
#   tools/audit.sh BASE [HEAD]
# CI also passes the PR title and body in PR_TEXT.

base=${1:?usage: tools/audit.sh BASE [HEAD]}
head=${2:-HEAD}
fail=0
say() { echo "audit: $*"; fail=1; }

MAX_BYTES=1048576
MAX_BINARY_BYTES=102400
GAME_EXT='pak|dds|dds\.[0-9a-z]+|cgf|cgfm|cga|cgam|chr|chrm|chrparams|skin|skinm|cdf|caf|dba|img|animevents|bspace|comb|adb|mtl|fsb|wem|bnk|bik|usm|ogg|opus|mp3|wav|gfx|swf|ctc|nav|tif|exe|bin|dll|pdb|so|gzf|rep'
# Words that belong in the private research repo, never in this one's
# commit messages or pull requests (the docs may state the rules).
WORDS='ghidra|decompil|disassembl|\bida pro\b|[a-z0-9_]+\.dll\b'
MARKERS='\b(FUN|DAT|LAB|PTR|thunk_FUN)_[0-9a-fA-F]{8,}\b|\bundefined[1248]\b|\bin_stack_[0-9a-f]+\b|\bextraout_[A-Z]'
# Files that state the rules, and so name what they forbid.
RULES=':(exclude).githooks/*'
RULES2=':(exclude)tools/audit.sh'
RULES3=':(exclude)CONTRIBUTING.md'
RULES4=':(exclude)CLAUDE.md'
RULES5=':(exclude).claude/*'

for f in $(git diff --name-only --diff-filter=ACMR "$base" "$head"); do
  lower=$(printf '%s' "$f" | tr 'A-Z' 'a-z')
  printf '%s' "$lower" | grep -Eq "\.($GAME_EXT)\$" && { say "game or binary file type: $f"; continue; }
  size=$(git cat-file -s "$head:$f" 2>/dev/null || echo 0)
  [ "$size" -gt "$MAX_BYTES" ] && { say "file over 1 MB ($size bytes): $f"; continue; }
  if [ "$size" -gt "$MAX_BINARY_BYTES" ] && git diff --numstat "$base" "$head" -- "$f" | grep -q '^-'; then
    say "binary over 100 KB ($size bytes): $f"
  fi
done

added=$(git diff -U0 --diff-filter=ACMR "$base" "$head" -- . "$RULES" "$RULES2" "$RULES3" "$RULES4" "$RULES5" | grep -E '^\+[^+]')
hits=$(printf '%s\n' "$added" | grep -nE "$MARKERS" | head -5)
[ -n "$hits" ] && say "decompiler-style names in added lines:" && printf '%s\n' "$hits" | cut -c1-160
hits=$(printf '%s\n' "$added" | grep -nE '/home/[a-z]|/Users/[A-Za-z]' | head -5)
[ -n "$hits" ] && say "home paths in added lines:" && printf '%s\n' "$hits" | cut -c1-160

msgs=$(git log --format='%B' "$base..$head"; printf '%s\n' "${PR_TEXT:-}")
hits=$(printf '%s\n' "$msgs" | grep -niE "$WORDS|$MARKERS" | head -5)
[ -n "$hits" ] && say "internals wording in commit messages or the PR text:" && printf '%s\n' "$hits" | cut -c1-160

bad=$(git log --format='%ae %ce' "$base..$head" | tr ' ' '\n' | grep -v '@users.noreply.github.com$' | grep -v '^noreply@github.com$' | sort -u)
[ -n "$bad" ] && say "commit e-mail addresses that aren't GitHub no-reply ones: $bad"

[ "$fail" -eq 0 ] && echo "audit: clean ($(git rev-list --count "$base..$head") commits)"
exit $fail
