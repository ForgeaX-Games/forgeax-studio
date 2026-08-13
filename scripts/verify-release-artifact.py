#!/usr/bin/env python3
import argparse
import gzip
import hashlib
import re
import shutil
import tarfile
import tempfile
import unicodedata
from contextlib import contextmanager
from pathlib import Path, PurePosixPath


SHA256_PATTERN = re.compile(r"^([0-9a-fA-F]{64})\s+[ *]?([^\r\n]+)\s*$")
MAX_SIDECAR_BYTES = 4096
MAX_COMPRESSED_BYTES = 2 * 1024 * 1024 * 1024
MAX_MEMBER_COUNT = 100_000
MAX_MEMBER_BYTES = 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024
MAX_COMPRESSION_RATIO = 1000
MIN_BYTES_FOR_COMPRESSION_RATIO = 8 * 1024 * 1024
TAR_BLOCK_BYTES = 512
MAX_TAR_EXTENSION_BYTES = 1024 * 1024
MAX_TAR_METADATA_BYTES = 64 * 1024 * 1024
MAX_MEMBER_PATH_BYTES = 4096
MAX_MEMBER_PATH_DEPTH = 256
TAR_EXTENSION_TYPES = {b"x", b"g", b"X", b"L", b"K"}
WINDOWS_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")
WINDOWS_DEVICE_NAMES = frozenset(
    {
        "con",
        "prn",
        "aux",
        "nul",
        "conin$",
        "conout$",
        *(f"com{i}" for i in range(1, 10)),
        *(f"lpt{i}" for i in range(1, 10)),
        "com¹",
        "com²",
        "com³",
        "lpt¹",
        "lpt²",
        "lpt³",
    }
)


def fail(message):
    raise SystemExit("release artifact verification failed: " + message)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        _update_digest(digest, source)
    return digest.hexdigest()


def _update_digest(digest, source):
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(chunk)


@contextmanager
def _snapshot(tarball):
    try:
        with tarball.open("rb") as source, tempfile.TemporaryFile(mode="w+b") as snapshot:
            compressed_bytes = 0
            digest = hashlib.sha256()
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                compressed_bytes += len(chunk)
                if compressed_bytes > MAX_COMPRESSED_BYTES:
                    fail("archive exceeds the compressed-size limit")
                snapshot.write(chunk)
                digest.update(chunk)
            snapshot.flush()
            snapshot.seek(0)
            yield snapshot, digest.hexdigest(), compressed_bytes
    except OSError as exc:
        fail("unable to read release artifact: " + str(exc))


def select_artifact(directory):
    tarballs = sorted(directory.glob("*.tgz"))
    sidecars = sorted(directory.glob("*.tgz.sha256"))
    if len(tarballs) != 1:
        fail("expected exactly one *.tgz")
    if len(sidecars) != 1 or sidecars[0].name != tarballs[0].name + ".sha256":
        fail("expected exactly one matching *.tgz.sha256")
    return tarballs[0], sidecars[0]


def verify_digest(tarball, sidecar, expected_sha):
    match = SHA256_PATTERN.fullmatch(_read_sidecar(sidecar))
    if not match or match.group(2) != tarball.name:
        fail("invalid SHA-256 sidecar")
    with _snapshot(tarball) as (_, actual, _):
        pass
    if match.group(1).lower() != actual:
        fail("sidecar SHA-256 does not match tarball")
    if expected_sha is not None:
        if not re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha):
            fail("invalid expected SHA-256")
        if expected_sha.lower() != actual:
            fail("expected SHA-256 does not match tarball")
    return actual


def _read_sidecar(sidecar):
    if sidecar.stat().st_size > MAX_SIDECAR_BYTES:
        fail("SHA-256 sidecar is too large")
    with sidecar.open("rb") as source:
        contents = source.read(MAX_SIDECAR_BYTES + 1)
    if len(contents) > MAX_SIDECAR_BYTES:
        fail("SHA-256 sidecar is too large")
    try:
        return contents.decode("utf-8")
    except UnicodeDecodeError:
        fail("SHA-256 sidecar is not UTF-8")


