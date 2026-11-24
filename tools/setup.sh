#!/bin/sh
# One-time setup of an OpenKCD checkout on a new machine (macOS, Linux, WSL).
# Safe to run again: it keeps what is there and only fills in what is missing.
#
#   tools/setup.sh                      # asks for the paths it can't guess
#   tools/setup.sh --yes                # takes the defaults, asks nothing
#   tools/setup.sh --game ~/kcd1 --installers ~/Downloads/kingdom_come_deliverance \
#                  --research ~/openkcd-research --chrome /path/to/chrome
#
# What it does:
#   1. checks git and Node (the version in web/.node-version or newer)
#   2. enables the repository's git hooks (no game files in commits)
#   3. sets this clone's commit e-mail to your GitHub no-reply address (via gh)
#   4. installs the web app's packages (npm ci in web/)
#   5. writes .openkcd.json: this machine's game folder, installers and Chrome
#      (gitignored; scripts read it through web/scripts/paths.ts)
#   6. writes CLAUDE.local.md (this machine's notes for Claude Code) if missing
#   7. adds this machine's absolute path of the clean-room folder to
#      .claude/settings.local.json (the repo's settings deny it by ~ path)
#   8. type-checks, and finds Chrome and the game
#
# It never needs sudo, and never touches the game or installer folders.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"

yes=0 game="" installers="" research="" chrome="" skip_npm=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) yes=1 ;;
    --game) game=$2; shift ;;
    --installers) installers=$2; shift ;;
    --research) research=$2; shift ;;
    --chrome) chrome=$2; shift ;;
    --no-npm) skip_npm=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "setup: unknown option $1 (see --help)"; exit 2 ;;
  esac
  shift
done

ok() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33mnote\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mfail\033[0m %s\n' "$*"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
# ~/x → $HOME/x (cut, not ${1#~/}: the shell expands that ~ itself)
expand() { case "$1" in "~/"*) printf '%s/%s' "$HOME" "$(printf '%s' "$1" | cut -c3-)" ;; *) printf '%s' "$1" ;; esac; }
# ask VAR "question" DEFAULT: the flag's value, else the answer, else the default
ask() {
  eval "cur=\${$1}"
  if [ -z "$cur" ]; then
    if [ "$yes" -eq 1 ] || [ ! -t 0 ]; then cur=$3
    else printf '  %s [%s]: ' "$2" "$3"; read -r cur; [ -n "$cur" ] || cur=$3; fi
  fi
  eval "$1=\$(expand \"\$cur\")"
}
# the current value in .openkcd.json, if any
cfg() { [ -f .openkcd.json ] && node -e 'const c=JSON.parse(require("fs").readFileSync(".openkcd.json","utf8"));process.stdout.write(c[process.argv[1]]??"")' "$1" 2>/dev/null || true; }

os=$(uname -s)
case "$os" in Darwin) platform=macos ;; Linux) platform=linux; grep -qi microsoft /proc/version 2>/dev/null && platform=wsl ;; *) platform=other ;; esac

step "1. Tools"
command -v git >/dev/null || fail "git is missing"
ok "git $(git --version | cut -d' ' -f3)"
want=$(tr -dc '0-9.' < web/.node-version | cut -d. -f1)
if ! command -v node >/dev/null; then
  fail "Node.js is missing. Install Node $want or newer (https://nodejs.org, or: nvm install $want / fnm install $want / brew install node)"
fi
have=$(node -p 'process.versions.node.split(".")[0]')
[ "$have" -ge "$want" ] || fail "Node $(node -v) is too old: the scripts run TypeScript directly, which needs Node $want+ (nvm install $want, fnm install $want or brew upgrade node)"
ok "node $(node -v)"

step "2. Git hooks"
git config core.hooksPath .githooks
ok "core.hooksPath = .githooks (blocks game files and large binaries in commits)"

step "3. Commit e-mail"
email=$(git config --local user.email || true)
case "$email" in
  *@users.noreply.github.com) ok "this clone commits as $email" ;;
  *)
    if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
      noreply=$(gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')
      git config --local user.email "$noreply"
      [ -n "$(git config --local user.name || true)" ] || git config --local user.name "$(gh api user --jq '.login')"
      ok "this clone commits as $noreply (your GitHub no-reply address)"
    else
      warn "set a GitHub no-reply address for this clone (the audit rejects others):"
      warn "  git config user.email ID+LOGIN@users.noreply.github.com   (or: gh auth login, then run setup again)"
    fi ;;
esac

step "4. Packages"
if [ "$skip_npm" -eq 1 ]; then warn "skipped (--no-npm)"
else (cd web && npm ci --no-audit --no-fund --loglevel=error) && ok "web/node_modules installed"; fi

step "5. This machine's paths (.openkcd.json)"
d_game=$(cfg gameRoot); [ -n "$d_game" ] || d_game="$HOME/kcd1"
d_inst=$(cfg installers); [ -n "$d_inst" ] || d_inst="$HOME/Downloads/kingdom_come_deliverance"
d_chrome=$(cfg chrome)
if [ -z "$d_chrome" ]; then
  case "$platform" in
    macos) d_chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ;;
    *) d_chrome=$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser || echo google-chrome) ;;
  esac
