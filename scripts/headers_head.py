#!/usr/bin/env python3
"""headers_head.py: grow the headers-v1 head blob to the next checkpoint.

The headers-v1 branch serves the Bitcoin header line as 50,000-block blobs
(docs/HEADER-BLOBS.md on v3-anchors). Finalized blobs never change. The last
blob, the head, may be partial; this tool appends to it (and, past a 50,000
boundary, finishes it and starts the next one) so that it ends exactly on the
newest CHECKPOINT HEIGHT: a height h with h % INTERVAL == INTERVAL - 1 that is
at least MIN_DEPTH blocks below the tip. Every existing checkpoint (49,999,
99,999, ... 949,999) is such a height, so the old ones keep their place.

Nothing is believed because a server said it. The tool:

  1. walks the WHOLE published line from genesis, rebuilding each 80-byte
     header from its 48-byte record and the previous hash, and checks the
     header-chain consensus rules: linkage, proof of work against the bits,
     bits equal to the exact retarget result at every 2016th block and
     unchanged elsewhere, time above the median of the previous eleven, and
     the BIP34/66/65 minimum versions;
     every height in PINNED (the 19 checkpoints ONOSENDAI, cyberspace-mcp and
     hosaka-core embed) and every manifest checkpoint must match;
  2. fetches only the new headers from one Esplora source and puts each
     through the same rules, also requiring the source's own id and
     previousblockhash to agree with the rebuilt chain;
  3. asks two OTHER sources for the hash at every checkpoint height it adds
     (and the tip, for the depth), and stops on any disagreement;
  4. writes the grown blob(s) and the manifest, then re-verifies the written
     directory from genesis before reporting success.

Exit codes: 0 extended, 10 nothing to do (the head is already at the newest
checkpoint height), 1 anything failed (nothing should be published).

Stdlib only, so a CI runner needs nothing installed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

RECORD_SIZE = 48
BLOB_SIZE = 50_000
RETARGET_INTERVAL = 2016
TARGET_TIMESPAN = 14 * 24 * 60 * 60
POW_LIMIT_BITS = 0x1D00FFFF
MTP_WINDOW = 11
INTERVAL = 1000
MIN_DEPTH = 100

GENESIS_HASH = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"

#: The 19 checkpoints embedded in ONOSENDAI src/lib/hyperspace/checkpoints.ts,
#: cyberspace-mcp src/hyperspace/checkpoints.ts and hosaka-core
#: src/hosaka_core/headers.py (pinned 2026-08-24, each confirmed against
#: blockstream.info). A manifest that disagrees with any of them is refused.
PINNED: Dict[int, str] = {
    0: GENESIS_HASH,
    49999: "000000000845517b31c6820d83f25cff46429bf136a7515fe504116427e60f8e",
    99999: "000000000002d01c1fccc21636b607dfd930d31d01c3a62104612a1719011250",
    149999: "00000000000008df4269884f1d3bfc2aed3ea747292abb89be3dc3faa8c5d26f",
    199999: "00000000000003a20def7a05a77361b9657ff954b2f2080e135ea6f5970da215",
    249999: "0000000000000009c2e82d884ec07b4aafb64ca3ef83baca2b6b0b5eb72c8f02",
    299999: "000000000000000067ecc744b5ae34eebbde14d21ca4db51652e4d67e155f07e",
    349999: "000000000000000002045664f89a1077d0c6c0aaa6dd89b485208cf92d6bbd30",
    399999: "0000000000000000030034b661aed920a9bdf6bbfa6d2e7a021f78481882fa39",
    449999: "0000000000000000024c4a35f0485bab79ce341cdd5cc6b15186d9b5b57bf3da",
    499999: "0000000000000000007962066dcd6675830883516bcf40047d42740a85eb2919",
    549999: "00000000000000000013dad60a42a3401a8f37ca02f1c00ac5923e674566a3ae",
    599999: "00000000000000000003ecd827f336c6971f6f77a0b9fba362398dd867975645",
    649999: "000000000000000000076c1eea129cec5a5291d0ee516c3305df33b0ba76ac51",
    699999: "0000000000000000000aa3ce000eb559f4143be419108134e0ce71042fc636eb",
    749999: "00000000000000000001e3aee44a04a5c3461181d25c8803ff6d617173e34533",
    799999: "000000000000000000012117ad9f72c1c0e42227c2d042dca23e6b96bd9fbb55",
    849999: "000000000000000000026b072f9347d86942f6786dd1fc362acfd9522715b313",
    899999: "0000000000000000000196400396be46d0816dc462df4c3450972f589f4d7d24",
    949999: "00000000000000000000df842728edc58cf64288ca21433257700f3d5b45f286",
}

DEFAULT_SOURCE = "https://mempool.space/api"
DEFAULT_CHECKS = ("esplora:https://blockstream.info/api", "blockchain_info:https://blockchain.info")
USER_AGENT = "nth-headers-head/1 (+https://github.com/arkin0x/nth)"


class ChainError(ValueError):
    """The line, the source or a cross-check failed; nothing may be published."""


# ---------------------------------------------------------------- consensus primitives

def sha256d(data: bytes) -> bytes:
    return hashlib.sha256(hashlib.sha256(data).digest()).digest()


def decode_compact(bits: int) -> int:
    """Compact bits to a target, refusing the encodings no valid block uses
    (sign bit, zero mantissa, overflow), as arith_uint256::SetCompact plus
    CheckProofOfWork reject them."""
    exponent, mantissa = bits >> 24, bits & 0x007FFFFF
    if bits & 0x00800000 or mantissa == 0:
        raise ChainError(f"unusable compact bits {bits:#010x}")
    target = mantissa >> (8 * (3 - exponent)) if exponent <= 3 else mantissa << (8 * (exponent - 3))
    if target >= 1 << 256:
        raise ChainError(f"compact bits {bits:#010x} overflow 256 bits")
    return target


def encode_compact(target: int) -> int:
    """arith_uint256::GetCompact for a non-negative target."""
    size = (target.bit_length() + 7) // 8
    compact = target << (8 * (3 - size)) if size <= 3 else target >> (8 * (size - 3))
    if compact & 0x00800000:
        compact >>= 8
        size += 1
    return compact | (size << 24)


@dataclass(frozen=True)
class Net:
    """The consensus parameters the walk needs. Tests use REGTEST's easy limit
    to mine synthetic chains; everything published uses MAINNET."""
    pow_limit_bits: int
    #: Heights from which a header's version must be at least 2, 3 and 4
    #: (BIP34, BIP66, BIP65; ContextualCheckBlockHeader's bad-version rule).
    version_heights: Tuple[int, int, int] = (227_931, 363_725, 388_381)

    @property
    def pow_limit(self) -> int:
        return decode_compact(self.pow_limit_bits)


MAINNET = Net(POW_LIMIT_BITS)
REGTEST = Net(0x207FFFFF, (1, 1, 1))


def next_bits(last_bits: int, first_time: int, last_time: int, net: Net = MAINNET) -> int:
    """CalculateNextWorkRequired: the bits a block at a retarget height must
    carry, from the window's first and last block (no min-difficulty rule:
    that is testnet's, never mainnet's)."""
    span = min(max(last_time - first_time, TARGET_TIMESPAN // 4), TARGET_TIMESPAN * 4)
    target = decode_compact(last_bits) * span // TARGET_TIMESPAN
    return encode_compact(min(target, net.pow_limit))


class Chain:
    """The header line walked from genesis, checked one record at a time."""

    def __init__(self, pinned: Dict[int, str], net: Net = MAINNET) -> None:
        self.pinned = pinned
        self.net = net
        self.height = -1
        self.prev = bytes(32)  # internal order
        self.times: List[int] = []
        self.bits: List[int] = []

    @property
    def tip_hash(self) -> str:
        return self.prev[::-1].hex()

    def push(self, rec: bytes, now: Optional[int] = None) -> str:
        """Check and append one 48-byte record; return its display hash."""
        if len(rec) != RECORD_SIZE:
            raise ChainError(f"a record is {RECORD_SIZE} bytes, not {len(rec)}")
        h = self.height + 1
        version = struct.unpack_from("<i", rec, 0)[0]  # signed, as nVersion is
        for minimum, since in zip((2, 3, 4), self.net.version_heights):
            if h >= since and version < minimum:
                raise ChainError(f"version {version} at height {h}, at least {minimum} required since {since}")
        t, bits = struct.unpack_from("<II", rec, 36)
        if h == 0:
            expected_bits = self.net.pow_limit_bits
        elif h % RETARGET_INTERVAL == 0:
            expected_bits = next_bits(self.bits[h - 1], self.times[h - RETARGET_INTERVAL], self.times[h - 1], self.net)
        else:
            expected_bits = self.bits[h - 1]
        if bits != expected_bits:
            raise ChainError(f"bits {bits:#010x} at height {h}, consensus requires {expected_bits:#010x}")
        if h > 0:
            window = sorted(self.times[max(0, h - MTP_WINDOW):h])
            if t <= window[len(window) // 2]:
                raise ChainError(f"time {t} at height {h} is not above the median of the previous {len(window)}")
        if now is not None and t > now + 2 * 60 * 60:
            raise ChainError(f"time {t} at height {h} is more than two hours in the future")
        internal = sha256d(rec[0:4] + self.prev + rec[4:48])
        display = internal[::-1].hex()
        if int.from_bytes(internal, "little") > decode_compact(bits):
            raise ChainError(f"proof of work failed at height {h}")
        pinned = self.pinned.get(h)
        if pinned is not None and pinned != display:
            raise ChainError(f"height {h} hashes to {display}, the pinned checkpoint is {pinned}")
        self.height, self.prev = h, internal
        self.times.append(t)
        self.bits.append(bits)
        return display


# ---------------------------------------------------------------- the published line

def _is_hex64(v: Any) -> bool:
    return isinstance(v, str) and len(v) == 64 and all(c in "0123456789abcdef" for c in v)


def parse_manifest(raw: Any) -> Dict[str, Any]:
    """The invariants every reader (ONOSENDAI, cyberspace-mcp, hosaka-core) leans on."""
    if not isinstance(raw, dict) or raw.get("formatVersion") != 1 or raw.get("network") != "mainnet":
        raise ChainError("not a mainnet headers-v1 manifest")
    if raw.get("blobSize") != BLOB_SIZE:
        raise ChainError(f"blobSize is {raw.get('blobSize')}, this tool writes {BLOB_SIZE}")
    blobs, checkpoints = raw.get("blobs"), raw.get("checkpoints")
    if not isinstance(blobs, list) or not isinstance(checkpoints, list) or not blobs or len(blobs) != len(checkpoints):
        raise ChainError("manifest needs one checkpoint per blob")
    for i, (b, c) in enumerate(zip(blobs, checkpoints)):
        if not isinstance(b, dict) or not isinstance(c, dict):
            raise ChainError(f"manifest entry {i} is malformed")
        count = b.get("count")
        if b.get("ordinal") != i or b.get("startHeight") != i * BLOB_SIZE or not isinstance(count, int):
            raise ChainError(f"manifest blob {i} is misplaced")
        if not 0 < count <= BLOB_SIZE or (count < BLOB_SIZE and i != len(blobs) - 1):
            raise ChainError(f"manifest blob {i} has a bad count {count}")
        if b.get("file") != blob_file(i) or not _is_hex64(b.get("sha256")):
            raise ChainError(f"manifest blob {i} names {b.get('file')!r}, expected {blob_file(i)}")
        if c.get("height") != i * BLOB_SIZE + count - 1 or not _is_hex64(c.get("blockHash")):
            raise ChainError(f"manifest checkpoint {i} is malformed")
    last = blobs[-1]
    if raw.get("generatedAtHeight") != last["startHeight"] + last["count"] - 1:
        raise ChainError("generatedAtHeight is not the last blob's last height")
    return raw


def blob_file(ordinal: int) -> str:
    return f"headers-{ordinal:03d}.bin"


def verify_dir(directory: Path, pinned: Dict[int, str] = PINNED, net: Net = MAINNET) -> Tuple[Chain, Dict[str, Any], bytes]:
    """Verify a headers-v1 directory from genesis. Returns the walked chain,
    the manifest and the head blob's bytes."""
    manifest = parse_manifest(json.loads((directory / "manifest.json").read_text()))
    chain = Chain(pinned, net)
    data = b""
    for blob, cp in zip(manifest["blobs"], manifest["checkpoints"]):
        data = (directory / blob["file"]).read_bytes()
        if len(data) != blob["count"] * RECORD_SIZE:
            raise ChainError(f"{blob['file']} is {len(data)} bytes, the manifest says {blob['count']} records")
        if hashlib.sha256(data).hexdigest() != blob["sha256"]:
            raise ChainError(f"{blob['file']} does not match its manifest sha256")
        for i in range(blob["count"]):
            chain.push(data[RECORD_SIZE * i:RECORD_SIZE * (i + 1)])
        if chain.tip_hash != cp["blockHash"]:
            raise ChainError(f"blob {blob['ordinal']} ends at {chain.tip_hash}, its manifest checkpoint is {cp['blockHash']}")
    for height, want in pinned.items():
        if height > chain.height:
            raise ChainError(f"the line ends at {chain.height}, below the pinned checkpoint {height}")
    return chain, manifest, data


