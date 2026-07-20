#!/usr/bin/env python3
"""Crash-safe private mkdir lock with exact-owner release and stale recovery."""

from __future__ import annotations

import argparse
import datetime as dt
import errno
import fcntl
import json
import os
import shutil
import stat
import subprocess
import tempfile
import time
import uuid
from pathlib import Path


SCHEMA = "gbrain-run-lock/v1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("acquire", "release"))
    parser.add_argument("--lock-dir", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--owner-pid", type=int, required=True)
    parser.add_argument("--uninitialized-grace-seconds", type=int, default=60)
    parser.add_argument("--wait-seconds", type=float, default=0.0)
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    return parser.parse_args()


def boot_token() -> str:
    linux = Path("/proc/sys/kernel/random/boot_id")
    if linux.is_file():
        return linux.read_text(encoding="utf-8").strip()
    result = subprocess.run(
        ["/usr/sbin/sysctl", "-n", "kern.boottime"],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()
    return f"monotonic-boot:{int(time.time() - time.monotonic())}"


def process_start(pid: int) -> str | None:
    result = subprocess.run(
        ["/bin/ps", "-o", "lstart=", "-p", str(pid)],
        text=True,
        capture_output=True,
        check=False,
    )
    value = result.stdout.strip()
    return value or None


def process_is_same_live_owner(receipt: dict[str, object]) -> bool:
    try:
        pid = int(receipt["pid"])
    except (KeyError, TypeError, ValueError):
        return False
    if receipt.get("boot_token") != boot_token():
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    expected_start = receipt.get("process_start")
    current_start = process_start(pid)
    return not expected_start or not current_start or expected_start == current_start


def atomic_secure_json(path: Path, payload: dict[str, object]) -> None:
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=str(path.parent), prefix=f".{path.name}.", delete=False
    ) as handle:
        temporary = Path(handle.name)
        os.chmod(temporary, 0o600)
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    os.chmod(path, 0o600)


def inode_identity(info: os.stat_result) -> tuple[int, int]:
    return info.st_dev, info.st_ino


def open_lock_inode(lock_dir: Path) -> int:
    flags = os.O_RDONLY
    flags |= getattr(os, "O_DIRECTORY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    return os.open(lock_dir, flags)


def lock_inode(directory_fd: int, *, blocking: bool = False) -> bool:
    operation = fcntl.LOCK_EX
    if not blocking:
        operation |= fcntl.LOCK_NB
    try:
        fcntl.flock(directory_fd, operation)
    except OSError as error:
        if error.errno in (errno.EACCES, errno.EAGAIN):
            return False
        return False
    return True


def path_is_inode(lock_dir: Path, expected: tuple[int, int]) -> bool:
    try:
        return inode_identity(lock_dir.lstat()) == expected
    except OSError:
        return False


def read_json_at(directory_fd: int, name: str) -> object | None:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        value_fd = os.open(name, flags, dir_fd=directory_fd)
    except OSError:
        return None
    try:
        info = os.fstat(value_fd)
        if not stat.S_ISREG(info.st_mode):
            return None
        with os.fdopen(value_fd, "r", encoding="utf-8") as handle:
            value_fd = -1
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    finally:
        if value_fd >= 0:
            os.close(value_fd)


def lock_inode_has_safe_shape(directory_fd: int, info: os.stat_result) -> bool:
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        return False
    try:
        children = os.listdir(directory_fd)
    except OSError:
        return False
    if any(name != "owner.json" for name in children):
        return False
    if "owner.json" not in children:
        return True
    try:
        owner_info = os.stat(
            "owner.json", dir_fd=directory_fd, follow_symlinks=False
        )
    except OSError:
        return False
    return stat.S_ISREG(owner_info.st_mode)


def steal(lock_dir: Path, uninitialized_grace_seconds: int) -> bool:
    """Reclaim only the stale directory inode that this call inspected.

    The advisory lock is attached to the opened directory inode, not its
    reusable pathname. Competing helpers therefore cannot carry a stale
    decision across a winner's rename/create cycle and remove the new lock.
    """
    try:
        directory_fd = open_lock_inode(lock_dir)
    except OSError:
        return False
    try:
        info = os.fstat(directory_fd)
        expected = inode_identity(info)
        if not lock_inode(directory_fd):
            return False
        if not path_is_inode(lock_dir, expected):
            return False
        if not lock_inode_has_safe_shape(directory_fd, info):
            return False

        value = read_json_at(directory_fd, "owner.json")
        receipt = (
            value
            if isinstance(value, dict) and value.get("schema") == SCHEMA
            else None
        )
        if receipt and process_is_same_live_owner(receipt):
            return False
        age = time.time() - info.st_mtime
        if receipt is None and age < uninitialized_grace_seconds:
            return False

        # Recheck the pathname immediately before the rename while holding the
        # advisory lock on the inspected inode. Every helper mutation follows
        # the same inode lock protocol.
        if not path_is_inode(lock_dir, expected):
            return False
        quarantine = lock_dir.with_name(
            f"{lock_dir.name}.stale.{os.getpid()}.{uuid.uuid4().hex}"
        )
        try:
            os.rename(lock_dir, quarantine)
            if inode_identity(quarantine.lstat()) != expected:
                return False
            shutil.rmtree(quarantine)
        except OSError:
            return False
        return True
    finally:
        os.close(directory_fd)


def publish_new_lock(
    args: argparse.Namespace, lock_dir: Path, token_file: Path
) -> int:
    try:
        directory_fd = open_lock_inode(lock_dir)
    except OSError:
        return 75
    try:
        info = os.fstat(directory_fd)
        expected = inode_identity(info)
        # mkdir publishes the new inode before its creator can flock it. A
        # simultaneous contender may open that fresh directory and briefly
        # take the inspection flock first. Returning busy immediately would
        # strand an empty, uninitialized lock until the grace period expires.
        # Retry only on this exact inode for a bounded interval; a pathname
        # replacement or a persistently held flock still fails closed.
        initialization_deadline = time.monotonic() + 1.0
        while True:
            if not path_is_inode(lock_dir, expected):
                return 75
            if lock_inode(directory_fd):
                break
            if time.monotonic() >= initialization_deadline:
                return 75
            time.sleep(0.005)
        if not path_is_inode(lock_dir, expected):
            return 75
        token = uuid.uuid4().hex
        # Publish the external exact-owner token BEFORE owner.json names the
        # long-lived caller PID. If this short-lived helper is killed between
        # publications, contenders see an uninitialized lock and may recover it
        # after the grace window. Publishing owner.json first could strand a
        # live-owner lock forever because release has no token yet.
        token_file.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(token_file.parent, 0o700)
        atomic_secure_json(
            token_file, {"schema": SCHEMA, "token": token, "lock_dir": str(lock_dir)}
        )
        receipt = {
            "schema": SCHEMA,
            "owner": args.owner,
            "pid": args.owner_pid,
            "process_start": process_start(args.owner_pid),
            "boot_token": boot_token(),
            "acquired_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "token": token,
        }
        atomic_secure_json(lock_dir / "owner.json", receipt)
        return 0
    finally:
        os.close(directory_fd)


def acquire_once(
    args: argparse.Namespace, lock_dir: Path, token_file: Path
) -> int:
    for _ in range(3):
        try:
            lock_dir.mkdir(mode=0o700)
        except FileExistsError:
            if not steal(lock_dir, args.uninitialized_grace_seconds):
                continue
            continue
        return publish_new_lock(args, lock_dir, token_file)
    return 75


def acquire(args: argparse.Namespace) -> int:
    lock_dir = Path(args.lock_dir).expanduser().resolve()
    token_file = Path(args.token_file).expanduser().resolve()
    lock_dir.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(lock_dir.parent, 0o700)
    wait_seconds = float(getattr(args, "wait_seconds", 0.0))
    poll_seconds = float(getattr(args, "poll_seconds", 2.0))
    deadline = time.monotonic() + wait_seconds
    while True:
        result = acquire_once(args, lock_dir, token_file)
        if result == 0 or time.monotonic() >= deadline:
            return result
        time.sleep(min(poll_seconds, max(0.0, deadline - time.monotonic())))


def release(args: argparse.Namespace) -> int:
    lock_dir = Path(args.lock_dir).expanduser().resolve()
    token_file = Path(args.token_file).expanduser().resolve()
    try:
        directory_fd = open_lock_inode(lock_dir)
    except OSError:
        return 0
    try:
        info = os.fstat(directory_fd)
        expected = inode_identity(info)
        # A release may briefly wait for an in-flight inspection. If that
        # inspection already reclaimed this inode, the identity check below
        # prevents the delayed release from touching a replacement winner.
        if not lock_inode(directory_fd, blocking=True):
            return 75
        if not path_is_inode(lock_dir, expected):
            return 75
        try:
            token = json.loads(token_file.read_text(encoding="utf-8"))["token"]
        except (OSError, KeyError, TypeError, json.JSONDecodeError):
            return 0
        owner = read_json_at(directory_fd, "owner.json")
        if not isinstance(owner, dict):
            return 0
        if owner.get("token") != token or owner.get("owner") != args.owner:
            return 75
        try:
            # Keep this inode at lock_dir until the old exact-owner token is
            # gone. If token cleanup fails, owner.json has already been
            # removed, so the still-blocking directory is safely recoverable
            # as an uninitialized lock after the grace window.
            os.unlink("owner.json", dir_fd=directory_fd)
            if not path_is_inode(lock_dir, expected):
                return 75
            os.unlink(token_file)
            if not path_is_inode(lock_dir, expected):
                return 75
            lock_dir.rmdir()
        except OSError:
            return 74
        return 0
    finally:
        os.close(directory_fd)


def main() -> int:
    args = parse_args()
    if (
        args.owner_pid <= 0
        or args.uninitialized_grace_seconds < 1
        or args.wait_seconds < 0
        or args.poll_seconds <= 0
    ):
        return 64
    return acquire(args) if args.action == "acquire" else release(args)


if __name__ == "__main__":
    raise SystemExit(main())
