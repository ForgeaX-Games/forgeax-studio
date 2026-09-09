#!/usr/bin/env python3
"""Replay two verified release-artifact observations without approving a release.

The existing release verifier owns outer archive selection, digest validation,
bounded extraction, and path safety. This module only derives deterministic,
sanitized evidence from the extracted candidates and scanner metadata.
"""

from __future__ import annotations

import argparse
import bz2
import contextlib
import gzip
import hashlib
import importlib.util
import json
import lzma
import os
import re
import sys
import tarfile
import tempfile
import unicodedata
from pathlib import Path, PurePosixPath
from tempfile import NamedTemporaryFile, TemporaryDirectory
from typing import Any, Iterable


_SAFE_LABEL = re.compile(r"^[A-Za-z0-9._-]+$")
_WINDOWS_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")
_PATH_COMPONENT = re.compile(r"^[A-Za-z0-9._-]{1,127}$")
_WINDOWS_DEVICE_NAMES = frozenset(
    {
        "con",
        "prn",
        "aux",
        "nul",
        *(f"com{i}" for i in range(1, 10)),
        *(f"lpt{i}" for i in range(1, 10)),
        "conin$",
        "conout$",
        "com¹",
        "com²",
        "com³",
        "lpt¹",
        "lpt²",
        "lpt³",
    }
)
_NESTED_SUFFIXES = (".tar", ".tar.gz", ".tar.xz", ".tgz")
_MAX_NESTED_MEMBER_COUNT = 4096
_MAX_NESTED_MEMBER_BYTES = 64 * 1024 * 1024
_MAX_NESTED_TOTAL_BYTES = 256 * 1024 * 1024
_MAX_NESTED_COMPRESSION_RATIO = 1000
_MIN_BYTES_FOR_COMPRESSION_RATIO = 8 * 1024 * 1024
_MAX_NESTED_ARCHIVE_COUNT = 64
_MAX_NESTED_CANDIDATE_MEMBER_COUNT = 65_536
_MAX_NESTED_CANDIDATE_TOTAL_BYTES = 1024 * 1024 * 1024
_MAX_FINDINGS_FILE_BYTES = 16 * 1024 * 1024
_MAX_FINDING_LINE_BYTES = 1024 * 1024
_MAX_FINDING_COUNT = 4096
_MAX_METADATA_TEXT_BYTES = 256
_SAFE_DECODER_VALUES = frozenset({"PLAIN", "BASE64", "HEX", "UTF8", "UTF-8", "NONE", "UNKNOWN"})
_TAR_BLOCK_BYTES = 512
_MAX_TAR_EXTENSION_BYTES = 1024 * 1024
_MAX_TAR_METADATA_BYTES = 64 * 1024 * 1024
_MAX_XZ_DECODER_MEMORY = 64 * 1024 * 1024
_MAX_MEMBER_PATH_BYTES = 4096
_MAX_MEMBER_PATH_DEPTH = 256
_TAR_EXTENSION_TYPES = {b"x", b"g", b"X", b"L", b"K"}
_RUNTIME_RELEASE_SURFACE = "game-runtime"
_RUNTIME_EVIDENCE_KINDS = ("archive", "hash", "secretScan", "crossStage", "provenance")


