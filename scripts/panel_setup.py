#!/usr/bin/env python3
"""Install local panel skills safely, or inspect their expected paths (Python 3.9+)."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys


MANIFEST = ".panel-install.json"
START = "<!-- panel-routing:v1 -->"
END = "<!-- /panel-routing:v1 -->"
ROUTING = """<!-- panel-routing:v1 -->
## Маршрутизация panel
Каждое новое задание оцени по смыслу: простое — сразу выполнить без панели.
Новую сложную цель сначала уточни через навык panel; дальше цель → требования →
план → реализация. Сложный подвопрос уже принятой цели разбери нужными ролями,
используя прежние решения и факты; согласование цели заново не запускай.
quick — один агент; full — реальные отдельные агенты. Критик обязателен в обоих
режимах с самого начала; в full это отдельный агент. Если делегирование недоступно,
обозначь ограничение и предложи quick или другую среду.
В чате покажи состав и зачем роли, короткие реальные разногласия и общий вердикт;
подробности — по запросу. Не изображай спор и не перечитывай все справочники
при каждом сообщении: загружай только нужные текущему этапу.
<!-- /panel-routing:v1 -->
"""


class SetupError(Exception):
    pass


def safe_path(path):
    """Reject symlinks and file ancestors; never silently resolve an escape."""
    path = Path(path).expanduser()
    if ".." in path.parts:
        raise SetupError("Use a path without '..': {}".format(path))
    path = path.absolute()
    for entry in (path,) + tuple(path.parents):
        if entry.is_symlink():
            raise SetupError("Refusing symlink path: {}".format(entry))
        if entry != path and entry.exists() and not entry.is_dir():
            raise SetupError("Parent is not a directory: {}".format(entry))
    return path


def locations(host, scope, project, home=None):
    base = Path(project) if scope == "repo" else Path.home() if home is None else Path(home)
    base = safe_path(base)
    if not base.is_dir():
        raise SetupError("Scope directory does not exist: {}".format(base))
    if host == "codex":
        skills = base / ".agents" / "skills"
        instructions = base / "AGENTS.md" if scope == "repo" else base / ".codex" / "AGENTS.md"
    else:
        skills = base / ".claude" / "skills"
        instructions = base / "CLAUDE.md" if scope == "repo" else base / ".claude" / "CLAUDE.md"
    return skills, instructions


def package_files(source, package):
    """Snapshot only runtime allowlisted trees, even when installing inside source."""
    root = safe_path(source if package == "panel" else Path(source) / "scout")
    skill = root / "SKILL.md"
    if not skill.is_file() or skill.is_symlink():
        raise SetupError("Missing regular source skill: {}".format(skill))
    try:
        skill.read_text(encoding="utf-8")
    except UnicodeError as exc:
        raise SetupError("Source skill must be UTF-8: {}".format(skill)) from exc
    paths = [skill]
    trees = ("reference", "adapters", "agents") if package == "panel" else ("reference", "registry")
    for name in trees:
        folder = root / name
        if folder.is_symlink():
            raise SetupError("Refusing source symlink: {}".format(folder))
        if folder.exists() and not folder.is_dir():
            raise SetupError("Expected source directory: {}".format(folder))
        if folder.is_dir():
            for entry in sorted(folder.rglob("*")):
                if entry.is_symlink():
                    raise SetupError("Refusing source symlink: {}".format(entry))
                if entry.is_file():
                    rel = entry.relative_to(root)
                    if rel.as_posix() == "reference/profile.md" or "__pycache__" in rel.parts:
                        continue
                    if ".git" not in rel.parts and entry.suffix != ".pyc":
                        paths.append(entry)
    if package == "scout":
        scanner = root / "scripts" / "scan_skill.py"
        if scanner.exists() or scanner.is_symlink():
            safe_path(scanner)
            if not scanner.is_file():
                raise SetupError("Expected regular scanner: {}".format(scanner))
            paths.append(scanner)
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in paths}


def manifest_for(package, files):
    # This repository uses a simple metadata.version scalar; no YAML dependency.
    # Unknown frontmatter remains explicitly unversioned, never guessed from Git.
    version = "unversioned"
    lines = files["SKILL.md"].decode("utf-8").splitlines()
    in_metadata = False
    if lines and lines[0] == "---":
        for line in lines[1:]:
            if line == "---":
                break
            if line and not line[0].isspace():
                in_metadata = line == "metadata:"
            elif in_metadata and line.strip().startswith("version:"):
                version = line.strip().split(":", 1)[1].strip().strip("\"'") or "unversioned"
    return {"format_version": 1, "package": package, "skill_version": version, "files": {
        name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())
    }}


def check_existing(target, package, files):
    safe_path(target)
    if not target.exists():
        return False
    if not target.is_dir():
        raise SetupError("Destination already exists: {}".format(target))
    marker = target / MANIFEST
    if not marker.is_file() or marker.is_symlink():
        raise SetupError("Existing unmanaged destination; nothing overwritten: {}".format(target))
    try:
        recorded = json.loads(marker.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise SetupError("Invalid installation marker: {}".format(marker)) from exc
    expected = manifest_for(package, files)
    if recorded != expected:
        raise SetupError("Existing installation differs; inspect manually: {}".format(target))
    actual = set()
    for entry in target.rglob("*"):
        if entry.is_symlink():
            raise SetupError("Existing installation contains symlink: {}".format(entry))
        if entry.is_file():
            actual.add(entry.relative_to(target).as_posix())
        elif not entry.is_dir():
            raise SetupError("Existing installation contains special file: {}".format(entry))
    if actual != set(files) | {MANIFEST}:
        raise SetupError("Existing installation has missing or extra files: {}".format(target))
    for name, expected_data in files.items():
        if (target / name).read_bytes() != expected_data:
            raise SetupError("Existing installation was modified: {}".format(target / name))
    return True


def instruction_addition(path):
    safe_path(path)
    if path.exists() and not path.is_file():
        raise SetupError("Instructions path is not a regular file: {}".format(path))
    before = path.read_bytes() if path.exists() else None
    try:
        text = before.decode("utf-8") if before is not None else ""
    except UnicodeError as exc:
        raise SetupError("Instructions must be UTF-8: {}".format(path)) from exc
    if "panel-routing:" in text:
        if text.count(START) != 1 or text.count(END) != 1:
            raise SetupError("Conflicting routing markers; nothing overwritten: {}".format(path))
        begin, end = text.index(START), text.index(END) + len(END)
        if text[begin:end] != ROUTING.rstrip("\n"):
            raise SetupError("Existing routing block differs; inspect manually: {}".format(path))
        return before, b""
    separator = b"" if not before else b"\n" if before.endswith(b"\n") else b"\n\n"
    return before, separator + ROUTING.encode("utf-8")


def append_instructions(path, before, addition):
    if not addition:
        return
    safe_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_APPEND
    flags |= os.O_CREAT | os.O_EXCL if before is None else 0
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(str(path), flags, 0o644)
    with os.fdopen(descriptor, "ab") as stream:
        if before is not None and path.read_bytes() != before:
            raise SetupError("Instructions changed during installation: {}".format(path))
        stream.write(addition)


def within(path, parent):
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def guard_destinations(source, destinations):
    """Keep writes out of source payloads, including their future snapshots."""
    source = safe_path(source)
    roots = (source, source / "scout")
    payloads = tuple(source / name for name in ("reference", "adapters", "agents"))
    payloads += tuple(source / "scout" / name for name in ("reference", "registry", "scripts"))
    for destination in destinations:
        destination = safe_path(destination)
        if any(within(root, destination) for root in roots):
            raise SetupError("Destination overlaps a source package root: {}".format(destination))
        if any(within(destination, payload) for payload in payloads):
            raise SetupError("Destination is inside copied runtime content: {}".format(destination))


def install(source, skills, instructions, with_instructions=False):
    # Complete preflight before creating either skill or modifying instructions.
    destinations = [skills / "panel", skills / "scout"]
    if with_instructions:
        destinations.append(instructions)
    guard_destinations(source, destinations)
    packages = {name: package_files(source, name) for name in ("panel", "scout")}
    existing = {name: check_existing(skills / name, name, files) for name, files in packages.items()}
    addition = instruction_addition(instructions) if with_instructions else None
    created = []
    try:
        for name, files in packages.items():
            target = skills / name
            if existing[name]:
                continue
            safe_path(target)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.mkdir()  # Exclusive: never merge into an existing directory.
            created.append(target)
            for rel, data in files.items():
                destination = target / rel
                destination.parent.mkdir(parents=True, exist_ok=True)
                with destination.open("xb") as stream:
                    stream.write(data)
            with (target / MANIFEST).open("x", encoding="utf-8") as stream:
                json.dump(manifest_for(name, files), stream, ensure_ascii=False, indent=2)
                stream.write("\n")
        if addition is not None:
            append_instructions(instructions, *addition)
    except (OSError, SetupError):
        for target in reversed(created):
            shutil.rmtree(target)
        raise
    for name in packages:
        print("{}: {} {}".format(name, "UNCHANGED" if existing[name] else "INSTALLED", skills / name))
    if with_instructions:
        print("routing: {} {}".format("APPENDED" if addition[1] else "UNCHANGED", instructions))
    else:
        print("routing: not changed (use --instructions to append the marked block)")
    print("Runtime smoke-test required; installation does not prove auto-routing or delegation.")


def doctor(skills, instructions):
    ok = True
    for name in ("panel", "scout"):
        target = skills / name
        safe_path(target / "SKILL.md")
        present = (target / "SKILL.md").is_file()
        ok = ok and present
        print("{}: {} {}".format(name, "FOUND" if present else "MISSING", target))
        marker = target / MANIFEST
        safe_path(marker)
        status = "not present (unmanaged or missing)"
        if marker.is_file():
            try:
                value = json.loads(marker.read_text(encoding="utf-8"))
                valid = valid_manifest(value, name)
                status = "v1 found; fingerprints not verified" if valid else "invalid"
            except (ValueError, UnicodeError):
                status = "invalid"
        elif marker.exists():
            status = "invalid"
        if status == "invalid":
            ok = False
        print("  install marker: {}".format(status))
    safe_path(instructions)
    route_status = "not present"
    if instructions.is_file():
        try:
            value = instructions.read_text(encoding="utf-8")
            if START in value or END in value or "panel-routing:" in value:
                begin, end = value.find(START), value.find(END)
                valid = value.count(START) == 1 and value.count(END) == 1 and begin < end
                exact = valid and value[begin:end + len(END)] == ROUTING.rstrip("\n")
                route_status = "v1 found" if exact else "conflicting or incomplete"
                if not exact:
                    ok = False
        except UnicodeError:
            route_status = "not UTF-8"
            ok = False
    elif instructions.exists():
        route_status = "not a regular file"
        ok = False
    print("routing: {} {}".format(route_status, instructions))
    print("Read-only path check only: host discovery, active skill version, delegation, and auto-routing are UNVERIFIED.")
    print("Run the runtime smoke-test in the intended app/CLI session (reference/smoke-tests.md).")
    return 0 if ok else 1


def valid_manifest(value, package):
    if not isinstance(value, dict) or type(value.get("format_version")) is not int:
        return False
    if value["format_version"] != 1 or value.get("package") != package:
        return False
    if not isinstance(value.get("skill_version"), str) or not value["skill_version"]:
        return False
    files = value.get("files")
    if not isinstance(files, dict) or "SKILL.md" not in files:
        return False
    for name, digest in files.items():
        if not isinstance(name, str) or not name or name.startswith("/") or "\\" in name:
            return False
        if any(part in ("", ".", "..") for part in name.split("/")):
            return False
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            return False
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", choices=("doctor", "install"), default="doctor")
    parser.add_argument("--host", required=True, choices=("codex", "claude-code"))
    parser.add_argument("--scope", choices=("repo", "user"), default="repo")
    parser.add_argument("--project", type=Path, default=Path.cwd(), help="Project directory for repo scope (default: cwd)")
    parser.add_argument("--instructions", action="store_true", help="Install only: append a marked routing block; preserve existing instructions")
    args = parser.parse_args(argv)
    if args.action == "doctor" and args.instructions:
        parser.error("--instructions is available only for explicit install")
    try:
        skills, instructions = locations(args.host, args.scope, args.project)
        if args.action == "doctor":
            return doctor(skills, instructions)
        source = Path(__file__).resolve().parents[1]
        install(source, skills, instructions, args.instructions)
        return 0
    except (OSError, SetupError) as exc:
        print("ERROR: {}".format(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
