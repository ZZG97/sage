#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib import error, parse, request


DEFAULT_BASE_URL = "http://127.0.0.1:1211"
DEFAULT_DATA_DIR = Path.home() / "deploy" / "freshrss" / "data"
DEFAULT_USER = "zhang"


class SkillError(RuntimeError):
    pass


@dataclass
class FeedRecord:
    feed_id: int
    title: str
    feed_url: str
    site_url: str
    group: str | None = None


def parse_php_array_string(path: Path, key: str) -> str:
    text = path.read_text(encoding="utf-8")
    pattern = re.compile(rf"'{re.escape(key)}'\s*=>\s*'((?:\\.|[^'])*)'")
    match = pattern.search(text)
    if not match:
        raise SkillError(f"cannot find `{key}` in {path}")
    return match.group(1).replace("\\'", "'").replace("\\\\", "\\")


def api_paths(base_url: str) -> tuple[str, str]:
    base = base_url.rstrip("/")
    return (
        f"{base}/api/fever.php",
        f"{base}/api/greader.php",
    )


def fever_request(base_url: str, fever_key: str, **params: str) -> dict[str, Any]:
    fever_url, _ = api_paths(base_url)
    payload = {"api_key": fever_key, **params}
    body = parse.urlencode(payload).encode("utf-8")
    req = request.Request(fever_url, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise SkillError(f"fever api http {exc.code}: {detail}") from exc
    except error.URLError as exc:
        raise SkillError(f"fever api connection failed: {exc}") from exc
    if not isinstance(data, dict) or data.get("auth") != 1:
        raise SkillError(f"fever api auth failed: {data}")
    return data


def greader_auth_token(system_config: Path, user_config: Path, username: str) -> str:
    salt = parse_php_array_string(system_config, "salt")
    api_password_hash = parse_php_array_string(user_config, "apiPasswordHash")
    digest = hashlib.sha1(f"{salt}{username}{api_password_hash}".encode("utf-8")).hexdigest()
    return f"{username}/{digest}"


def greader_check(base_url: str, auth_token: str) -> tuple[bool, str]:
    _, greader_url = api_paths(base_url)
    req = request.Request(f"{greader_url}/check/compatibility")
    req.add_header("Authorization", f"GoogleLogin auth={auth_token}")
    try:
        with request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8", "replace").strip()
            return body == "PASS", body
    except error.HTTPError as exc:
        return False, exc.read().decode("utf-8", "replace").strip() or f"HTTP {exc.code}"
    except error.URLError as exc:
        return False, str(exc)


def greader_unsubscribe(base_url: str, auth_token: str, stream_id: str) -> str:
    _, greader_url = api_paths(base_url)
    body = parse.urlencode({"ac": "unsubscribe", "s": stream_id}).encode("utf-8")
    req = request.Request(
        f"{greader_url}/reader/api/0/subscription/edit",
        data=body,
        method="POST",
    )
    req.add_header("Authorization", f"GoogleLogin auth={auth_token}")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8", "replace").strip()


def user_paths(data_dir: Path, username: str) -> tuple[Path, Path, Path]:
    system_config = data_dir / "config.php"
    user_dir = data_dir / "users" / username
    user_config = user_dir / "config.php"
    db_path = user_dir / "db.sqlite"
    return system_config, user_config, db_path


def load_fever_key(user_config: Path) -> str:
    key = parse_php_array_string(user_config, "feverKey")
    if not re.fullmatch(r"[0-9a-f]{32}", key):
        raise SkillError(f"invalid fever key in {user_config}")
    return key


def fetch_feeds(base_url: str, fever_key: str) -> list[FeedRecord]:
    data = fever_request(base_url, fever_key, feeds="1", groups="1")
    groups = {int(group["id"]): str(group["title"]) for group in data.get("groups", [])}
    grouped_feed_ids: dict[int, int] = {}
    for item in data.get("feeds_groups", []):
        group_id = int(item["group_id"])
        for feed_id_str in str(item.get("feed_ids", "")).split(","):
            if feed_id_str:
                grouped_feed_ids[int(feed_id_str)] = group_id

    feeds: list[FeedRecord] = []
    for feed in data.get("feeds", []):
        feed_id = int(feed["id"])
        group_name = groups.get(grouped_feed_ids.get(feed_id))
        feeds.append(
            FeedRecord(
                feed_id=feed_id,
                title=str(feed["title"]),
                feed_url=str(feed["url"]),
                site_url=str(feed["site_url"]),
                group=group_name,
            )
        )
    feeds.sort(key=lambda item: ((item.group or ""), item.title.lower(), item.feed_id))
    return feeds


def fetch_groups(base_url: str, fever_key: str) -> list[dict[str, Any]]:
    data = fever_request(base_url, fever_key, groups="1")
    groups = list(data.get("groups", []))
    groups.sort(key=lambda item: str(item["title"]).lower())
    return groups


def find_feed_by_exact_match(db_path: Path, feed_id: int | None, title: str | None, url: str | None) -> FeedRecord:
    clauses: list[str] = []
    values: list[Any] = []
    if feed_id is not None:
        clauses.append("id = ?")
        values.append(feed_id)
    if title is not None:
        clauses.append("name = ?")
        values.append(title)
    if url is not None:
        clauses.append("url = ?")
        values.append(url)
    if not clauses:
        raise SkillError("one of --id, --title, or --url is required")

    query = "SELECT id, name, url, COALESCE(website, '') FROM feed WHERE " + " AND ".join(clauses)
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(query, values).fetchall()
    finally:
        conn.close()
    if len(rows) == 0:
        raise SkillError("feed not found")
    if len(rows) > 1:
        raise SkillError("feed match is ambiguous")
    row = rows[0]
    return FeedRecord(feed_id=int(row[0]), title=row[1], feed_url=row[2], site_url=row[3], group=None)


def db_delete_feed(db_path: Path, feed_id: int) -> int:
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("BEGIN")
        cursor = conn.execute("DELETE FROM feed WHERE id = ?", (feed_id,))
        conn.commit()
        return cursor.rowcount
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def print_feeds(feeds: list[FeedRecord], show_urls: bool) -> None:
    grouped: dict[str, list[FeedRecord]] = {}
    for feed in feeds:
        key = feed.group or "Ungrouped"
        grouped.setdefault(key, []).append(feed)
    for group_name in sorted(grouped):
        print(f"[{group_name}] ({len(grouped[group_name])})")
        for feed in grouped[group_name]:
            if show_urls:
                print(f"{feed.feed_id}\t{feed.title}\t{feed.feed_url}")
            else:
                print(f"{feed.feed_id}\t{feed.title}")
        print()


def cmd_list_groups(args: argparse.Namespace) -> int:
    system_config, user_config, _ = user_paths(args.data_dir, args.user)
    _ = system_config
    fever_key = load_fever_key(user_config)
    groups = fetch_groups(args.base_url, fever_key)
    if args.json:
        print(json.dumps(groups, ensure_ascii=False, indent=2))
        return 0
    for group in groups:
        print(f"{group['id']}\t{group['title']}")
    return 0


def cmd_list_feeds(args: argparse.Namespace) -> int:
    _, user_config, _ = user_paths(args.data_dir, args.user)
    fever_key = load_fever_key(user_config)
    feeds = fetch_feeds(args.base_url, fever_key)
    if args.group:
        feeds = [feed for feed in feeds if feed.group == args.group]
    if args.json:
        print(json.dumps([feed.__dict__ for feed in feeds], ensure_ascii=False, indent=2))
        return 0
    print_feeds(feeds, show_urls=args.show_urls)
    return 0


def cmd_check_greader(args: argparse.Namespace) -> int:
    system_config, user_config, _ = user_paths(args.data_dir, args.user)
    auth_token = greader_auth_token(system_config, user_config, args.user)
    ok, detail = greader_check(args.base_url, auth_token)
    payload = {"ok": ok, "detail": detail}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        status = "PASS" if ok else "FAIL"
        print(f"{status}\t{detail}")
    return 0 if ok else 1


def cmd_remove_feed(args: argparse.Namespace) -> int:
    system_config, user_config, db_path = user_paths(args.data_dir, args.user)
    target = find_feed_by_exact_match(db_path, args.id, args.title, args.url)
    auth_token = greader_auth_token(system_config, user_config, args.user)
    ok, detail = greader_check(args.base_url, auth_token)
    result: dict[str, Any] = {
        "feed_id": target.feed_id,
        "title": target.title,
        "url": target.feed_url,
        "method": None,
    }

    if ok:
        reply = greader_unsubscribe(args.base_url, auth_token, f"feed/{target.feed_id}")
        result["method"] = "greader"
        result["reply"] = reply
    elif args.db_fallback:
        deleted = db_delete_feed(db_path, target.feed_id)
        if deleted != 1:
            raise SkillError(f"db fallback deleted {deleted} rows, expected 1")
        result["method"] = "db-fallback"
        result["reason"] = detail
    else:
        raise SkillError(
            "greader unsubscribe unavailable in current environment; "
            "rerun with --db-fallback to allow local fallback"
        )

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if result["method"] == "greader":
            print(f"removed via greader\t{target.feed_id}\t{target.title}")
        else:
            print(f"removed via db-fallback\t{target.feed_id}\t{target.title}")
            print(f"greader detail\t{detail}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="FreshRSS management helpers for rss-manager skill")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="FreshRSS base URL, default: %(default)s")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR, help="FreshRSS data dir")
    parser.add_argument("--user", default=DEFAULT_USER, help="FreshRSS username, default: %(default)s")

    subparsers = parser.add_subparsers(dest="command", required=True)

    list_groups = subparsers.add_parser("list-groups", help="List FreshRSS groups via Fever API")
    list_groups.add_argument("--json", action="store_true", help="Emit JSON")
    list_groups.set_defaults(func=cmd_list_groups)

    list_feeds = subparsers.add_parser("list-feeds", help="List FreshRSS feeds via Fever API")
    list_feeds.add_argument("--group", help="Only show feeds in one group")
    list_feeds.add_argument("--show-urls", action="store_true", help="Include feed URL in text output")
    list_feeds.add_argument("--json", action="store_true", help="Emit JSON")
    list_feeds.set_defaults(func=cmd_list_feeds)

    check_greader = subparsers.add_parser("check-greader", help="Check whether GReader auth works end-to-end")
    check_greader.add_argument("--json", action="store_true", help="Emit JSON")
    check_greader.set_defaults(func=cmd_check_greader)

    remove_feed = subparsers.add_parser("remove-feed", help="Remove one FreshRSS feed")
    remove_match = remove_feed.add_mutually_exclusive_group(required=True)
    remove_match.add_argument("--id", type=int, help="Exact FreshRSS feed id")
    remove_match.add_argument("--title", help="Exact FreshRSS feed title")
    remove_match.add_argument("--url", help="Exact FreshRSS feed URL")
    remove_feed.add_argument("--db-fallback", action="store_true", help="Allow local DB fallback when GReader is unavailable")
    remove_feed.add_argument("--json", action="store_true", help="Emit JSON")
    remove_feed.set_defaults(func=cmd_remove_feed)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return int(args.func(args))
    except SkillError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