def _load_verifier() -> Any:
    path = Path(__file__).with_name("verify-release-artifact.py")
    spec = importlib.util.spec_from_file_location("forgeax_verify_release_artifact", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load release verifier: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_VERIFIER = _load_verifier()


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _fail(message: str) -> None:
    raise ValueError(f"release attestation failed: {message}")


def _runtime_fail(code: str, expected: str, actual: str, recovery: str) -> None:
    raise ValueError(
        f"release-integrity.{code}: expected={expected} actual={actual} recoveryActions=[{recovery}]"
    )


def _runtime_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        _runtime_fail("runtime-projection-invalid", f"non-empty {field}", repr(value), "repair-runtime-evidence")
    return value


def _runtime_digest(value: Any, field: str) -> str:
    digest = _runtime_text(value, field)
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        _runtime_fail("runtime-digest-invalid", "sha256 hex digest", digest, "recompute-runtime-digest")
    return digest


def _runtime_subjects(value: Any, field: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        _runtime_fail("runtime-subjects-missing", f"non-empty {field}", repr(value), "produce-runtime-subjects")
    subjects: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            _runtime_fail("runtime-subject-invalid", "subject object", repr(item), "repair-runtime-subjects")
        subject_id = _runtime_text(item.get("subjectId"), f"{field}.subjectId")
        digest = _runtime_digest(item.get("digest"), f"{field}.{subject_id}.digest")
        if item.get("digestAlgorithm") != "sha256":
            _runtime_fail("runtime-digest-invalid", "digestAlgorithm=sha256", repr(item.get("digestAlgorithm")), "repair-runtime-subjects")
        if not isinstance(item.get("name"), str) or not item["name"]:
            _runtime_fail("runtime-subject-invalid", "non-empty subject name", repr(item.get("name")), "repair-runtime-subjects")
        subject = dict(item)
        subject["subjectId"] = subject_id
        subject["digest"] = digest
        subjects.append(subject)
    if len({subject["subjectId"] for subject in subjects}) != len(subjects):
        _runtime_fail("runtime-subjects-duplicate", "unique subjectId values", field, "rebuild-runtime-subjects")
    return subjects


def _runtime_evidence_entry(
    evidence: dict[str, Any],
    kind: str,
    candidate_id: str,
    subjects: list[dict[str, Any]],
) -> dict[str, Any]:
    entry = evidence.get(kind)
    if not isinstance(entry, dict):
        _runtime_fail("runtime-evidence-missing", kind, "missing", "rebuild-runtime-projection")
    if entry.get("status") != "passed":
        _runtime_fail("runtime-evidence-not-passed", f"{kind}.status=passed", repr(entry.get("status")), "rerun-runtime-gate")
    if entry.get("candidateId") != candidate_id:
        _runtime_fail("runtime-candidate-mismatch", candidate_id, repr(entry.get("candidateId")), "create-new-runtime-attempt")
    reference = _runtime_text(entry.get("evidenceRef"), f"{kind}.evidenceRef")
    observed_subjects = _runtime_subjects(entry.get("subjects"), f"{kind}.subjects")
    if observed_subjects != subjects:
        _runtime_fail("runtime-subject-digest-mismatch", "candidate actualSubjects", f"{kind}.subjects", "recompute-runtime-digest")
    projected = {"status": "passed", "candidateId": candidate_id, "evidenceRef": reference}
    projected["subjects"] = observed_subjects
    return projected


def project_runtime_result(candidate: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    """Project existing Runtime observations into release-integrity-result.v1."""

    if not isinstance(candidate, dict) or not isinstance(evidence, dict):
        _runtime_fail("runtime-projection-invalid", "candidate and evidence objects", "invalid input", "repair-runtime-evidence")
    candidate_id = _runtime_text(candidate.get("candidateId"), "candidateId")
    if candidate.get("releaseSurface") != _RUNTIME_RELEASE_SURFACE:
        _runtime_fail("runtime-surface-mismatch", _RUNTIME_RELEASE_SURFACE, repr(candidate.get("releaseSurface")), "select-runtime-candidate")
    root_revision = _runtime_text(candidate.get("rootRevision"), "rootRevision")
    attempt = _runtime_text(candidate.get("attempt"), "attempt")
    expected_subjects = _runtime_subjects(candidate.get("expectedSubjects"), "expectedSubjects")
    actual_subjects = _runtime_subjects(candidate.get("actualSubjects"), "actualSubjects")
    if expected_subjects != actual_subjects:
        _runtime_fail("runtime-subject-digest-mismatch", "expectedSubjects=actualSubjects", "candidate subject sets differ", "rebuild-runtime-candidate")
    if not isinstance(candidate.get("criticalInputs"), list) or not candidate["criticalInputs"]:
        _runtime_fail("runtime-critical-input-missing", "candidate-bound criticalInputs", "missing", "record-runtime-inputs")
    if evidence.get("releaseSurface") != _RUNTIME_RELEASE_SURFACE:
        _runtime_fail("runtime-surface-mismatch", _RUNTIME_RELEASE_SURFACE, repr(evidence.get("releaseSurface")), "select-runtime-evidence")
    if evidence.get("candidateId") != candidate_id:
        _runtime_fail("runtime-candidate-mismatch", candidate_id, repr(evidence.get("candidateId")), "create-new-runtime-attempt")

    projected_evidence = {
        kind: _runtime_evidence_entry(evidence, kind, candidate_id, actual_subjects)
        for kind in _RUNTIME_EVIDENCE_KINDS
    }
    aggregate = evidence.get("platformAggregate")
    if not isinstance(aggregate, dict) or aggregate.get("status") != "passed":
        _runtime_fail("runtime-platform-gate-not-passed", "platformAggregate.status=passed", repr(aggregate), "rerun-runtime-platform-gates")
    if aggregate.get("candidateId") != candidate_id:
        _runtime_fail("runtime-candidate-mismatch", candidate_id, repr(aggregate.get("candidateId")), "create-new-runtime-attempt")
    aggregate_ref = _runtime_text(aggregate.get("evidenceRef"), "platformAggregate.evidenceRef")
    projected_evidence["platformAggregate"] = {
        "status": "passed",
        "candidateId": candidate_id,
        "evidenceRef": aggregate_ref,
    }
    evidence_refs = ";".join(
        f"{kind}={projected_evidence[kind]['evidenceRef']}" for kind in (*_RUNTIME_EVIDENCE_KINDS, "platformAggregate")
    )
    return {
        "schemaVersion": 1,
        "candidateId": candidate_id,
        "releaseSurface": _RUNTIME_RELEASE_SURFACE,
        "status": "fully-verified",
        "sourceAdmission": {
            "status": "passed",
            "expected": f"rootRevision={root_revision};attempt={attempt}",
            "actual": f"candidateId={candidate_id};rootRevision={root_revision};attempt={attempt}",
        },
        "contentIntegrity": {
            "status": "passed",
            "expected": "archive/hash/secretScan/crossStage/provenance",
            "actual": evidence_refs,
        },
        "platformTrust": {
            "status": "passed",
            "expected": "applicable Runtime platform aggregate",
            "actual": aggregate_ref,
        },
        "subjects": actual_subjects,
        "criticalInputs": candidate["criticalInputs"],
        "sourceWork": {"status": "permitted"},
        "recoveryActions": [],
        "trustDag": {"status": "verified", "candidateId": candidate_id},
    }


def _portable_component(component: str) -> bool:
    return bool(
        _PATH_COMPONENT.fullmatch(component)
        and not component.endswith((".", " "))
        and ":" not in component
        and "\x00" not in component
        and component.rstrip(" .").split(".", 1)[0].casefold() not in _WINDOWS_DEVICE_NAMES
    )


def _portable_path(value: str, root: str | None = None) -> bool:
    path = PurePosixPath(value)
    try:
        path_bytes = len(value.encode("utf-8"))
    except UnicodeEncodeError:
        return False
    return bool(
        value == path.as_posix()
        and path_bytes <= _MAX_MEMBER_PATH_BYTES
        and len(path.parts) <= _MAX_MEMBER_PATH_DEPTH
        and not path.is_absolute()
        and path.parts
        and (root is None or path.parts[0] == root)
        and all(
            part not in ("", ".", "..")
            and _portable_component(part)
            for part in path.parts
        )
    )


def _safe_relative_path(value: str) -> tuple[str | None, str | None]:
    """Never emit scanner path text; preserve only its opaque fingerprint."""

    if not isinstance(value, str):
        _fail("scanner path must be a string")
    return None, _sha256_bytes(value.encode("utf-8"))


def _optional_text(value: Any, field: str) -> str | dict[str, str] | None:
    if value is None:
        return None
    if not isinstance(value, str):
        _fail(f"scanner field {field} must be a string or null")
    if len(value.encode("utf-8")) > _MAX_METADATA_TEXT_BYTES or any(ord(character) < 32 for character in value):
        return {"sha256": _sha256_bytes(value.encode("utf-8"))}
    if field == "decoder" and value in _SAFE_DECODER_VALUES:
        return value
    return {"sha256": _sha256_bytes(value.encode("utf-8"))}


def _optional_int(value: Any, field: str) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool):
        _fail(f"scanner field {field} must be an integer or null")
    if value < 0 or value > 2**31 - 1:
        _fail(f"scanner field {field} is outside the supported range")
    return value


def _optional_bool(value: Any, field: str) -> bool | None:
    if value is None:
        return None
    if not isinstance(value, bool):
        _fail(f"scanner field {field} must be a boolean or null")
    return value


def _finding_metadata(raw: dict[str, Any], root: Path) -> dict[str, Any]:
    source_metadata = raw.get("SourceMetadata", {})
    if not isinstance(source_metadata, dict):
        _fail("scanner SourceMetadata must be an object")
    source_data = source_metadata.get("Data", {})
    if not isinstance(source_data, dict):
        _fail("scanner SourceMetadata.Data must be an object")
    filesystem = source_data.get("Filesystem", {})
    if not isinstance(filesystem, dict):
        _fail("scanner SourceMetadata.Data.Filesystem must be an object")
    path_value = raw["file"] if "file" in raw else filesystem.get("file")
    line_value = raw["line"] if "line" in raw else filesystem.get("line")
    path, path_fingerprint = (None, None)
    if path_value is not None:
        path, path_fingerprint = _safe_relative_path(path_value)
    metadata = {
        "detector": _optional_text(raw.get("detector", raw.get("DetectorName")), "detector"),
        "detectorType": _optional_int(raw.get("detectorType", raw.get("DetectorType")), "detectorType"),
        "decoder": _optional_text(raw.get("decoder", raw.get("DecoderName")), "decoder"),
        "verified": _optional_bool(raw.get("verified", raw.get("Verified")), "verified"),
        "path": path,
        "pathFingerprint": path_fingerprint,
        "line": _optional_int(line_value, "line"),
        "allowlistedBy": _optional_text(raw.get("allowlistedBy"), "allowlistedBy"),
    }
    return metadata


def _read_findings(path: Path | None, root: Path) -> list[dict[str, Any]]:
    if path is None:
        return []
    findings: list[dict[str, Any]] = []
    try:
        source = path.open("rb")
    except OSError as exc:
        _fail(f"finding input cannot be opened: {exc}")
    with source:
        if os.fstat(source.fileno()).st_size > _MAX_FINDINGS_FILE_BYTES:
            _fail("finding input exceeds the file-size limit")
        line_number = 0
        bytes_read = 0
        while True:
            raw_line = source.readline(_MAX_FINDING_LINE_BYTES + 1)
            if not raw_line:
                break
            bytes_read += len(raw_line)
            if bytes_read > _MAX_FINDINGS_FILE_BYTES:
                _fail("finding input exceeds the file-size limit")
            line_number += 1
            if len(raw_line) > _MAX_FINDING_LINE_BYTES:
                _fail(f"finding input line {line_number} exceeds the line-size limit")
            try:
                line = raw_line.decode("utf-8")
            except UnicodeDecodeError:
                _fail(f"finding input line {line_number} is not UTF-8")
            if not line.strip():
                continue
            if len(findings) >= _MAX_FINDING_COUNT:
                _fail("finding input exceeds the finding-count limit")
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                _fail(f"finding input line {line_number} is not JSON: {exc.msg}")
            if not isinstance(value, dict):
                _fail(f"finding input line {line_number} must be an object")
            metadata = _finding_metadata(value, root)
            findings.append({"metadata": metadata, "fingerprint": _digest(metadata)})
    return sorted(findings, key=lambda item: (item["fingerprint"], _canonical_bytes(item["metadata"])))


def _collision_key(path: str) -> str:
    return "/".join(unicodedata.normalize("NFC", part).rstrip(" .").casefold() for part in PurePosixPath(path).parts)


class _PathIndex:
    def __init__(self, label: str):
        self.label = label
        self.seen: set[str] = set()
        self.descendants: set[str] = set()
        self.file_paths: set[str] = set()

    def add(self, path: str, kind: str) -> None:
        key = _collision_key(path)
        if key in self.seen or (kind == "file" and key in self.descendants):
            _fail(f"{self.label} contains a duplicate or colliding path: {path}")
        parts = key.split("/")
        ancestors = ["/".join(parts[:index]) for index in range(1, len(parts))]
        if any(ancestor in self.file_paths for ancestor in ancestors):
            _fail(f"{self.label} contains a file-prefix collision: {path}")
        self.seen.add(key)
        if kind == "file":
            self.file_paths.add(key)
        self.descendants.update(ancestors)


def _validate_nested_member(member: tarfile.TarInfo) -> tuple[str, str, int]:
    if "\\" in member.name or _WINDOWS_DRIVE_PREFIX.match(member.name) or not _portable_path(member.name):
        _fail("nested archive member has an unsafe path")
    if getattr(member, "sparse", None):
        _fail("sparse archive members are unsupported")
    path = PurePosixPath(member.name)
    if member.isdir():
        return path.as_posix(), "directory", 0
    if not member.isfile():
        _fail("nested archive contains a link or special file")
    if member.size < 0 or member.size > _MAX_NESTED_MEMBER_BYTES:
        _fail("nested archive member exceeds the per-file size limit")
    return path.as_posix(), "file", member.size


def _read_tar_size(raw: bytes) -> int:
    value = raw.rstrip(b"\0 ")
    if not value:
        return 0
    if value[0] & 0x80:
        _fail("tar uses an unsupported base-256 size field")
    try:
        parsed = int(value, 8)
    except ValueError:
        _fail("tar contains an invalid size field")
    if parsed < 0:
        _fail("tar contains a negative size")
    return parsed


def _read_exact(source: Any, count: int) -> None:
    remaining = count
    while remaining:
        chunk = source.read(min(remaining, 1024 * 1024))
        if not chunk:
            _fail("tar ended before its declared payload")
        remaining -= len(chunk)


def _read_payload(source: Any, size: int) -> bytes:
    payload = bytearray()
    remaining = size
    while remaining:
        chunk = source.read(min(remaining, 1024 * 1024))
        if not chunk:
            _fail("tar ended before its declared payload")
        payload.extend(chunk)
        remaining -= len(chunk)
    padding = (_TAR_BLOCK_BYTES - size % _TAR_BLOCK_BYTES) % _TAR_BLOCK_BYTES
    _read_exact(source, padding)
    return bytes(payload)


def _validate_pax_extension(payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        separator = payload.find(b" ", offset)
        if separator <= offset:
            _fail("tar contains an invalid PAX extension")
        try:
            record_length = int(payload[offset:separator])
        except ValueError:
            _fail("tar contains an invalid PAX extension length")
        if record_length <= separator - offset or offset + record_length > len(payload):
            _fail("tar contains a truncated PAX extension")
        record = payload[separator + 1 : offset + record_length]
        if not record.endswith(b"\n") or b"=" not in record:
            _fail("tar contains an invalid PAX extension record")
        key = record.split(b"=", 1)[0]
        if key in {b"size", b"SCHILY.realsize"} or key.startswith(b"GNU.sparse."):
            _fail("sparse or logical-size PAX metadata is unsupported")
        offset += record_length


def _check_nested_output_limit(decoded_bytes: int, compressed_bytes: int, budget: dict[str, int]) -> None:
    if decoded_bytes > _MAX_NESTED_TOTAL_BYTES:
        _fail("nested archive exceeds the total uncompressed-size limit")
    if decoded_bytes >= _MIN_BYTES_FOR_COMPRESSION_RATIO and decoded_bytes > compressed_bytes * _MAX_NESTED_COMPRESSION_RATIO:
        _fail("nested archive exceeds the compression-ratio limit")
    if budget["totalBytes"] + decoded_bytes > _MAX_NESTED_CANDIDATE_TOTAL_BYTES:
        _fail("candidate nested archives exceed the total uncompressed-size limit")


def _write_bounded(source: Any, destination: Any, budget: dict[str, int], decoded_bytes: int, compressed_bytes: int) -> int:
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        decoded_bytes += len(chunk)
        _check_nested_output_limit(decoded_bytes, compressed_bytes, budget)
        destination.write(chunk)
    return decoded_bytes


@contextlib.contextmanager
def _nested_snapshot(path: Path, budget: dict[str, int]):
    with path.open("rb") as raw:
        magic = raw.read(6)
    with tempfile.TemporaryFile(mode="w+b") as snapshot:
        decoded_bytes = 0
        compressed_bytes = max(1, path.stat().st_size)
        if magic.startswith(b"\x1f\x8b"):
            with gzip.open(path, "rb") as source:
                decoded_bytes = _write_bounded(source, snapshot, budget, decoded_bytes, compressed_bytes)
        elif magic.startswith(b"BZh"):
            with bz2.open(path, "rb") as source:
                decoded_bytes = _write_bounded(source, snapshot, budget, decoded_bytes, compressed_bytes)
        elif magic.startswith(b"\xfd7zXZ\x00"):
            with path.open("rb") as raw:
                decoder = lzma.LZMADecompressor(format=lzma.FORMAT_AUTO, memlimit=_MAX_XZ_DECODER_MEMORY)
                while not decoder.eof:
                    chunk = raw.read(1024 * 1024) if decoder.needs_input else b""
                    if decoder.needs_input and not chunk:
                        _fail("nested XZ stream ended before its end marker")
                    try:
                        decoded = decoder.decompress(chunk, max_length=1024 * 1024)
                    except lzma.LZMAError as exc:
                        _fail(f"nested XZ stream is invalid or exceeds the decoder memory limit: {exc}")
                    decoded_bytes += len(decoded)
                    _check_nested_output_limit(decoded_bytes, compressed_bytes, budget)
                    snapshot.write(decoded)
                if decoder.unused_data or raw.read(1):
                    _fail("nested XZ stream has unsupported trailing compressed data")
        else:
            with path.open("rb") as source:
                decoded_bytes = _write_bounded(source, snapshot, budget, decoded_bytes, compressed_bytes)
        budget["totalBytes"] += decoded_bytes
        snapshot.seek(0)
        yield snapshot


def _preflight_nested_tar(source: Any, compressed_bytes: int) -> None:
    member_count = 0
    total_bytes = 0
    metadata_bytes = 0
    source.seek(0)
    while True:
        header = source.read(_TAR_BLOCK_BYTES)
        if len(header) != _TAR_BLOCK_BYTES:
            _fail("nested archive has a truncated header")
        if header == b"\0" * _TAR_BLOCK_BYTES:
            trailer = source.read(_TAR_BLOCK_BYTES)
            if trailer != b"\0" * _TAR_BLOCK_BYTES:
                _fail("nested archive has a truncated end marker")
            break
        member_count += 1
        if member_count > _MAX_NESTED_MEMBER_COUNT:
            _fail("nested archive exceeds the member-count limit")
        size = _read_tar_size(header[124:136])
        typeflag = header[156:157]
        if typeflag == b"S":
            _fail("sparse archive members are unsupported")
        if size > _MAX_NESTED_MEMBER_BYTES:
            _fail("nested archive member exceeds the per-file size limit")
        total_bytes += size
        if total_bytes > _MAX_NESTED_TOTAL_BYTES:
            _fail("nested archive exceeds the total uncompressed-size limit")
        if total_bytes >= _MIN_BYTES_FOR_COMPRESSION_RATIO and total_bytes > compressed_bytes * _MAX_NESTED_COMPRESSION_RATIO:
            _fail("nested archive exceeds the compression-ratio limit")
        if typeflag in _TAR_EXTENSION_TYPES and size > _MAX_TAR_EXTENSION_BYTES:
            _fail("nested archive extension header exceeds the size limit")
        if typeflag in _TAR_EXTENSION_TYPES:
            metadata_bytes += size
            if metadata_bytes > _MAX_TAR_METADATA_BYTES:
                _fail("nested archive extension data exceeds the aggregate size limit")
            extension = _read_payload(source, size)
            if typeflag in {b"x", b"g", b"X"}:
                _validate_pax_extension(extension)
        else:
            _read_exact(source, size + ((_TAR_BLOCK_BYTES - size % _TAR_BLOCK_BYTES) % _TAR_BLOCK_BYTES))
    source.seek(0)


def _sha256_stream(source: Any, expected_size: int) -> str:
    digest = hashlib.sha256()
    total = 0
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        total += len(chunk)
        if total > expected_size:
            _fail("nested archive payload exceeds its declared size")
        digest.update(chunk)
    if total != expected_size:
        _fail("nested archive payload length differs from its header")
    return digest.hexdigest()


def _nested_content_digest(archive_path: Path, budget: dict[str, int]) -> tuple[str, int]:
    entries: list[dict[str, Any]] = []
    index = _PathIndex("nested archive")
    with _nested_snapshot(archive_path, budget) as source:
        _preflight_nested_tar(source, max(1, archive_path.stat().st_size))
        with tarfile.open(fileobj=source, mode="r:") as archive:
            for member in archive:
                budget["memberCount"] += 1
                if budget["memberCount"] > _MAX_NESTED_CANDIDATE_MEMBER_COUNT:
                    _fail("candidate nested archives exceed the member-count limit")
                path, kind, size = _validate_nested_member(member)
                index.add(path, kind)
                entry: dict[str, Any] = {"kind": kind, "path": path, "size": size}
                if kind == "file":
                    member_source = archive.extractfile(member)
                    if member_source is None:
                        _fail(f"nested archive member has no payload: {path}")
                    with member_source:
                        entry["sha256"] = _sha256_stream(member_source, size)
                entries.append(entry)
    entries.sort(key=lambda item: (item["path"], item["kind"]))
    return _digest(entries), len(entries)


def _tree_manifest(root: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            relative = path.relative_to(root).as_posix()
            entries.append({"path": relative, "size": path.stat().st_size, "sha256": _VERIFIER.sha256(path)})
    return entries


def _candidate_observation(directory: Path, findings_path: Path | None, label: str, temp_root: Path) -> dict[str, Any]:
    if not _SAFE_LABEL.fullmatch(label):
        _fail(f"invalid candidate label: {label!r}")
    directory = directory.resolve()
    if not directory.is_dir():
        _fail(f"candidate directory does not exist: {directory}")
    tarball, sidecar = _VERIFIER.select_artifact(directory)
    extract_to = temp_root / label
    try:
        outer_sha, outer_size = _VERIFIER.verify_and_extract(tarball, sidecar, extract_to)
    except SystemExit as exc:
        _fail(str(exc))
    package_root = extract_to / "package"
    if not package_root.is_dir():
        _fail("archive does not contain package/")

    tree_entries = _tree_manifest(extract_to)
    nested: list[dict[str, Any]] = []
    nested_budget = {"archiveCount": 0, "memberCount": 0, "totalBytes": 0}
    for path in sorted(extract_to.rglob("*")):
        if not path.is_file() or not path.name.lower().endswith(_NESTED_SUFFIXES):
            continue
        nested_budget["archiveCount"] += 1
        if nested_budget["archiveCount"] > _MAX_NESTED_ARCHIVE_COUNT:
            _fail("candidate exceeds the nested-archive count limit")
        content_sha, member_count = _nested_content_digest(path, nested_budget)
        nested.append({
            "path": path.relative_to(extract_to).as_posix(),
            "size": path.stat().st_size,
            "sha256": _VERIFIER.sha256(path),
            "contentSha256": content_sha,
            "memberCount": member_count,
        })

    return {
        "label": label,
        "outerPackage": {"path": tarball.name, "size": outer_size, "sha256": outer_sha},
        "nestedArchives": nested,
        "normalizedExtractedTree": {"fileCount": len(tree_entries), "sha256": _digest(tree_entries)},
        "findingFingerprints": _read_findings(findings_path, directory),
    }


def _compare(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    dimensions = {
        "outerPackage": left["outerPackage"] == right["outerPackage"],
        "nestedArchives": left["nestedArchives"] == right["nestedArchives"],
        "normalizedExtractedTree": left["normalizedExtractedTree"] == right["normalizedExtractedTree"],
        "findingFingerprints": left["findingFingerprints"] == right["findingFingerprints"],
    }
    return {"equal": all(dimensions.values()), "dimensions": dimensions}


def build_attestation(left: Path, right: Path, left_findings: Path | None = None, right_findings: Path | None = None) -> dict[str, Any]:
    with TemporaryDirectory(prefix="forgeax-release-attestation-") as temporary:
        temp_root = Path(temporary)
        left_observation = _candidate_observation(left, left_findings, "left", temp_root)
        right_observation = _candidate_observation(right, right_findings, "right", temp_root)
    return {
        "schemaVersion": "release-artifact-attestation/v1",
        "candidates": [left_observation, right_observation],
        "comparison": _compare(left_observation, right_observation),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Replay sanitized evidence for two release candidates")
    parser.add_argument("--left", type=Path, help="left candidate directory")
    parser.add_argument("--right", type=Path, help="right candidate directory")
    parser.add_argument("--left-findings", type=Path, help="optional left scanner JSONL")
    parser.add_argument("--right-findings", type=Path, help="optional right scanner JSONL")
    parser.add_argument("--runtime-candidate", type=Path, help="Runtime candidate JSON")
    parser.add_argument("--runtime-evidence", type=Path, help="Runtime evidence JSON")
    parser.add_argument("--output", type=Path, help="write deterministic JSON here instead of stdout")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    try:
        if arguments.runtime_candidate is not None or arguments.runtime_evidence is not None:
            if arguments.runtime_candidate is None or arguments.runtime_evidence is None:
                _runtime_fail("runtime-projection-invalid", "both Runtime JSON inputs", "one input missing", "repair-runtime-evidence")
            with arguments.runtime_candidate.open(encoding="utf-8") as candidate_file:
                candidate = json.load(candidate_file)
            with arguments.runtime_evidence.open(encoding="utf-8") as evidence_file:
                evidence = json.load(evidence_file)
            result = project_runtime_result(candidate, evidence)
        else:
            if arguments.left is None or arguments.right is None:
                raise ValueError("--left and --right are required unless Runtime projection inputs are supplied")
            result = build_attestation(arguments.left, arguments.right, arguments.left_findings, arguments.right_findings)
        rendered = json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        if arguments.output is None:
            sys.stdout.write(rendered)
        else:
            if not arguments.output.parent.is_dir():
                raise OSError(f"output parent does not exist: {arguments.output.parent}")
            temporary_path = None
            try:
                with NamedTemporaryFile("w", encoding="utf-8", dir=arguments.output.parent, prefix=".attestation-", delete=False) as temporary:
                    temporary_path = Path(temporary.name)
                    temporary.write(rendered)
                os.replace(temporary_path, arguments.output)
                temporary_path = None
            finally:
                if temporary_path is not None:
                    temporary_path.unlink(missing_ok=True)
    except (OSError, UnicodeError, ValueError, SystemExit, tarfile.TarError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
