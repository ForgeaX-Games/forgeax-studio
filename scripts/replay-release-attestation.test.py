import gzip
import hashlib
import importlib.util
import io
import json
import lzma
import shutil
import tarfile
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("replay-release-attestation.py")
SPEC = importlib.util.spec_from_file_location("forgeax_replay_release_attestation", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReplayReleaseAttestationTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)

    def tearDown(self):
        self.temporary_directory.cleanup()

    def nested_archive(self, payload=b"runtime-v1"):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode="w") as archive:
            member = tarfile.TarInfo("bin/runtime")
            member.size = len(payload)
            archive.addfile(member, io.BytesIO(payload))
        return gzip.compress(raw.getvalue(), mtime=0)

    def nested_xz_archive(self, payload=b"runtime-xz"):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode="w") as archive:
            member = tarfile.TarInfo("bin/runtime")
            member.size = len(payload)
            archive.addfile(member, io.BytesIO(payload))
        return lzma.compress(raw.getvalue(), format=lzma.FORMAT_XZ)

    def write_candidate(self, name="candidate", nested_payload=b"runtime-v1", outer_mtime=1):
        directory = self.root / name
        directory.mkdir()
        tarball = directory / "package.tgz"
        nested = self.nested_archive(nested_payload)
        with tarfile.open(tarball, "w:gz") as archive:
            package = tarfile.TarInfo("package")
            package.type = tarfile.DIRTYPE
            package.mtime = outer_mtime
            archive.addfile(package)

            runtime = tarfile.TarInfo("package/assets/runtime/linux-x64/forgeax-game-runtime-linux-x64.tar.gz")
            runtime.size = len(nested)
            runtime.mtime = outer_mtime
            archive.addfile(runtime, io.BytesIO(nested))

            source = b"export const runtime = true;\n"
            source_member = tarfile.TarInfo("package/index.js")
            source_member.size = len(source)
            source_member.mtime = outer_mtime
            archive.addfile(source_member, io.BytesIO(source))
        digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
        (directory / "package.tgz.sha256").write_text(digest + "  package.tgz\n", encoding="utf-8")
        return directory

    def write_multi_nested_candidate(self, name="multi", count=2):
        directory = self.root / name
        directory.mkdir()
        tarball = directory / "package.tgz"
        with tarfile.open(tarball, "w:gz") as archive:
            package = tarfile.TarInfo("package")
            package.type = tarfile.DIRTYPE
            archive.addfile(package)
            for index in range(count):
                nested = self.nested_archive()
                member = tarfile.TarInfo(f"package/assets/{index}.tar.gz")
                member.size = len(nested)
                archive.addfile(member, io.BytesIO(nested))
        digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
        (directory / "package.tgz.sha256").write_text(digest + "  package.tgz\n", encoding="utf-8")
        return directory

    def findings(self, name, detector="fixture-detector", line=7):
        path = self.root / name
        path.write_text(
            json.dumps({
                "DetectorName": detector,
                "DetectorType": 42,
                "DecoderName": "PLAIN",
                "Verified": False,
                "Raw": "real-secret-value-must-not-escape",
                "SourceMetadata": {"Data": {"Filesystem": {"file": "/scan/package/index.js", "line": line}}},
            }) + "\n",
            encoding="utf-8",
        )
        return path

    def test_equal_candidates_are_deterministic_and_sanitized(self):
        left = self.write_candidate()
        right = self.root / "right"
        shutil.copytree(left, right)
        left_findings = self.findings("left.jsonl")
        right_findings = self.findings("right.jsonl")

        first = MODULE.build_attestation(left, right, left_findings, right_findings)
        second = MODULE.build_attestation(left, right, left_findings, right_findings)

        self.assertEqual(first, second)
        self.assertTrue(first["comparison"]["equal"])
        self.assertEqual(first["comparison"]["dimensions"], {
            "outerPackage": True,
            "nestedArchives": True,
            "normalizedExtractedTree": True,
            "findingFingerprints": True,
        })
        rendered = json.dumps(first, sort_keys=True)
        self.assertNotIn("real-secret-value-must-not-escape", rendered)
        self.assertNotIn(str(self.root), rendered)

    def test_distinguishes_outer_nested_and_finding_changes(self):
        baseline = self.write_candidate(name="baseline")
        outer_changed = self.write_candidate(name="outer-changed", outer_mtime=2)
        nested_changed = self.write_candidate(name="nested-changed", nested_payload=b"runtime-v2")
        findings_left = self.findings("findings-left.jsonl")
        findings_changed = self.findings("findings-changed.jsonl", detector="other-detector")

        outer_result = MODULE.build_attestation(baseline, outer_changed, findings_left, findings_left)
        self.assertFalse(outer_result["comparison"]["equal"])
        self.assertFalse(outer_result["comparison"]["dimensions"]["outerPackage"])
        self.assertTrue(outer_result["comparison"]["dimensions"]["nestedArchives"])
        self.assertTrue(outer_result["comparison"]["dimensions"]["normalizedExtractedTree"])
        self.assertTrue(outer_result["comparison"]["dimensions"]["findingFingerprints"])

        nested_result = MODULE.build_attestation(baseline, nested_changed, findings_left, findings_left)
        self.assertFalse(nested_result["comparison"]["dimensions"]["outerPackage"])
        self.assertFalse(nested_result["comparison"]["dimensions"]["nestedArchives"])
        self.assertFalse(nested_result["comparison"]["dimensions"]["normalizedExtractedTree"])

        finding_result = MODULE.build_attestation(baseline, baseline, findings_left, findings_changed)
        self.assertTrue(finding_result["comparison"]["dimensions"]["outerPackage"])
        self.assertTrue(finding_result["comparison"]["dimensions"]["nestedArchives"])
        self.assertTrue(finding_result["comparison"]["dimensions"]["normalizedExtractedTree"])
        self.assertFalse(finding_result["comparison"]["dimensions"]["findingFingerprints"])

    def test_rejects_unsafe_nested_archive_members(self):
        candidate = self.root / "unsafe"
        candidate.mkdir()
        nested_raw = io.BytesIO()
        with tarfile.open(fileobj=nested_raw, mode="w") as archive:
            member = tarfile.TarInfo("../escape")
            member.size = 1
            archive.addfile(member, io.BytesIO(b"x"))
        nested = gzip.compress(nested_raw.getvalue(), mtime=0)
        tarball = candidate / "package.tgz"
        with tarfile.open(tarball, "w:gz") as archive:
            member = tarfile.TarInfo("package/runtime.tar.gz")
            member.size = len(nested)
            archive.addfile(member, io.BytesIO(nested))
        digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
        (candidate / "package.tgz.sha256").write_text(digest + "  package.tgz\n", encoding="utf-8")

        with self.assertRaises(ValueError):
            MODULE.build_attestation(candidate, candidate)

    def test_reads_nested_xz_with_bounded_decoder(self):
        candidate = self.root / "xz"
        candidate.mkdir()
        nested = self.nested_xz_archive()
        tarball = candidate / "package.tgz"
        with tarfile.open(tarball, "w:gz") as archive:
            member = tarfile.TarInfo("package/runtime.tar.xz")
            member.size = len(nested)
            archive.addfile(member, io.BytesIO(nested))
        digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
        (candidate / "package.tgz.sha256").write_text(digest + "  package.tgz\n", encoding="utf-8")

        result = MODULE.build_attestation(candidate, candidate)

        self.assertTrue(result["comparison"]["equal"])
        self.assertEqual(result["candidates"][0]["nestedArchives"][0]["path"], "package/runtime.tar.xz")

    def test_counts_nested_xz_trailing_output_in_candidate_budget(self):
        candidate = self.root / "xz-tail"
        candidate.mkdir()
        nested = self.nested_xz_archive() + b"\0" * 1024
        tarball = candidate / "package.tgz"
        with tarfile.open(tarball, "w:gz") as archive:
            member = tarfile.TarInfo("package/runtime.tar.xz")
            member.size = len(nested)
            archive.addfile(member, io.BytesIO(nested))
        digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
        (candidate / "package.tgz.sha256").write_text(digest + "  package.tgz\n", encoding="utf-8")

        original_budget = MODULE._MAX_NESTED_CANDIDATE_TOTAL_BYTES
        MODULE._MAX_NESTED_CANDIDATE_TOTAL_BYTES = 128
        try:
            with self.assertRaises(ValueError):
                MODULE.build_attestation(candidate, candidate)
        finally:
            MODULE._MAX_NESTED_CANDIDATE_TOTAL_BYTES = original_budget

    def test_rejects_malformed_scanner_metadata_and_does_not_leak_values(self):
        candidate = self.write_candidate()
        malformed = self.root / "malformed.jsonl"
        malformed.write_text(json.dumps({"SourceMetadata": None}) + "\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            MODULE.build_attestation(candidate, candidate, malformed, malformed)

        secret_metadata = self.root / "secret-metadata.jsonl"
        secret_metadata.write_text(
            json.dumps({
                "DetectorName": {"Raw": "metadata-secret"},
                "DetectorType": {"Raw": "type-secret"},
                "DecoderName": "PLAIN",
                "Verified": False,
                "SourceMetadata": {"Data": {"Filesystem": {"file": "/host-a/index.js", "line": 7}}},
            }) + "\n",
            encoding="utf-8",
        )
        with self.assertRaises(ValueError):
            MODULE.build_attestation(candidate, candidate, secret_metadata, secret_metadata)

    def test_sanitizes_unknown_token_formats_and_file_uri_authorities(self):
        candidate = self.write_candidate()
        left = self.root / "opaque-left.jsonl"
        right = self.root / "opaque-right.jsonl"
        base = {
            "DetectorName": "A" * 64,
            "DetectorType": 42,
            "DecoderName": "PLAIN",
            "Verified": False,
            "SourceMetadata": {"Data": {"Filesystem": {"file": "file://build-host/index.js", "line": 7}}},
        }
        left.write_text(json.dumps(base) + "\n", encoding="utf-8")
        right.write_text(
            json.dumps({**base, "SourceMetadata": {"Data": {"Filesystem": {
                "file": "file://other-host/index.js", "line": 7,
            }}}}) + "\n",
            encoding="utf-8",
        )

        result = MODULE.build_attestation(candidate, candidate, left, right)

        self.assertFalse(result["comparison"]["dimensions"]["findingFingerprints"])
        rendered = json.dumps(result, sort_keys=True)
        self.assertNotIn("file://build-host", rendered)
        self.assertNotIn("file://other-host", rendered)
        self.assertNotIn("A" * 64, rendered)

    def test_sanitizes_relative_secret_like_paths(self):
        candidate = self.write_candidate()
        findings = self.root / "relative-secret-path.jsonl"
        findings.write_text(
            json.dumps({
                "DetectorName": "fixture-detector",
                "DetectorType": 42,
                "DecoderName": "PLAIN",
                "Verified": False,
                "SourceMetadata": {"Data": {"Filesystem": {
                    "file": "package/ghp_THIS_VALUE_IS_IN_A_PATH_123456789", "line": 7,
                }}},
            }) + "\n",
            encoding="utf-8",
        )

        result = MODULE.build_attestation(candidate, candidate, findings, findings)

        rendered = json.dumps(result, sort_keys=True)
        self.assertNotIn("ghp_THIS_VALUE_IS_IN_A_PATH_123456789", rendered)

        hex_findings = self.root / "relative-hex-path.jsonl"
        hex_path = "package/" + ("a" * 64)
        hex_findings.write_text(
            json.dumps({
                "DetectorName": "fixture-detector",
                "DetectorType": 42,
                "DecoderName": "PLAIN",
                "Verified": False,
                "SourceMetadata": {"Data": {"Filesystem": {"file": hex_path, "line": 7}}},
            }) + "\n",
            encoding="utf-8",
        )
        result = MODULE.build_attestation(candidate, candidate, hex_findings, hex_findings)
        self.assertNotIn("a" * 64, json.dumps(result, sort_keys=True))

    def test_rejects_bounded_scanner_inputs(self):
        candidate = self.write_candidate()
        oversized_line = self.root / "oversized-line.jsonl"
        oversized_line.write_bytes(b"{" + b"x" * MODULE._MAX_FINDING_LINE_BYTES + b"}\n")
        with self.assertRaises(ValueError):
            MODULE.build_attestation(candidate, candidate, oversized_line, oversized_line)

        oversized_file = self.root / "oversized-file.jsonl"
        with oversized_file.open("wb") as output:
            output.truncate(MODULE._MAX_FINDINGS_FILE_BYTES + 1)
        with self.assertRaises(ValueError):
            MODULE.build_attestation(candidate, candidate, oversized_file, oversized_file)

    def test_rejects_outer_and_nested_candidate_budgets(self):
        candidate = self.write_candidate()
        multi = self.write_multi_nested_candidate()
        original_nested_count = MODULE._MAX_NESTED_ARCHIVE_COUNT
        MODULE._MAX_NESTED_ARCHIVE_COUNT = 1
        try:
            with self.assertRaises(ValueError):
                MODULE.build_attestation(multi, multi)
        finally:
            MODULE._MAX_NESTED_ARCHIVE_COUNT = original_nested_count

        original_nested_bytes = MODULE._MAX_NESTED_CANDIDATE_TOTAL_BYTES
        MODULE._MAX_NESTED_CANDIDATE_TOTAL_BYTES = 10
        try:
            with self.assertRaises(ValueError):
                MODULE.build_attestation(multi, multi)
        finally:
            MODULE._MAX_NESTED_CANDIDATE_TOTAL_BYTES = original_nested_bytes

    def test_cli_reports_output_parent_errors_without_traceback(self):
        candidate = self.write_candidate()
        output = self.root / "missing" / "attestation.json"

        result = MODULE.main(["--left", str(candidate), "--right", str(candidate), "--output", str(output)])

        self.assertEqual(result, 1)
        self.assertFalse(output.exists())

    def test_keeps_foreign_absolute_paths_distinct_without_emitting_them(self):
        candidate = self.write_candidate()
        left = self.findings("foreign-left.jsonl")
        right = self.root / "foreign-right.jsonl"
        right.write_text(
            json.dumps({
                "DetectorName": "fixture-detector",
                "DetectorType": 42,
                "DecoderName": "PLAIN",
                "Verified": False,
                "SourceMetadata": {"Data": {"Filesystem": {"file": "/host-b/index.js", "line": 7}}},
            }) + "\n",
            encoding="utf-8",
        )
        result = MODULE.build_attestation(candidate, candidate, left, right)
        self.assertFalse(result["comparison"]["dimensions"]["findingFingerprints"])
        rendered = json.dumps(result, sort_keys=True)
        self.assertNotIn("/host-a/index.js", rendered)
        self.assertNotIn("/host-b/index.js", rendered)

    def test_rejects_nested_file_prefix_collision(self):
        candidate = self.root / "prefix-collision"
        candidate.mkdir()
        nested_raw = io.BytesIO()
        with tarfile.open(fileobj=nested_raw, mode="w") as archive:
            for name in ["bin", "bin/runtime"]:
                member = tarfile.TarInfo(name)
                member.size = 1
                archive.addfile(member, io.BytesIO(b"x"))
        nested = gzip.compress(nested_raw.getvalue(), mtime=0)
        tarball = candidate / "package.tgz"
        with tarfile.open(tarball, "w:gz") as archive:
            member = tarfile.TarInfo("package/runtime.tar.gz")
            member.size = len(nested)
            archive.addfile(member, io.BytesIO(nested))
        digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
        (candidate / "package.tgz.sha256").write_text(digest + "  package.tgz\n", encoding="utf-8")

        with self.assertRaises(ValueError):
            MODULE.build_attestation(candidate, candidate)


if __name__ == "__main__":
    unittest.main()