fi
ask game "Installed game folder (holds Data, Engine, Bin)" "$d_game"
ask installers "GOG offline installers folder" "$d_inst"
ask chrome "Chrome for the headless harnesses" "$d_chrome"
node -e '
  const [game, installers, chrome] = process.argv.slice(1);
  require("fs").writeFileSync(".openkcd.json", JSON.stringify({ gameRoot: game, installers, chrome }, null, 2) + "\n");
' "$game" "$installers" "$chrome"
ok "wrote .openkcd.json (gitignored)"

step "6. CLAUDE.local.md"
d_research=$(dirname "$repo")/openkcd-research
ask research "Private research repo (notes for implementation)" "$d_research"
forbidden=$(node -e '
  const s = JSON.parse(require("fs").readFileSync(".claude/settings.json", "utf8"));
  const d = (s.permissions?.deny ?? []).map((x) => /^Read\((.*)\/\*\*\)$/.exec(x)?.[1]).find(Boolean);
  process.stdout.write(d ?? "");
')
forbidden_abs=$(expand "$forbidden")
if [ -f CLAUDE.local.md ]; then ok "kept the existing CLAUDE.local.md"
else
  cpu=$( (sysctl -n machdep.cpu.brand_string 2>/dev/null || grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2) | sed 's/^ *//')
  mem=$( (sysctl -n hw.memsize 2>/dev/null | awk '{printf "%d GB", $1/1073741824}') || true)
  [ -n "$mem" ] || mem=$(awk '/MemTotal/ {printf "%d GB", $2/1048576}' /proc/meminfo 2>/dev/null || true)
  cat > CLAUDE.local.md <<EOF
# This machine (not committed; written by tools/setup.sh)

$platform, ${cpu:-unknown CPU}, ${mem:-unknown memory}. Set up $(date +%Y-%m-%d).

## Paths

- **This checkout:** \`$repo\`
- **Game root (installed copy, read-only):** \`$game\`. Every script defaults
  to it (\`.openkcd.json\`, \`web/scripts/paths.ts\`); \`--root\` overrides.
- **GOG offline installers (read-only):** \`$installers\`
- **Research repo:** \`$research\` (notes in \`notes/\`).
- **Clean-room folder: \`$forbidden_abs\`. Never read, list, edit or
  mention it in a command from this repo.** \`.claude/settings.json\` denies
  it and a Bash hook blocks commands naming it; \`.claude/settings.local.json\`
  repeats the deny for this machine's absolute path.

## Chrome

- Headless harnesses start \`$chrome\` (\`.openkcd.json\`; \`CHROME=\` overrides).
EOF
  case "$platform" in
    macos) printf -- '- macOS runs WebGPU on Metal: no extra flags. Benchmarks from here are labelled\n  with this Mac'"'"'s GPU in docs/PERFORMANCE.md.\n' >> CLAUDE.local.md ;;
    linux|wsl) printf -- '- Linux needs Vulkan for WebGPU (`--enable-features=Vulkan`; the harnesses\n  pass it) and, on Wayland, `--ozone-platform=x11` for a visible Chrome.\n' >> CLAUDE.local.md ;;
  esac
  printf '\n## Git\n\n- Repo-local `user.email` is the GitHub no-reply address; `core.hooksPath` is `.githooks`.\n' >> CLAUDE.local.md
  ok "wrote CLAUDE.local.md"
fi

step "7. Claude Code: this machine's clean-room deny"
if [ -n "$forbidden_abs" ]; then
  node -e '
    const fs = require("fs"), f = ".claude/settings.local.json", abs = process.argv[1];
    const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    s.permissions ??= {}; s.permissions.deny ??= [];
    const shared = JSON.parse(fs.readFileSync(".claude/settings.json", "utf8")).permissions?.deny ?? [];
    for (const r of [...shared, `Read(/${abs}/**)`, `Edit(/${abs}/**)`]) if (!s.permissions.deny.includes(r)) s.permissions.deny.push(r);
    fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
  ' "$forbidden_abs"
  ok "denied in .claude/settings.local.json (gitignored)"
else warn "no clean-room folder found in .claude/settings.json"; fi

step "8. Checks"
(cd web && npx tsc --noEmit) && ok "type check"
if [ -x "$chrome" ] || command -v "$chrome" >/dev/null 2>&1; then ok "Chrome found"
else warn "Chrome not found at $chrome: the browser harnesses need it (set it with --chrome or CHROME=)"; fi
if [ -d "$game/Data" ] || [ -d "$game/data" ]; then ok "game found at $game"
else warn "no game at $game: the tests read the installed game (install it there, or rerun with --game DIR)"; fi
[ -d "$installers" ] && ok "installers folder found" || warn "no installers at $installers (only the installer tests need them)"
[ -d "$research" ] && ok "research repo found" || warn "no research repo at $research (implementation work reads its notes)"
case "$platform" in linux|wsl) warn "Linux: turn on chrome://flags/#enable-vulkan for WebGPU in your own Chrome (docs/BUILDING.md)" ;; esac

step "Done"
echo "  Run the app:     cd web && npm run dev"
echo "  Quick checks:    tools/check.sh          (type check and the headless tests)"
echo "  More:            docs/BUILDING.md"
