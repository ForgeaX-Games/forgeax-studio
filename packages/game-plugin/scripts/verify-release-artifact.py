#!/usr/bin/env python3
import argparse
import hashlib
import re
import shutil
import tarfile
from pathlib import Path, PurePosixPath


SHA256_PATTERN = re.compile(r"^([0-9a-fA-F]{64})\s+[ *]?([^\r\n]+)\s*$")


def fail(message):
    raise SystemExit("release artifact verification failed: " + message)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def select_artifact(directory):
    tarballs = sorted(directory.glob("*.tgz"))
    sidecars = sorted(directory.glob("*.tgz.sha256"))
    if len(tarballs) != 1:
        fail("expected exactly one *.tgz")
    if len(sidecars) != 1 or sidecars[0].name != tarballs[0].name + ".sha256":
        fail("expected exactly one matching *.tgz.sha256")
    return tarballs[0], sidecars[0]


def verify_digest(tarball, sidecar, expected_sha):
    match = SHA256_PATTERN.fullmatch(sidecar.read_text(encoding="utf-8"))
    if not match or match.group(2) != tarball.name:
        fail("invalid SHA-256 sidecar")
    actual = sha256(tarball)
    if match.group(1).lower() != actual:
        fail("sidecar SHA-256 does not match tarball")
    if expected_sha is not None:
        if not re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha):
            fail("invalid expected SHA-256")
        if expected_sha.lower() != actual:
            fail("expected SHA-256 does not match tarball")
    return actual


def validated_members(archive):
    members = archive.getmembers()
    seen = set()
    for member in members:
        if "\\" in member.name:
            fail("archive member uses a backslash path")
        path = PurePosixPath(member.name)
        if path.is_absolute() or not path.parts or path.parts[0] != "package":
            fail("archive member is not rooted under package/")
        if any(part in ("", ".", "..") for part in path.parts):
            fail("archive member contains an unsafe path segment")
        normalized = path.as_posix()
        if normalized in seen:
            fail("archive contains a duplicate path")
        seen.add(normalized)
        if not member.isdir() and not member.isfile():
            fail("archive contains a link or special file")
    return members


def extract_safely(tarball, extract_to):
    if extract_to.exists():
        fail("extraction directory already exists")
    with tarfile.open(tarball, "r:gz") as archive:
        members = validated_members(archive)
        extract_to.mkdir(parents=True)
        try:
            for member in members:
                destination = extract_to.joinpath(*PurePosixPath(member.name).parts)
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    fail("regular archive member has no payload")
                with source, destination.open("xb") as output:
                    shutil.copyfileobj(source, output)
        except BaseException:
            shutil.rmtree(extract_to, ignore_errors=True)
            raise


def write_github_output(path, tarball, digest, package_root):
    if path is None:
        return
    with path.open("a", encoding="utf-8") as output:
        output.write("tarball=" + str(tarball.resolve()) + "\n")
        output.write("sha256=" + digest + "\n")
        output.write("package_root=" + str(package_root.resolve()) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--extract-to", required=True, type=Path)
    parser.add_argument("--expected-sha")
    parser.add_argument("--github-output", type=Path)
    arguments = parser.parse_args()

    directory = arguments.directory.resolve()
    if not directory.is_dir():
        fail("artifact directory does not exist")
    tarball, sidecar = select_artifact(directory)
    digest = verify_digest(tarball, sidecar, arguments.expected_sha)
    extract_safely(tarball, arguments.extract_to)
    package_root = arguments.extract_to / "package"
    if not package_root.is_dir():
        shutil.rmtree(arguments.extract_to, ignore_errors=True)
        fail("archive does not contain package/")
    write_github_output(arguments.github_output, tarball, digest, package_root)
    print("release artifact verified: " + tarball.name + " sha256=" + digest)


if __name__ == "__main__":
    main()
