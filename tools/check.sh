#!/bin/sh
# The checks before a commit or a PR, on any machine set up with tools/setup.sh:
# the type check, the headless tests that read the installed game, then the
# clean-room audit against origin/main.
#   tools/check.sh            # type check, the headless tests and the audit
#   tools/check.sh --quick    # type check and the fast tests only (no browser)
#   tools/check.sh --browser  # also the tests that drive headless Chrome
# Each test's output goes to $TMPDIR/openkcd-check/<test>.log; a summary at the end.
set -u
repo=$(cd "$(dirname "$0")/.." && pwd)
quick=0 browser=0
for a in "$@"; do case "$a" in --quick) quick=1 ;; --browser) browser=1 ;; -h|--help) sed -n '2,9p' "$0"; exit 0 ;; esac; done
logs="${TMPDIR:-/tmp}/openkcd-check"; mkdir -p "$logs"
cd "$repo/web"
failed=""
run() {
  printf '%-28s' "$1"
  start=$(date +%s)
  if node "scripts/$1.ts" > "$logs/$1.log" 2>&1; then printf 'ok    %4ss\n' $(( $(date +%s) - start ))
  else printf 'FAIL  %4ss  (%s)\n' $(( $(date +%s) - start )) "$logs/$1.log"; failed="$failed $1"; fi
}
printf '%-28s' "type check"
if npx tsc --noEmit > "$logs/tsc.log" 2>&1; then echo ok; else echo "FAIL  ($logs/tsc.log)"; failed="$failed tsc"; fi
FAST="test-btrun test-dialogue-flow test-npcs test-crowd test-walls"
SLOW="test-quest-opening test-btworld test-beds test-doors test-dialogue test-pak test-streaming test-release"
BROWSER="test-dialogue-browser"
for t in $FAST; do run "$t"; done
[ "$quick" -eq 1 ] || for t in $SLOW; do run "$t"; done
[ "$browser" -eq 1 ] && for t in $BROWSER; do run "$t"; done
if [ "$quick" -eq 0 ]; then
  printf '%-28s' "audit (origin/main)"
  if (cd "$repo" && git fetch -q origin main 2>/dev/null; tools/audit.sh origin/main > "$logs/audit.log" 2>&1); then echo ok; else echo "FAIL  ($logs/audit.log)"; failed="$failed audit"; fi
fi
[ -z "$failed" ] && { echo "all checks passed"; exit 0; }
echo "failed:$failed"; exit 1
