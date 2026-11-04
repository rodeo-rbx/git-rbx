#!/usr/bin/env bash
# Regenerates the README's screenshots in docs/images from example models.
# See README.md here for what it needs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
images="$root/docs/images"

for tool in cargo lune node npm; do
	command -v "$tool" >/dev/null || {
		echo "make.sh: $tool isn't on PATH" >&2
		exit 1
	}
done
# RHR and OXIPNG name the executables when PATH's copies don't run (a mise
# shim with no version set, say).
RHR="${RHR:-rhr}"
OXIPNG="${OXIPNG:-oxipng}"
"$RHR" --version >/dev/null 2>&1 || {
	echo "make.sh: $RHR doesn't run; set RHR to roblox-headless-renderer's rhr" >&2
	exit 1
}
RHR="$(command -v "$RHR")"
export RHR

# This checkout's git-rbx, so the screenshots show its output.
cargo build --release --quiet --manifest-path "$root/Cargo.toml"
export PATH="$root/target/release:$PATH"
export GIT_RBX="$root/target/release/git-rbx"

[ -d "$here/node_modules" ] || npm ci --prefix "$here" --silent

# Resolved, because git reports a repository's real path (macOS's temp
# directory is behind a symlink), and the extension finds files relative to it.
work="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$work"' EXIT
export STORAGE="$work/storage"
demo="$work/demo"

# The demo repository. Fixed authors and dates keep its commit hashes, which
# the screenshots show, the same from run to run.
export GIT_AUTHOR_NAME=git-rbx GIT_AUTHOR_EMAIL=git-rbx@example.com GIT_AUTHOR_DATE=2026-11-04T12:00:00Z
export GIT_COMMITTER_NAME=git-rbx GIT_COMMITTER_EMAIL=git-rbx@example.com GIT_COMMITTER_DATE=2026-11-04T12:00:00Z
git init -q -b main "$demo"
cd "$demo"
git rbx install --local >/dev/null
mkdir models
lune run "$here/examples.luau" town before models/town.rbxm >/dev/null
lune run "$here/examples.luau" campfire orange models/campfire.rbxm >/dev/null
git add -A
git commit -q -m "Add the town and the campfire"
lune run "$here/examples.luau" town moved models/town.rbxm >/dev/null
git commit -q -am "Move the house and replant the trees"
# Left uncommitted: `git diff` and Source Control show it.
lune run "$here/examples.luau" campfire blue models/campfire.rbxm >/dev/null

before="$(git rev-parse HEAD~1)"
after="$(git rev-parse HEAD)"
viewer="$here/viewer.js"
HEIGHT=545 node "$viewer" "$images/viewer-pivots.png" diff "$demo" "$before" models/town.rbxm "$after"
HEIGHT=820 CLICKS='["text=\"House\"", "text=\"Door\""]' node "$viewer" "$images/viewer-model.png" view "$demo/models/town.rbxm"
# "~" is the ref Source Control opens a working tree change against.
HEIGHT=780 node "$viewer" "$images/viewer-particles.png" diff "$demo" "~" models/campfire.rbxm

terminal="$here/terminal.js"
node "$terminal" "$demo" "$images/cli-diff.png" "git diff"
node "$terminal" "$demo" "$images/cli-pivots.png" "git diff HEAD~1 HEAD"
node "$terminal" "$demo" "$images/cli-line-diff.png" "git log -p -1 --format=%s -- models/town.rbxm | head -40"

if "$OXIPNG" --version >/dev/null 2>&1; then
	"$OXIPNG" -o 4 --strip safe -q "$images"/*.png
else
	echo "make.sh: no oxipng, so the PNGs aren't optimized" >&2
fi

# The README quotes these.
line_diff="$(git log -p -1 --format= -- models/town.rbxm)"
echo "The line diff of the town commit: $(grep -c '^[-+] ' <<<"$line_diff") changed lines in $(grep -c '^@@' <<<"$line_diff") hunks."
