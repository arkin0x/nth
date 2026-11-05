#!/usr/bin/env bash
# headers_publish.sh: commit what scripts/headers_head.py wrote into a
# headers-v1 checkout, and push it. Run from inside that checkout.
#
#   headers_publish.sh propose <height>   push a NEW branch auto/headers-head-<height>
#   headers_publish.sh publish <height>   fast-forward headers-v1 itself
#
# It is the only part of the weekly job that writes a ref, so every guard is
# here, and test/test_headers_publish.py runs each one against a local bare
# repository:
#
#   - Only manifest.json and headers-NNN.bin may change, and nothing may be
#     deleted.
#   - The only existing blob that may change is the previous head (the last
#     blob, when it held fewer than blobSize headers), and its old bytes must
#     stay a prefix of the new file. Finalized blobs never change.
#   - Never a force push. propose never moves an existing branch (a rerun
#     that finds the branch already holding exactly this proposal succeeds);
#     publish pushes only when the remote headers-v1 is still the commit this
#     checkout started from, so the push is a fast-forward or nothing.
#
# The headers themselves are checked by headers_head.py before this runs
# (the whole line from genesis, the new headers, two cross-check sources) and
# again in the directory it wrote. This script checks the git side only.
#
# Environment: RUN_URL (named in the commit message), HEADERS_REMOTE (default
# origin). Exit 0 on success, 1 on any refusal, with the reason on stdout.
set -euo pipefail

mode=${1:-}
height=${2:-}
remote=${HEADERS_REMOTE:-origin}
run_url=${RUN_URL:-a local run}
# A checkout made with persist-credentials: false pushes with the gh CLI's
# token; a local file remote never asks for one.
auth=(-c credential.helper= -c 'credential.helper=!gh auth git-credential')

case "$mode" in propose | publish) ;; *) echo "usage: headers_publish.sh <propose|publish> <height>"; exit 1 ;; esac
case "$height" in '' | *[!0-9]*) echo "refusing: the height '$height' is not a number"; exit 1 ;; esac
branch="auto/headers-head-$height"

# What may change.
bad=$(git status --porcelain | grep -v -E '^( M manifest\.json| M headers-[0-9]{3}\.bin|\?\? headers-[0-9]{3}\.bin)$' || true)
if [ -n "$bad" ]; then echo "refusing: unexpected changes: $bad"; exit 1; fi
if git diff --quiet -- manifest.json; then echo "refusing: manifest.json is unchanged, so there is nothing to publish"; exit 1; fi
old_head=$(git show HEAD:manifest.json | python3 -I -c 'import json,sys; m=json.load(sys.stdin); b=m["blobs"][-1]; print(b["file"] if b["count"] < m["blobSize"] else "")')
for f in $(git diff --name-only -- 'headers-*.bin'); do
  if [ "$f" != "$old_head" ]; then echo "refusing: $f is a finalized blob and must never change"; exit 1; fi
  size=$(git cat-file -s "HEAD:$f")
  tmp=$(mktemp)
  git show "HEAD:$f" > "$tmp"
  if ! cmp -s -n "$size" "$tmp" "$f"; then rm -f "$tmp"; echo "refusing: $f is not an append to the old head"; exit 1; fi
  rm -f "$tmp"
done
# The new manifest must reach the height it is published as.
reach=$(python3 -I -c 'import json; print(int(json.load(open("manifest.json"))["generatedAtHeight"]))')
if [ "$reach" != "$height" ]; then echo "refusing: manifest.json reaches $reach, not $height"; exit 1; fi

base=$(git rev-parse HEAD)
git switch -q -c "$branch"
git add manifest.json headers-*.bin
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit -q -m "headers-v1: head blob to checkpoint $height" \
  -m "$([ "$mode" = publish ] && echo "Published" || echo "Proposed") by .github/workflows/headers-head.yml ($run_url)."

if [ "$mode" = propose ]; then
  if git "${auth[@]}" ls-remote --exit-code --heads "$remote" "$branch" >/dev/null; then
    # Never move an existing ref. A rerun whose branch already holds exactly
    # this proposal goes on to open it; anything else stops.
    git "${auth[@]}" fetch -q "$remote" "refs/heads/$branch"
    if [ "$(git rev-parse 'FETCH_HEAD^{tree}')" = "$(git rev-parse 'HEAD^{tree}')" ]; then
      echo "$branch already holds this proposal"; exit 0
    fi
    echo "refusing: $branch already exists on the remote with other content"; exit 1
  fi
  git "${auth[@]}" push -q "$remote" "HEAD:refs/heads/$branch"
  echo "proposed $branch"
  exit 0
fi

# publish: only on top of the headers-v1 this checkout started from.
live=$(git "${auth[@]}" ls-remote --heads "$remote" headers-v1 | cut -f1)
if [ "$live" != "$base" ]; then
  echo "refusing: headers-v1 on $remote is ${live:-missing}, not $base, the commit this run verified on top of"; exit 1
fi
# No --force and no + in the refspec: the remote refuses anything but a fast-forward.
git "${auth[@]}" push -q "$remote" "HEAD:refs/heads/headers-v1"
echo "published headers-v1 to $height ($(git rev-parse --short HEAD))"