def _portable_path(path, root):
    if "\\" in path or "\x00" in path:
        fail("archive member has an unsafe path")
    value = PurePosixPath(path)
    try:
        path_bytes = len(path.encode("utf-8"))
    except UnicodeEncodeError:
        fail("archive member has an unsafe path")
    if (
        path_bytes > MAX_MEMBER_PATH_BYTES
        or len(value.parts) > MAX_MEMBER_PATH_DEPTH
        or value.is_absolute()
        or WINDOWS_DRIVE_PREFIX.match(path)
        or not value.parts
        or (root is not None and value.parts[0] != root)
        or any(part in ("", ".", "..") for part in value.parts)
    ):
        fail("archive member has an unsafe path")
    for part in value.parts:
        if any(ord(character) < 32 for character in part):
            fail("archive member has an unsafe path")
        if part.endswith((".", " ")) or ":" in part:
            fail("archive member has an unsafe path")
        if part.rstrip(" .").split(".", 1)[0].casefold() in WINDOWS_DEVICE_NAMES:
            fail("archive member has an unsafe path")
    normalized = value.as_posix()
    if normalized != path:
        fail("archive member is not a canonical path")
    return normalized


class _PathIndex:
    def __init__(self):
        self.seen = set()
        self.descendants = set()
        self.files = set()

    def add(self, path, kind):
        key = "/".join(unicodedata.normalize("NFC", part).rstrip(" .").casefold() for part in PurePosixPath(path).parts)
        if key in self.seen:
            fail("archive contains a duplicate path")
        parts = key.split("/")
        ancestors = ["/".join(parts[:index]) for index in range(1, len(parts))]
        if any(ancestor in self.files for ancestor in ancestors):
            fail("archive contains a file-prefix collision")
        if kind == "file" and key in self.descendants:
            fail("archive contains a file-prefix collision")
        self.seen.add(key)
        if kind == "file":
            self.files.add(key)
        self.descendants.update(ancestors)


def validated_members(archive):
    members = archive.getmembers()
    if len(members) > MAX_MEMBER_COUNT:
        fail("archive exceeds the member-count limit")
    total_bytes = 0
    index = _PathIndex()
    for member in members:
        _portable_path(member.name, "package")
        if getattr(member, "sparse", None):
            fail("sparse archive members are unsupported")
        kind = "file" if member.isfile() else "directory" if member.isdir() else None
        if kind is None:
            fail("archive contains a link or special file")
        if kind == "file":
            if member.size < 0 or member.size > MAX_MEMBER_BYTES:
                fail("archive member exceeds the per-file size limit")
            total_bytes += member.size
            if total_bytes > MAX_TOTAL_BYTES:
                fail("archive exceeds the total uncompressed-size limit")
        index.add(member.name, kind)
    return members, total_bytes


def _tar_size(raw):
    value = raw.rstrip(b"\0 ")
    if not value:
        return 0
    if value[0] & 0x80:
        fail("tar uses an unsupported base-256 size field")
    try:
        parsed = int(value, 8)
    except ValueError:
        fail("tar contains an invalid size field")
    if parsed < 0:
        fail("tar contains a negative size")
    return parsed


def _read_exact(source, count):
    remaining = count
    while remaining:
        chunk = source.read(min(remaining, 1024 * 1024))
        if not chunk:
            fail("tar ended before its declared payload")
        remaining -= len(chunk)


def _read_payload(source, size):
    payload = bytearray()
    remaining = size
    while remaining:
        chunk = source.read(min(remaining, 1024 * 1024))
        if not chunk:
            fail("tar ended before its declared payload")
        payload.extend(chunk)
        remaining -= len(chunk)
    padding = (TAR_BLOCK_BYTES - size % TAR_BLOCK_BYTES) % TAR_BLOCK_BYTES
    _read_exact(source, padding)
    return bytes(payload)


def _validate_pax_extension(payload):
    offset = 0
    while offset < len(payload):
        separator = payload.find(b" ", offset)
        if separator <= offset:
            fail("tar contains an invalid PAX extension")
        try:
            record_length = int(payload[offset:separator])
        except ValueError:
            fail("tar contains an invalid PAX extension length")
        if record_length <= separator - offset or offset + record_length > len(payload):
            fail("tar contains a truncated PAX extension")
        record = payload[separator + 1 : offset + record_length]
        if not record.endswith(b"\n") or b"=" not in record:
            fail("tar contains an invalid PAX extension record")
        key = record.split(b"=", 1)[0]
        if key in {b"size", b"SCHILY.realsize"} or key.startswith(b"GNU.sparse."):
            fail("sparse or logical-size PAX metadata is unsupported")
        offset += record_length


