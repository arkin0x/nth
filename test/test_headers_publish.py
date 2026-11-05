"""Tests for scripts/headers_publish.sh, the only step of the head-blob job
that writes a ref, and for the workflow conditions that decide whether it
runs. No network and no GitHub: each test makes a bare repository on disk as
the remote, with a small headers-v1 branch, clones it, makes the changes
headers_head.py would (or should not), and runs the script.

Run: python3 -m unittest discover -s test -p 'test_*.py'
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "headers_publish.sh"
WORKFLOW = ROOT / ".github" / "workflows" / "headers-head.yml"
BLOB = 10  # blobSize in these tests, in 48-byte records
REC = 48


def git(cwd, *args, check=True):
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
    r = subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True)
    if check and r.returncode:
        raise AssertionError(f"git {' '.join(args)}: {r.stderr}")
    return r.stdout.strip()


def manifest(counts):
    """A manifest over blobs with these counts (the last may be partial)."""
    blobs, start = [], 0
    for i, c in enumerate(counts):
        blobs.append({"ordinal": i, "startHeight": start, "count": c, "sha256": "0" * 64, "file": f"headers-{i:03d}.bin"})
        start += c
    return {"formatVersion": 1, "network": "mainnet", "blobSize": BLOB, "generatedAtHeight": start - 1, "blobs": blobs, "checkpoints": []}


def records(n, seed):
    return bytes((seed + i) % 251 for i in range(n * REC))


class Line:
    """A bare remote with headers-v1 = one full blob and a head of 4, and a clone of it."""

    def __init__(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="headers-publish-"))
        self.remote = self.tmp / "remote.git"
        git(self.tmp, "init", "-q", "--bare", str(self.remote))
        seed = self.tmp / "seed"
        git(self.tmp, "init", "-q", "-b", "headers-v1", str(seed))
        (seed / "README.md").write_text("headers-v1\n")
        (seed / "headers-000.bin").write_bytes(records(BLOB, 0))
        (seed / "headers-001.bin").write_bytes(records(4, 1))
        (seed / "manifest.json").write_text(json.dumps(manifest([BLOB, 4])))
        git(seed, "add", ".")
        git(seed, "commit", "-q", "-m", "seed")
        git(seed, "push", "-q", str(self.remote), "headers-v1")
        self.seed = seed
        self.line = self.tmp / "line"
        git(self.tmp, "clone", "-q", "-b", "headers-v1", str(self.remote), str(self.line))
        self.base = git(self.line, "rev-parse", "HEAD")

    def grow(self, head_count, extra_blobs=()):
        """What headers_head.py writes: the head appended to, then any new blobs."""
        head = self.line / "headers-001.bin"
        old = head.read_bytes()
        head.write_bytes(old + records(head_count - 4, 99)[: (head_count - 4) * REC])
        counts = [BLOB, head_count]
        for i, c in enumerate(extra_blobs):
            (self.line / f"headers-{i + 2:03d}.bin").write_bytes(records(c, 7 + i))
            counts.append(c)
        (self.line / "manifest.json").write_text(json.dumps(manifest(counts)))
        return sum(counts) - 1

    def reclone(self):
        shutil.rmtree(self.line)
        git(self.tmp, "clone", "-q", "-b", "headers-v1", str(self.remote), str(self.line))

    def run(self, mode, height):
        env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "RUN_URL": "test"}
        r = subprocess.run(["bash", str(SCRIPT), mode, str(height)], cwd=self.line, env=env, capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr

    def remote_ref(self, ref):
        return git(self.remote, "rev-parse", "--verify", "-q", ref, check=False)

    def close(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.l = Line()

    def tearDown(self):
        self.l.close()

    def test_publish_fast_forwards_headers_v1(self):
        h = self.l.grow(BLOB, extra_blobs=[3])
        code, out = self.l.run("publish", h)
        self.assertEqual(code, 0, out)
        new = self.l.remote_ref("refs/heads/headers-v1")
        self.assertNotEqual(new, self.l.base)
        self.assertEqual(git(self.l.remote, "rev-parse", f"{new}^"), self.l.base)
        self.assertEqual(git(self.l.remote, "ls-tree", "--name-only", new).split(), ["README.md", "headers-000.bin", "headers-001.bin", "headers-002.bin", "manifest.json"])
        self.assertEqual(self.l.remote_ref(f"refs/heads/auto/headers-head-{h}"), "", "publish pushes headers-v1 only")

    def test_publish_refuses_when_headers_v1_moved(self):
        h = self.l.grow(6)
        (self.l.seed / "README.md").write_text("someone else\n")
        git(self.l.seed, "commit", "-q", "-am", "moved")
        git(self.l.seed, "push", "-q", str(self.l.remote), "headers-v1")
        moved = self.l.remote_ref("refs/heads/headers-v1")
        code, out = self.l.run("publish", h)
        self.assertEqual(code, 1, out)
        self.assertIn("not " + self.l.base, out)
        self.assertEqual(self.l.remote_ref("refs/heads/headers-v1"), moved, "never forced over")

    def test_a_finalized_blob_never_changes(self):
        h = self.l.grow(6)
        p = self.l.line / "headers-000.bin"
        b = bytearray(p.read_bytes()); b[5] ^= 1; p.write_bytes(bytes(b))
        code, out = self.l.run("publish", h)
        self.assertEqual(code, 1, out)
        self.assertIn("headers-000.bin is a finalized blob", out)
        self.assertEqual(self.l.remote_ref("refs/heads/headers-v1"), self.l.base)

    def test_the_head_only_grows(self):
        h = self.l.grow(6)
        p = self.l.line / "headers-001.bin"
        b = bytearray(p.read_bytes()); b[0] ^= 1; p.write_bytes(bytes(b))
        code, out = self.l.run("publish", h)
        self.assertEqual(code, 1, out)
        self.assertIn("not an append", out)

    def test_nothing_else_may_change_or_go(self):
        for change in ("readme", "delete", "stray"):
            with self.subTest(change):
                self.l.close(); self.l = Line()
                h = self.l.grow(6)
                if change == "readme":
                    (self.l.line / "README.md").write_text("changed\n")
                elif change == "delete":
                    (self.l.line / "README.md").unlink()
                else:
                    (self.l.line / "notes.txt").write_text("x\n")
                code, out = self.l.run("publish", h)
                self.assertEqual(code, 1, out)
                self.assertIn("unexpected changes", out)
                self.assertEqual(self.l.remote_ref("refs/heads/headers-v1"), self.l.base)

    def test_the_height_must_be_the_manifests(self):
        h = self.l.grow(6)
        code, out = self.l.run("publish", h + 1)
        self.assertEqual(code, 1, out)
        self.assertIn(f"reaches {h}", out)
        code, out = self.l.run("publish", "12; echo")
        self.assertEqual(code, 1, out)
        self.assertIn("not a number", out)

    def test_nothing_to_publish(self):
        code, out = self.l.run("publish", 13)
        self.assertEqual(code, 1, out)
        self.assertIn("nothing to publish", out)

    def test_propose_pushes_a_new_branch_only(self):
        h = self.l.grow(BLOB, extra_blobs=[3])
        code, out = self.l.run("propose", h)
        self.assertEqual(code, 0, out)
        self.assertNotEqual(self.l.remote_ref(f"refs/heads/auto/headers-head-{h}"), "")
        self.assertEqual(self.l.remote_ref("refs/heads/headers-v1"), self.l.base, "propose never touches headers-v1")

    def test_propose_never_moves_an_existing_branch(self):
        h = self.l.grow(6)
        git(self.l.seed, "push", "-q", str(self.l.remote), f"headers-v1:refs/heads/auto/headers-head-{h}")
        before = self.l.remote_ref(f"refs/heads/auto/headers-head-{h}")
        code, out = self.l.run("propose", h)
        self.assertEqual(code, 1, out)
        self.assertIn("other content", out)
        self.assertEqual(self.l.remote_ref(f"refs/heads/auto/headers-head-{h}"), before)

    def test_propose_rerun_with_the_same_proposal_succeeds(self):
        h = self.l.grow(6)
        snapshot = {f: (self.l.line / f).read_bytes() for f in ("manifest.json", "headers-001.bin")}
        code, out = self.l.run("propose", h)
        self.assertEqual(code, 0, out)
        pushed = self.l.remote_ref(f"refs/heads/auto/headers-head-{h}")
        # A rerun: a fresh checkout of headers-v1, the tool writes the same bytes.
        self.l.reclone()
        for f, b in snapshot.items():
            (self.l.line / f).write_bytes(b)
        code, out = self.l.run("propose", h)
        self.assertEqual(code, 0, out)
        self.assertIn("already holds this proposal", out)
        self.assertEqual(self.l.remote_ref(f"refs/heads/auto/headers-head-{h}"), pushed)


class WorkflowTest(unittest.TestCase):
    """The conditions that run a writing step. GitHub compares a skipped step's
    output (null) with a string loosely, so `null == '0'` is 0 == 0, true: that
    is how run 41401521166 reached the push step after the derive step was
    skipped. Every step that writes must test a word that null never equals."""

    def setUp(self):
        self.text = WORKFLOW.read_text()

    def steps(self):
        return re.findall(r"- name: (.+)\n((?:        .*\n|\n)*)", self.text)

    def test_no_condition_compares_an_output_with_a_number(self):
        for cond in re.findall(r"^\s+if: (.+)$", self.text, re.M):
            self.assertIsNone(re.search(r"outputs\.\w+ [!=]= '\d+'", cond), cond)

    def test_every_writing_step_needs_a_real_extension(self):
        writers = {"Push the proposal branch", "Open the pull request, or the reminder issue", "Publish to headers-v1", "Close the proposals this publish supersedes"}
        found = {}
        for name, body in self.steps():
            if name.strip() in writers:
                m = re.search(r"^\s+if: (.+)$", body, re.M)
                found[name.strip()] = m.group(1) if m else ""
        self.assertEqual(set(found), writers)
        for name, cond in found.items():
            self.assertIn("steps.derive.outputs.extended == 'true'", cond, name)
        self.assertIn("env.MODE == 'auto'", found["Publish to headers-v1"])
        self.assertIn("env.MODE != 'auto'", found["Push the proposal branch"])

    def test_auto_mode_is_opt_in(self):
        self.assertIn("MODE: ${{ vars.HEADERS_PUBLISH == 'auto' && 'auto' || 'propose' }}", self.text)

    def test_no_force_push_anywhere(self):
        for text in (self.text, SCRIPT.read_text()):
            self.assertNotRegex(text, r"push[^\n]*(--force|-f\b|\s\+)")


if __name__ == "__main__":
    unittest.main()
