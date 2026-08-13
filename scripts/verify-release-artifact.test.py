import hashlib
import io
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
import importlib.util


SCRIPT = Path(__file__).with_name("verify-release-artifact.py")
SPEC = importlib.util.spec_from_file_location("forgeax_verify_release_artifact", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class VerifyReleaseArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.candidate = self.root / "candidate"
        self.extract_to = self.root / "extracted"
        self.candidate.mkdir()

    def tearDown(self):
        self.temporary_directory.cleanup()

    def write_tarball(self, members):
        tarball = self.candidate / "package.tgz"
        with tarfile.open(tarball, "w:gz") as archive:
            for member, content in members:
                archive.addfile(member, io.BytesIO(content) if content is not None else None)
        digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
        (self.candidate / "package.tgz.sha256").write_text(
            digest + "  package.tgz\n", encoding="utf-8"
        )
        return digest

    def run_verifier(self, expected_sha=None, github_output=None):
        command = [
            sys.executable,
            str(SCRIPT),
            "--directory",
            str(self.candidate),
            "--extract-to",
            str(self.extract_to),
        ]
        if expected_sha is not None:
            command.extend(["--expected-sha", expected_sha])
        if github_output is not None:
            command.extend(["--github-output", str(github_output)])
        return subprocess.run(command, capture_output=True, text=True, check=False)

    def test_verifies_and_extracts_one_safe_tarball(self):
        directory = tarfile.TarInfo("package/dist")
        directory.type = tarfile.DIRTYPE
        payload = b"export const value = 1;\n"
        source = tarfile.TarInfo("package/dist/index.js")
        source.size = len(payload)
        digest = self.write_tarball([(directory, None), (source, payload)])

        github_output = self.root / "github-output"
        result = self.run_verifier(expected_sha=digest, github_output=github_output)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.extract_to / "package/dist/index.js").read_bytes(), payload)
        outputs = github_output.read_text(encoding="utf-8")
        self.assertIn("sha256=" + digest + "\n", outputs)
        self.assertIn("package_root=" + str((self.extract_to / "package").resolve()), outputs)

    def test_rejects_a_sidecar_or_expected_digest_mismatch(self):
        payload = b"safe"
        source = tarfile.TarInfo("package/index.js")
        source.size = len(payload)
        self.write_tarball([(source, payload)])
        (self.candidate / "package.tgz.sha256").write_text("0" * 64 + "  package.tgz\n")

        result = self.run_verifier(expected_sha="f" * 64)

        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.extract_to.exists())

    def test_rejects_expected_digest_mismatch(self):
        payload = b"safe"
        source = tarfile.TarInfo("package/index.js")
        source.size = len(payload)
        self.write_tarball([(source, payload)])

        result = self.run_verifier(expected_sha="f" * 64)

        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.extract_to.exists())

    def test_requires_exactly_one_tarball_and_one_matching_sidecar(self):
        result = self.run_verifier()
        self.assertNotEqual(result.returncode, 0)

        (self.candidate / "first.tgz").write_bytes(b"first")
        (self.candidate / "second.tgz").write_bytes(b"second")
        (self.candidate / "first.tgz.sha256").write_text("0" * 64 + "  first.tgz\n")
        result = self.run_verifier()
        self.assertNotEqual(result.returncode, 0)

    def test_rejects_unsafe_archive_members(self):
        unsafe_members = []

        absolute = tarfile.TarInfo("/absolute")
        absolute.size = 0
        unsafe_members.append(("absolute path", [(absolute, b"")]))

        traversal = tarfile.TarInfo("package/../escape")
        traversal.size = 0
        unsafe_members.append(("path traversal", [(traversal, b"")]))

        wrong_root = tarfile.TarInfo("other/file")
        wrong_root.size = 0
        unsafe_members.append(("wrong root", [(wrong_root, b"")]))

        symbolic_link = tarfile.TarInfo("package/link")
        symbolic_link.type = tarfile.SYMTYPE
        symbolic_link.linkname = "package/file"
        unsafe_members.append(("symbolic link", [(symbolic_link, None)]))

        hard_link = tarfile.TarInfo("package/hard-link")
        hard_link.type = tarfile.LNKTYPE
        hard_link.linkname = "package/file"
        unsafe_members.append(("hard link", [(hard_link, None)]))

        fifo = tarfile.TarInfo("package/fifo")
        fifo.type = tarfile.FIFOTYPE
        unsafe_members.append(("fifo", [(fifo, None)]))

        duplicate_one = tarfile.TarInfo("package/duplicate")
        duplicate_one.size = 0
        duplicate_two = tarfile.TarInfo("package/duplicate")
        duplicate_two.size = 0
        unsafe_members.append(
            ("duplicate path", [(duplicate_one, b""), (duplicate_two, b"")])
        )

        drive_relative = tarfile.TarInfo("package/C:escape")
        drive_relative.size = 0
        unsafe_members.append(("drive-relative path", [(drive_relative, b"")]))

        alternate_data_stream = tarfile.TarInfo("package/file:stream")
        alternate_data_stream.size = 0
        unsafe_members.append(("alternate data stream", [(alternate_data_stream, b"")]))

        device_name = tarfile.TarInfo("package/CON")
        device_name.size = 0
        unsafe_members.append(("Windows device name", [(device_name, b"")]))

        extended_device_name = tarfile.TarInfo("package/CONIN$.txt")
        extended_device_name.size = 0
        unsafe_members.append(("extended Windows device name", [(extended_device_name, b"")]))

        superscript_device_name = tarfile.TarInfo("package/COM¹.txt")
        superscript_device_name.size = 0
        unsafe_members.append(("superscript Windows device name", [(superscript_device_name, b"")]))

        case_collision_one = tarfile.TarInfo("package/Foo")
        case_collision_one.size = 0
        case_collision_two = tarfile.TarInfo("package/foo")
        case_collision_two.size = 0
        unsafe_members.append(
            ("case-insensitive collision", [(case_collision_one, b""), (case_collision_two, b"")])
        )

        file_prefix = tarfile.TarInfo("package/runtime")
        file_prefix.size = 0
        file_prefix_child = tarfile.TarInfo("package/runtime/child")
        file_prefix_child.size = 0
        unsafe_members.append(
            ("file-prefix collision", [(file_prefix, b""), (file_prefix_child, b"")])
        )

        for label, members in unsafe_members:
            with self.subTest(label=label):
                for child in self.candidate.iterdir():
                    child.unlink()
                self.write_tarball(members)
                result = self.run_verifier()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.extract_to.exists())
                self.assertFalse((self.root / "escape").exists())

    def test_rejects_sparse_pax_metadata(self):
        with self.assertRaises(SystemExit):
            MODULE._validate_pax_extension(b"31 GNU.sparse.realsize=16777216\n")

    def test_rejects_surrogate_archive_paths_without_traceback(self):
        with self.assertRaises(SystemExit):
            MODULE._portable_path("package/\udcff", "package")


if __name__ == "__main__":
    unittest.main()
