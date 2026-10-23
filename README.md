# headers-v1

Statically served Bitcoin header blobs for ONOSENDAI's hyperspace sync,
fetched by browsers from this branch via raw.githubusercontent.com (GitHub
release assets send no CORS header; raw does).

Format spec: docs/HEADER-BLOBS.md on the v3-anchors branch. The blobs are
self-verifying (SPV linkage + proof of work + pinned checkpoints); the
manifest's sha256 entries are transport integrity only.

Finalized blobs (50,000 records) are never rewritten. The last blob, the
head, may be partial: it ends exactly on a checkpoint height (h % 1000 == 999,
at least 100 blocks below the tip when it was cut) and only ever grows by
appending records, so its old bytes are always a prefix of the new file. Past
a 50,000 boundary it is finished and the next ordinal becomes the head.

The head is grown by `scripts/headers_head.py` on the master branch, which a
weekly workflow (`.github/workflows/headers-head.yml` on master) runs and
proposes here as a pull request; it never merges. The tool re-verifies the
whole line from genesis (linkage, proof of work, exact retargets, median time
past, the 19 pinned checkpoints) and cross-checks every checkpoint height it
adds against two explorers that are not its source. A reader that fetches the
head re-verifies it whenever its sha256 changes; one that already holds some
of its heights (ONOSENDAI with a warm cache) may skip it and take those
heights from the relay instead.
