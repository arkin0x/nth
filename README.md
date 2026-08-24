# headers-v1

Statically served Bitcoin header blobs for ONOSENDAI's hyperspace sync,
fetched by browsers from this branch via raw.githubusercontent.com (GitHub
release assets send no CORS header; raw does).

Format spec: docs/HEADER-BLOBS.md on the v3-anchors branch. The blobs are
self-verifying (SPV linkage + proof of work + pinned checkpoints); the
manifest's sha256 entries are transport integrity only.

Append new finalized blobs and an updated manifest.json with the packager
(npm run pack in the nth deployment); never rewrite existing blobs.
