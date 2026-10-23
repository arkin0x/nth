"""Tests for scripts/headers_head.py. No network: a synthetic chain is mined
at the regtest proof-of-work limit and served by fake sources. When a real
headers-v1 checkout is at hand (HEADERS_DIR, or nth's local blobs) the whole
published line is verified from genesis too.

Run: python3 -m unittest discover -s test -p 'test_*.py'
"""
import hashlib
import json
import os
import shutil
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import headers_head as HH  # noqa: E402

T0 = 1_700_000_000
NOW = T0 + 10 ** 8


def mine(count, spacing=600, start=None, prev_chain=None):
    """count records continuing prev_chain (or from genesis), each meeting the
    consensus bits; returns (records, chain, summaries)."""
    chain = prev_chain or HH.Chain({}, HH.REGTEST)
    records, summaries = [], []
    for _ in range(count):
        h = chain.height + 1
        if h == 0:
            bits = HH.REGTEST.pow_limit_bits
        elif h % HH.RETARGET_INTERVAL == 0:
            bits = HH.next_bits(chain.bits[h - 1], chain.times[h - HH.RETARGET_INTERVAL], chain.times[h - 1], HH.REGTEST)
        else:
            bits = chain.bits[h - 1]
        t = (start or T0) + spacing * h
        merkle = hashlib.sha256(struct.pack("<I", h)).digest()
        prev_display = chain.tip_hash if h else "0" * 64
        for nonce in range(1 << 20):
            rec = struct.pack("<I", 0x20000000) + merkle + struct.pack("<III", t, bits, nonce)
            internal = HH.sha256d(rec[0:4] + chain.prev + rec[4:48])
            if int.from_bytes(internal, "little") <= HH.decode_compact(bits):
                break
        display = chain.push(rec)
        records.append(rec)
        summaries.append({
            "id": display, "height": h, "version": 0x20000000, "timestamp": t, "bits": bits,
            "nonce": nonce, "merkle_root": merkle[::-1].hex(),
            "previousblockhash": prev_display if h else None,
        })
    return records, chain, summaries


RECORDS, CHAIN, SUMMARIES = [], None, []
HASHES = []


def setUpModule():
    global RECORDS, CHAIN, SUMMARIES, HASHES
    RECORDS, CHAIN, SUMMARIES = mine(51_300)
    HASHES = [s["id"] for s in SUMMARIES]


