#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path


INCLUDE_PATTERN = re.compile(r"^@(?P<path>\S+)\s*$")
ESCAPED_INCLUDE_PATTERN = re.compile(r"^@@(?P<path>\S+)\s*$")


@dataclass(frozen=True)
class RenderTarget:
    template: str
    output: str


DEFAULT_TARGETS = (
    RenderTarget("prompt-templates/AGENTS-template.md", "AGENTS.md"),
    RenderTarget("prompt-templates/CLAUDE-template.md", "CLAUDE.md"),
)


def resolve_under_root(root: Path, rel_path: str, label: str) -> Path:
    path = Path(rel_path)
    if path.is_absolute():
        raise RuntimeError(f"{label} must be relative: {rel_path}")

    normalized = Path(os.path.normpath(path.as_posix()))
    if normalized.parts and normalized.parts[0] == "..":
        raise RuntimeError(f"{label} escapes workspace root: {rel_path}")

    # `memory/` and `wikis/` may be symlinks into sage-data. The workspace
    # boundary check is about the requested path, not the symlink target.
    return (root / normalized).resolve()


def render_template(template_path: Path, root: Path, seen: tuple[Path, ...]) -> str:
    resolved_template = template_path.resolve()
    if resolved_template in seen:
        chain = " -> ".join(str(path) for path in [*seen, resolved_template])
        raise RuntimeError(f"circular include detected: {chain}")

    lines = template_path.read_text(encoding="utf-8").splitlines()
    rendered: list[str] = []
    next_seen = (*seen, resolved_template)

    for line in lines:
        escaped = ESCAPED_INCLUDE_PATTERN.match(line)
        if escaped:
            rendered.append(f"@{escaped.group('path')}")
            continue

        match = INCLUDE_PATTERN.match(line)
        if not match:
            rendered.append(line)
            continue

        include_rel_path = match.group("path")
        include_path = resolve_under_root(root, include_rel_path, "include")

        if not include_path.is_file():
            raise RuntimeError(f"include target not found: {include_rel_path}")

        rendered.append(render_template(include_path, root, next_seen))

    return "\n".join(rendered) + "\n"


def build_output(root: Path, target: RenderTarget) -> str:
    template_path = resolve_under_root(root, target.template, "template")
    if not template_path.is_file():
        raise RuntimeError(f"template not found: {template_path}")

    rendered = render_template(template_path, root, ())
    return rendered


def render_target(root: Path, target: RenderTarget, check: bool) -> bool:
    output_path = resolve_under_root(root, target.output, "output")
    expected = build_output(root, target)
    current = output_path.read_text(encoding="utf-8") if output_path.exists() else None

    if current == expected:
        print(f"unchanged {target.output}")
        return False

    if check:
        print(f"outdated {target.output}")
        return True

    output_path.write_text(expected, encoding="utf-8")
    print(f"updated {target.output}")
    return True


def parse_targets(args: argparse.Namespace) -> tuple[RenderTarget, ...]:
    if args.template or args.output:
        if not args.template or not args.output:
            raise RuntimeError("--template and --output must be provided together")
        return (RenderTarget(args.template, args.output),)
    return DEFAULT_TARGETS


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Render Claude Code and Codex system prompt files from templates with @file includes.",
    )
    parser.add_argument(
        "--template",
        help="Render a single template path relative to the workspace root.",
    )
    parser.add_argument(
        "--output",
        help="Output path for --template, relative to the workspace root.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if any generated file is out of date; do not write files.",
    )
    args = parser.parse_args()

    root = Path.cwd().resolve()

    try:
        targets = parse_targets(args)
        changed = False
        for target in targets:
            changed = render_target(root, target, args.check) or changed
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    if args.check and changed:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