def _preflight_tar(source, compressed_bytes):
    source.seek(0)
    member_count = 0
    total_bytes = 0
    metadata_bytes = 0
    with gzip.GzipFile(fileobj=source, mode="rb") as decompressed:
        while True:
            header = decompressed.read(TAR_BLOCK_BYTES)
            if len(header) != TAR_BLOCK_BYTES:
                fail("archive has a truncated header")
            if header == b"\0" * TAR_BLOCK_BYTES:
                trailer = decompressed.read(TAR_BLOCK_BYTES)
                if trailer != b"\0" * TAR_BLOCK_BYTES:
                    fail("archive has a truncated end-of-archive marker")
                break
            member_count += 1
            if member_count > MAX_MEMBER_COUNT:
                fail("archive exceeds the member-count limit")
            size = _tar_size(header[124:136])
            typeflag = header[156:157]
            if typeflag == b"S":
                fail("sparse archive members are unsupported")
            if size > MAX_MEMBER_BYTES:
                fail("archive member exceeds the per-file size limit")
            total_bytes += size
            if total_bytes > MAX_TOTAL_BYTES:
                fail("archive exceeds the total uncompressed-size limit")
            if total_bytes >= MIN_BYTES_FOR_COMPRESSION_RATIO and total_bytes > compressed_bytes * MAX_COMPRESSION_RATIO:
                fail("archive exceeds the compression-ratio limit")
            if typeflag in TAR_EXTENSION_TYPES and size > MAX_TAR_EXTENSION_BYTES:
                fail("archive extension header exceeds the size limit")
            if typeflag in TAR_EXTENSION_TYPES:
                metadata_bytes += size
                if metadata_bytes > MAX_TAR_METADATA_BYTES:
                    fail("archive extension data exceeds the aggregate size limit")
            if typeflag in TAR_EXTENSION_TYPES:
                extension = _read_payload(decompressed, size)
                if typeflag in {b"x", b"g", b"X"}:
                    _validate_pax_extension(extension)
            else:
                _read_exact(decompressed, size + ((TAR_BLOCK_BYTES - size % TAR_BLOCK_BYTES) % TAR_BLOCK_BYTES))
    source.seek(0)
    if total_bytes >= MIN_BYTES_FOR_COMPRESSION_RATIO and total_bytes > compressed_bytes * MAX_COMPRESSION_RATIO:
        fail("archive exceeds the compression-ratio limit")


def _extract_members(archive, members, extract_to):
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
            written = 0
            with source, destination.open("xb") as output:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    written += len(chunk)
                    if written > member.size:
                        fail("archive payload exceeds its declared size")
                    output.write(chunk)
            if written != member.size:
                fail("archive member payload length differs from its header")
    except BaseException:
        shutil.rmtree(extract_to, ignore_errors=True)
        raise


def extract_safely(tarball, extract_to):
    if extract_to.exists():
        fail("extraction directory already exists")
    with _snapshot(tarball) as (source, _, compressed_bytes):
        _preflight_tar(source, compressed_bytes)
        source.seek(0)
        with tarfile.open(fileobj=source, mode="r:gz") as archive:
            members, _ = validated_members(archive)
            _extract_members(archive, members, extract_to)


def verify_and_extract(tarball, sidecar, extract_to, expected_sha=None):
    if extract_to.exists():
        fail("extraction directory already exists")
    match = SHA256_PATTERN.fullmatch(_read_sidecar(sidecar))
    if not match or match.group(2) != tarball.name:
        fail("invalid SHA-256 sidecar")
    if expected_sha is not None and not re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha):
        fail("invalid expected SHA-256")
    with _snapshot(tarball) as (source, actual, compressed_bytes):
        if match.group(1).lower() != actual:
            fail("sidecar SHA-256 does not match tarball")
        if expected_sha is not None and expected_sha.lower() != actual:
            fail("expected SHA-256 does not match tarball")
        _preflight_tar(source, compressed_bytes)
        source.seek(0)
        with tarfile.open(fileobj=source, mode="r:gz") as archive:
            members, _ = validated_members(archive)
            _extract_members(archive, members, extract_to)
    return actual, compressed_bytes


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
    digest, _ = verify_and_extract(tarball, sidecar, arguments.extract_to, arguments.expected_sha)
    package_root = arguments.extract_to / "package"
    if not package_root.is_dir():
        shutil.rmtree(arguments.extract_to, ignore_errors=True)
        fail("archive does not contain package/")
    write_github_output(arguments.github_output, tarball, digest, package_root)
    print("release artifact verified: " + tarball.name + " sha256=" + digest)


if __name__ == "__main__":
    main()