def write_dir(directory, upto):
    """A headers-v1 directory holding heights 0..upto of the synthetic chain."""
    blobs, cps = [], []
    for ordinal in range(upto // HH.BLOB_SIZE + 1):
        lo = ordinal * HH.BLOB_SIZE
        hi = min(upto, lo + HH.BLOB_SIZE - 1)
        data = b"".join(RECORDS[lo:hi + 1])
        (directory / HH.blob_file(ordinal)).write_bytes(data)
        blobs.append({"ordinal": ordinal, "startHeight": lo, "count": hi - lo + 1,
                      "sha256": hashlib.sha256(data).hexdigest(), "file": HH.blob_file(ordinal)})
        cps.append({"height": hi, "blockHash": HASHES[hi]})
    manifest = {"formatVersion": 1, "network": "mainnet", "blobSize": HH.BLOB_SIZE,
                "generatedAtHeight": upto, "blobs": blobs, "checkpoints": cps}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


class FakeEsplora:
    def __init__(self, name, tip, summaries, lie=None):
        self.name = self.base = name
        self._tip, self.summaries, self.lie = tip, summaries, lie or {}

    def tip(self):
        return self._tip

    def hash_at(self, height):
        return self.lie.get(height, self.summaries[height]["id"])

    def blocks_from(self, height):
        return [dict(self.summaries[h]) for h in range(height, max(-1, height - 10), -1)]


class Lying(FakeEsplora):
    """A source whose block summaries are altered at some heights."""

    def __init__(self, name, tip, summaries, patch):
        super().__init__(name, tip, summaries)
        self.patch = patch

    def blocks_from(self, height):
        out = super().blocks_from(height)
        for b in out:
            b.update(self.patch.get(b["height"], {}))
        return out


class ExtendTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.pinned = {0: HASHES[0]}

    def tearDown(self):
        shutil.rmtree(self.dir)

    def sources(self, tip=51_250, lie=None):
        src = FakeEsplora("src", tip, SUMMARIES)
        checks = [FakeEsplora("a", tip, SUMMARIES, lie), FakeEsplora("b", tip, SUMMARIES)]
        return src, checks

    def extend(self, src, checks, **kw):
        return HH.extend(self.dir, src, checks, log=lambda m: None, now=NOW, pinned=self.pinned, net=HH.REGTEST, **kw)

    def test_extends_append_only_across_a_blob_boundary(self):
        write_dir(self.dir, 998)
        old_head = (self.dir / "headers-000.bin").read_bytes()
        src, checks = self.sources()
        s = self.extend(src, checks)
        self.assertEqual(s["checkpoint"], {"height": 50_999, "blockHash": HASHES[50_999]})
        self.assertEqual(s["previousHeight"], 998)
        self.assertEqual(s["recordsAdded"], 50_001)
        blob0 = (self.dir / "headers-000.bin").read_bytes()
        self.assertTrue(blob0.startswith(old_head))
        self.assertEqual(len(blob0), HH.BLOB_SIZE * HH.RECORD_SIZE)
        self.assertEqual((self.dir / "headers-001.bin").read_bytes(), b"".join(RECORDS[50_000:51_000]))
        m = json.loads((self.dir / "manifest.json").read_text())
        self.assertEqual(m["generatedAtHeight"], 50_999)
        self.assertEqual([c["height"] for c in m["checkpoints"]], [49_999, 50_999])
        self.assertEqual(m["checkpoints"][0]["blockHash"], HASHES[49_999])
        # every checkpoint height added was asked of both other sources
        self.assertEqual(len(s["crossChecks"]), 2 * 51)  # 999, 1999, ... 50999
        self.assertEqual(HH.verify_dir(self.dir, self.pinned, HH.REGTEST)[0].height, 50_999)
        # and a second run has nothing to do
        self.assertIsNone(self.extend(src, checks))

    def test_a_full_head_starts_the_next_blob_and_leaves_it_untouched(self):
        write_dir(self.dir, 49_999)
        full = (self.dir / "headers-000.bin").read_bytes()
        src, checks = self.sources(tip=51_150)
        s = self.extend(src, checks)
        self.assertEqual(s["checkpoint"]["height"], 50_999)
        self.assertEqual(s["blobs"], [{"file": "headers-001.bin", "startHeight": 50_000, "count": 1_000}])
        self.assertEqual((self.dir / "headers-000.bin").read_bytes(), full)
        self.assertEqual(len((self.dir / "headers-001.bin").read_bytes()), 1_000 * HH.RECORD_SIZE)

    def test_newest_checkpoint_height_is_the_default(self):
        write_dir(self.dir, 998)
        src, checks = self.sources(tip=3_099)
        self.assertEqual(self.extend(src, checks)["checkpoint"]["height"], 2_999)

    def test_cross_check_disagreement_publishes_nothing(self):
        write_dir(self.dir, 998)
        before = {p.name: p.read_bytes() for p in self.dir.iterdir()}
        src, checks = self.sources(tip=3_200, lie={1_999: "ab" * 32})
        with self.assertRaisesRegex(HH.ChainError, "cross-check failed at 1999"):
            self.extend(src, checks)
        self.assertEqual({p.name: p.read_bytes() for p in self.dir.iterdir()}, before)

    def test_source_id_that_is_not_the_rebuilt_hash(self):
        write_dir(self.dir, 998)
        src = Lying("src", 3_200, SUMMARIES, {1_500: {"id": "cd" * 32}})
        with self.assertRaisesRegex(HH.ChainError, "rebuilds to"):
            self.extend(src, self.sources(3_200)[1])

    def test_source_linkage_that_is_not_the_line(self):
        write_dir(self.dir, 998)
        src = Lying("src", 3_200, SUMMARIES, {1_000: {"previousblockhash": "ef" * 32}})
        with self.assertRaisesRegex(HH.ChainError, "follows"):
            self.extend(src, self.sources(3_200)[1])

    def test_a_forged_header_fails_consensus(self):
        write_dir(self.dir, 998)
        src = Lying("src", 3_200, SUMMARIES, {1_200: {"nonce": SUMMARIES[1_200]["nonce"] + 1}})
        with self.assertRaises(HH.ChainError):
            self.extend(src, self.sources(3_200)[1])

    def test_shallow_or_misaligned_targets_are_refused(self):
        write_dir(self.dir, 998)
        src, checks = self.sources(tip=2_050)
        with self.assertRaisesRegex(HH.ChainError, "deep"):
            self.extend(src, checks, target=1_999)
        with self.assertRaisesRegex(HH.ChainError, "not a checkpoint height"):
            self.extend(src, checks, target=1_500)

    def test_tips_that_disagree_are_refused(self):
        write_dir(self.dir, 998)
        src, checks = self.sources(tip=3_200)
        checks[1]._tip = 3_100
        with self.assertRaisesRegex(HH.ChainError, "tip"):
            self.extend(src, checks)

    def test_published_line_must_verify_first(self):
        write_dir(self.dir, 998)
        data = bytearray((self.dir / "headers-000.bin").read_bytes())
        data[100] ^= 1
        (self.dir / "headers-000.bin").write_bytes(bytes(data))
        with self.assertRaisesRegex(HH.ChainError, "sha256"):
            self.extend(*self.sources())

    def test_pinned_checkpoint_mismatch(self):
        write_dir(self.dir, 998)
        self.pinned = {0: HASHES[0], 500: "00" * 32}
        with self.assertRaisesRegex(HH.ChainError, "pinned"):
            self.extend(*self.sources())


class ConsensusTests(unittest.TestCase):
    def test_checkpoint_height(self):
        self.assertEqual(HH.checkpoint_height(972_815), 971_999)
        self.assertEqual(HH.checkpoint_height(972_098), 970_999)
        self.assertEqual(HH.checkpoint_height(972_099), 971_999)

    def test_compact_round_trip(self):
        for bits in (0x1D00FFFF, 0x1B0404CB, 0x17034219, 0x207FFFFF, 0x1C00FFFF):
            self.assertEqual(HH.encode_compact(HH.decode_compact(bits)), bits)
        self.assertEqual(HH.encode_compact(0x80), 0x02008000)  # the sign-bit shift

    def test_retarget_is_exact_and_enforced(self):
        # one window mined twice as fast as intended halves the target
        recs, chain, _ = mine(2016, spacing=300, start=T0)
        expected = HH.next_bits(chain.bits[-1], chain.times[0], chain.times[-1], HH.REGTEST)
        self.assertEqual(expected, HH.encode_compact(HH.REGTEST.pow_limit * (2015 * 300) // HH.TARGET_TIMESPAN))
        self.assertNotEqual(expected, HH.REGTEST.pow_limit_bits)
        stale = recs[-1][:40] + struct.pack("<I", HH.REGTEST.pow_limit_bits) + recs[-1][44:]
        stale = stale[:36] + struct.pack("<I", T0 + 300 * 2016) + stale[40:]
        with self.assertRaisesRegex(HH.ChainError, "consensus requires"):
            chain.push(stale)
        more, chain2, _ = mine(1, spacing=300, start=T0, prev_chain=chain)
        self.assertEqual(chain2.bits[-1], expected)

    def test_retarget_clamps_to_a_quarter(self):
        self.assertEqual(HH.next_bits(0x1B0404CB, 0, 1), HH.encode_compact(HH.decode_compact(0x1B0404CB) // 4))
        # and to four times, capped at the limit
        self.assertEqual(HH.next_bits(0x1B0404CB, 0, 10 ** 9), HH.encode_compact(HH.decode_compact(0x1B0404CB) * 4))
        self.assertEqual(HH.next_bits(HH.POW_LIMIT_BITS, 0, 10 ** 9), HH.POW_LIMIT_BITS)

    def test_median_time_past(self):
        recs, chain, _ = mine(20)
        median = sorted(chain.times[-11:])[5]
        rec = recs[-1][:36] + struct.pack("<I", median) + recs[-1][40:]
        with self.assertRaisesRegex(HH.ChainError, "median"):
            chain.push(rec)

    def test_future_time(self):
        recs, chain, _ = mine(3)
        rec = recs[-1][:36] + struct.pack("<I", NOW + 3 * 3600) + recs[-1][40:]
        with self.assertRaisesRegex(HH.ChainError, "future"):
            chain.push(rec, now=NOW)


REAL = Path(os.environ.get("HEADERS_DIR") or "/data/projects/nth/blobs")


@unittest.skipUnless((REAL / "manifest.json").exists(), "no headers-v1 checkout at hand")
class PublishedLineTest(unittest.TestCase):
    def test_published_line_verifies_from_genesis(self):
        chain, manifest, _ = HH.verify_dir(REAL)
        self.assertEqual(chain.height, manifest["generatedAtHeight"])
        self.assertEqual(chain.tip_hash, manifest["checkpoints"][-1]["blockHash"])
        self.assertGreaterEqual(chain.height, 949_999)


if __name__ == "__main__":
    unittest.main()