def checkpoint_height(tip: int, interval: int = INTERVAL, min_depth: int = MIN_DEPTH) -> int:
    """The newest h with h % interval == interval - 1 and tip - h >= min_depth."""
    return ((tip - min_depth + 1) // interval) * interval - 1


# ---------------------------------------------------------------- sources

Getter = Callable[[str], bytes]


def http_get(timeout: float = 30.0, attempts: int = 5, pause: float = 0.25) -> Getter:
    """A polite GET: a pause before every request, backoff on errors and 429."""
    def get(url: str) -> bytes:
        error: Optional[Exception] = None
        for attempt in range(attempts):
            time.sleep(pause if attempt == 0 else min(60.0, 2.0 ** attempt))
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    return resp.read()
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                error = exc
        raise ChainError(f"could not fetch {url}: {error}")
    return get


class Esplora:
    """An Esplora REST API (mempool.space, blockstream.info)."""

    def __init__(self, base: str, get: Getter) -> None:
        self.base, self.get, self.name = base.rstrip("/"), get, base

    def tip(self) -> int:
        return int(self.get(f"{self.base}/blocks/tip/height").decode().strip())

    def hash_at(self, height: int) -> str:
        return self.get(f"{self.base}/block-height/{height}").decode().strip()

    def blocks_from(self, height: int) -> List[Dict[str, Any]]:
        """Block summaries at height and below (Esplora returns ten, newest first)."""
        out = json.loads(self.get(f"{self.base}/blocks/{height}"))
        if not isinstance(out, list):
            raise ChainError(f"{self.name}/blocks/{height} is not a list")
        return out


class BlockchainInfo:
    """blockchain.info's public API, a non-Esplora second opinion."""

    def __init__(self, base: str, get: Getter) -> None:
        self.base, self.get, self.name = base.rstrip("/"), get, base

    def tip(self) -> int:
        return int(self.get(f"{self.base}/q/getblockcount").decode().strip())

    def hash_at(self, height: int) -> str:
        body = json.loads(self.get(f"{self.base}/block-height/{height}?format=json"))
        main = [b["hash"] for b in body.get("blocks", []) if b.get("main_chain") and b.get("height") == height]
        if len(main) != 1:
            raise ChainError(f"{self.name} has {len(main)} main-chain blocks at {height}")
        return main[0]


def make_check(spec: str, get: Getter) -> Any:
    kind, _, base = spec.partition(":")
    if kind == "esplora":
        return Esplora(base, get)
    if kind == "blockchain_info":
        return BlockchainInfo(base, get)
    raise ChainError(f"unknown check source {spec!r} (esplora:URL or blockchain_info:URL)")


def record_from_summary(b: Dict[str, Any]) -> bytes:
    """The 48-byte record of an Esplora block summary."""
    for key in ("version", "timestamp", "bits", "nonce"):
        if not isinstance(b.get(key), int) or isinstance(b.get(key), bool):
            raise ChainError(f"block {b.get('height')} has no integer {key}")
    if not _is_hex64(b.get("merkle_root")) or not _is_hex64(b.get("id")):
        raise ChainError(f"block {b.get('height')} has a malformed id or merkle root")
    return (struct.pack("<I", b["version"] & 0xFFFFFFFF) + bytes.fromhex(b["merkle_root"])[::-1]
            + struct.pack("<III", b["timestamp"], b["bits"], b["nonce"]))


def fetch_records(source: Esplora, first: int, last: int, log: Callable[[str], None]) -> List[Dict[str, Any]]:
    """Summaries for first .. last, ascending, exactly one per height."""
    by_height: Dict[int, Dict[str, Any]] = {}
    cursor, pages = last, 0
    while cursor >= first:
        page = source.blocks_from(min(cursor, last))
        heights = [b.get("height") for b in page]
        if not page or not all(isinstance(h, int) for h in heights) or max(heights) != cursor:
            raise ChainError(f"{source.name}/blocks/{cursor} did not start at {cursor}")
        for b in page:
            if first <= b["height"] <= last:
                by_height[b["height"]] = b
        cursor = min(heights) - 1
        pages += 1
        if pages % 200 == 0:
            log(f"fetched down to {cursor + 1} ({last - cursor} of {last - first + 1})")
    missing = [h for h in range(first, last + 1) if h not in by_height]
    if missing:
        raise ChainError(f"{source.name} skipped heights {missing[:5]}")
    return [by_height[h] for h in range(first, last + 1)]


# ---------------------------------------------------------------- extend

def extend(
    directory: Path,
    source: Esplora,
    checks: Sequence[Any],
    target: Optional[int] = None,
    interval: int = INTERVAL,
    min_depth: int = MIN_DEPTH,
    log: Callable[[str], None] = lambda m: print(m, file=sys.stderr),
    now: Optional[int] = None,
    pinned: Dict[int, str] = PINNED,
    net: Net = MAINNET,
) -> Optional[Dict[str, Any]]:
    """Grow the head blob in directory to the next checkpoint height. Returns a
    summary, or None when the head is already there."""
    log(f"verifying {directory} from genesis")
    chain, manifest, head = verify_dir(directory, pinned, net)
    previous = chain.height
    log(f"published line verified to {previous} ({chain.tip_hash})")

    tips = {source.name: source.tip()}
    for c in checks:
        tips[c.name] = c.tip()
    tip = min(tips.values())
    if max(tips.values()) - tip > 6:
        raise ChainError(f"sources disagree on the tip by more than 6 blocks: {tips}")
    goal = checkpoint_height(tip, interval, min_depth) if target is None else target
    if goal % interval != interval - 1:
        raise ChainError(f"{goal} is not a checkpoint height (h % {interval} == {interval - 1})")
    if tip - goal < min_depth:
        raise ChainError(f"{goal} is only {tip - goal} blocks deep (tip {tip}), {min_depth} required")
    if goal <= previous:
        log(f"nothing to do: the head is at {previous}, the newest checkpoint height is {goal}")
        return None

    summaries = fetch_records(source, previous + 1, goal, log)
    stamp = int(time.time()) if now is None else now
    records: List[bytes] = []
    hashes: Dict[int, str] = {}
    for b in summaries:
        if b.get("previousblockhash") != chain.tip_hash:
            raise ChainError(f"{source.name} says block {b['height']} follows {b.get('previousblockhash')}, the line has {chain.tip_hash}")
        rec = record_from_summary(b)
        got = chain.push(rec, now=stamp)
        if got != b["id"]:
            raise ChainError(f"block {b['height']} rebuilds to {got}, {source.name} says {b['id']}")
        records.append(rec)
        hashes[b["height"]] = got
    log(f"{len(records)} new headers verified to {goal}")

    checked = []
    for h in sorted(x for x in hashes if x % interval == interval - 1):
        for c in checks:
            theirs = c.hash_at(h)
            if theirs != hashes[h]:
                raise ChainError(f"cross-check failed at {h}: {c.name} says {theirs}, the line has {hashes[h]}")
            checked.append({"source": c.name, "height": h, "blockHash": theirs})
    log(f"cross-checked {len(checked)} hashes against {[c.name for c in checks]}")

    # Append-only: the head blob's bytes stay a prefix of what is written.
    blobs = [dict(b) for b in manifest["blobs"]]
    checkpoints = [dict(c) for c in manifest["checkpoints"]]
    last = blobs[-1]
    pending = head if last["count"] < BLOB_SIZE else b""
    if pending:
        blobs.pop()
        checkpoints.pop()
    ordinal = len(blobs)
    stream = pending + b"".join(records)
    changed = []
    while stream:
        chunk, stream = stream[:BLOB_SIZE * RECORD_SIZE], stream[BLOB_SIZE * RECORD_SIZE:]
        count = len(chunk) // RECORD_SIZE
        end = ordinal * BLOB_SIZE + count - 1
        (directory / blob_file(ordinal)).write_bytes(chunk)
        blobs.append({"ordinal": ordinal, "startHeight": ordinal * BLOB_SIZE, "count": count,
                      "sha256": hashlib.sha256(chunk).hexdigest(), "file": blob_file(ordinal)})
        # Every blob end written here is a height this run added: a full head
        # is never pending, so a rewritten head always ends past previous.
        checkpoints.append({"height": end, "blockHash": hashes[end]})
        changed.append({"file": blob_file(ordinal), "startHeight": ordinal * BLOB_SIZE, "count": count})
        ordinal += 1
    out = dict(manifest, generatedAtHeight=goal, blobs=blobs, checkpoints=checkpoints)
    (directory / "manifest.json").write_text(json.dumps(out, indent=2) + "\n")

    log("re-verifying the written directory from genesis")
    again, _, _ = verify_dir(directory, pinned, net)
    if again.height != goal or again.tip_hash != hashes[goal]:
        raise ChainError("the written directory does not verify to the new checkpoint")
    return {
        "previousHeight": previous,
        "checkpoint": {"height": goal, "blockHash": hashes[goal]},
        "tips": tips,
        "depth": tip - goal,
        "minDepth": min_depth,
        "recordsAdded": len(records),
        "blobs": changed,
        "crossChecks": checked,
        "source": source.name,
    }


def summary_markdown(s: Dict[str, Any]) -> str:
    cp = s["checkpoint"]
    rows = "\n".join(f"| {c['height']:,} | `{c['blockHash']}` | {c['source']} |" for c in s["crossChecks"])
    tips = ", ".join(f"{k} {v:,}" for k, v in s["tips"].items())
    files = ", ".join(f"`{b['file']}` ({b['count']:,} records from {b['startHeight']:,})" for b in s["blobs"])
    return f"""Extends the headers-v1 head blob from block {s['previousHeight']:,} to the checkpoint height **{cp['height']:,}**.

New checkpoint: `{cp['height']}` = `{cp['blockHash']}`

### What was checked (scripts/headers_head.py on master)

- The whole published line was re-verified from genesis before anything was added: linkage, proof of work, bits equal to the exact retarget result at every 2016th block and unchanged elsewhere, time above the median of the previous 11, the BIP34/66/65 minimum versions, every manifest checkpoint, and the 19 checkpoints ONOSENDAI, cyberspace-mcp and hosaka-core embed.
- {s['recordsAdded']:,} new headers came from {s['source']} and passed the same rules; each one's rebuilt hash equals the source's id, and its previousblockhash equals the line's.
- Tips: {tips}. The checkpoint is {s['depth']:,} blocks deep ({s['minDepth']} required).
- Every checkpoint height added was cross-checked against two other sources:

| height | block hash | source |
|---|---|---|
{rows}

- Append-only: finalized blobs are untouched; the head blob's old bytes are a prefix of the new file. Files: {files}.
- The written directory was verified again from genesis.

### After merging

Merging moves the live manifest that ONOSENDAI, cyberspace-mcp and HOSAKA read. HOSAKA only sells rides up to its own embedded checkpoint, so it also needs the hosaka-core checkpoint PR and an hosaka-api deploy. This PR was opened by a scheduled job; it never merges or deploys anything itself.
"""


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--headers-dir", required=True, type=Path, help="a checkout of the headers-v1 branch")
    p.add_argument("--source", default=DEFAULT_SOURCE, help="Esplora base URL the new headers are read from")
    p.add_argument("--check", action="append", help="cross-check source, esplora:URL or blockchain_info:URL (default: blockstream.info and blockchain.info)")
    p.add_argument("--target", type=int, help="extend to this checkpoint height instead of the newest")
    p.add_argument("--min-depth", type=int, default=MIN_DEPTH)
    p.add_argument("--summary-json", type=Path)
    p.add_argument("--summary-md", type=Path)
    p.add_argument("--verify-only", action="store_true", help="verify the directory from genesis and stop")
    a = p.parse_args(argv)
    get = http_get()
    try:
        if a.verify_only:
            chain, _, _ = verify_dir(a.headers_dir)
            print(json.dumps({"height": chain.height, "blockHash": chain.tip_hash}))
            return 0
        checks = [make_check(s, get) for s in (a.check or DEFAULT_CHECKS)]
        if len(checks) < 2:
            raise ChainError("two independent cross-check sources are required")
        if any(c.base == a.source.rstrip("/") for c in checks):
            raise ChainError("a cross-check source must not be the source")
        s = extend(a.headers_dir, Esplora(a.source, get), checks, a.target, min_depth=a.min_depth)
    except Exception as exc:  # noqa: BLE001  any failure must reach the issue with its reason
        print(f"FAILED: {exc.__class__.__name__}: {exc}", file=sys.stderr)
        if a.summary_md:
            a.summary_md.write_text(f"The weekly head-blob job failed and published nothing.\n\n```\n{exc.__class__.__name__}: {exc}\n```\n")
        return 1
    if s is None:
        return 10
    if a.summary_json:
        a.summary_json.write_text(json.dumps(s, indent=2) + "\n")
    if a.summary_md:
        a.summary_md.write_text(summary_markdown(s))
    print(json.dumps(s["checkpoint"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
