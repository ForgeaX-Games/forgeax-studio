#!/usr/bin/env python3
import argparse
import os
import re
import shutil
import tarfile
from pathlib import Path, PurePosixPath


RUNTIME_ARCHIVE = re.compile(
    r"^assets/runtime/([^/]+)/forgeax-game-runtime-\1\.tar\.gz$"
)
MAX_MEMBERS = 100_000
MAX_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024


def fail(message):
    raise SystemExit("TruffleHog package scan preparation failed: " + message)


def copy_file(source, destination):
    try:
        os.link(source, destination)
        return destination
    except OSError:
        return shutil.copy2(source, destination)


def validated_members(archive, archive_path):
    members = archive.getmembers()
    if len(members) > MAX_MEMBERS:
        fail(f"runtime archive has too many members: {archive_path}")
    seen = set()
    expanded_bytes = 0
    for member in members:
        if "\\" in member.name:
            fail(f"runtime archive member uses a backslash path: {archive_path}")
        path = PurePosixPath(member.name)
        if path.is_absolute() or not path.parts:
            fail(f"runtime archive member has an unsafe path: {archive_path}")
        if any(part in ("", ".", "..") for part in path.parts):
            fail(f"runtime archive member has an unsafe path segment: {archive_path}")
        normalized = path.as_posix()
        if normalized in seen:
            fail(f"runtime archive contains a duplicate path: {archive_path}")
        seen.add(normalized)
        if not member.isdir() and not member.isfile():
            fail(f"runtime archive contains a link or special file: {archive_path}")
        if member.isfile():
            expanded_bytes += member.size
            if expanded_bytes > MAX_EXPANDED_BYTES:
                fail(f"runtime archive expands beyond the size limit: {archive_path}")
    return members


def expand_runtime_archive(archive_path):
    destination_root = archive_path.with_name(archive_path.name + ".contents")
    if destination_root.exists():
        fail(f"runtime archive scan directory already exists: {destination_root}")
    with tarfile.open(archive_path, "r:gz") as archive:
        members = validated_members(archive, archive_path)
        destination_root.mkdir()
        try:
            for member in members:
                destination = destination_root.joinpath(*PurePosixPath(member.name).parts)
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    fail(f"runtime archive member has no payload: {archive_path}")
                with source, destination.open("xb") as output:
                    shutil.copyfileobj(source, output)
        except BaseException:
            shutil.rmtree(destination_root, ignore_errors=True)
            raise
    archive_path.unlink()


def prepare(source, destination):
    if not source.is_dir():
        fail("package root does not exist")
    if destination.exists():
        fail("scan directory already exists")
    shutil.copytree(source, destination, symlinks=True, copy_function=copy_file)
    archives = []
    for path in destination.rglob("*.tar.gz"):
        relative_path = path.relative_to(destination).as_posix()
        if RUNTIME_ARCHIVE.fullmatch(relative_path):
            archives.append(path)
    for archive_path in archives:
        expand_runtime_archive(archive_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    arguments = parser.parse_args()
    prepare(arguments.source.resolve(), arguments.destination.resolve())


if __name__ == "__main__":
    main()
