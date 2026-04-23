#!/usr/bin/env python3
"""Fetch one RSS/Atom feed and emit normalized JSONL item records.

The goal is to preserve as much feed/item metadata as possible without
hard-coding source-specific rules. Downstream digest logic can then choose the
best attribution field instead of losing source information at fetch time.
"""

from __future__ import annotations

import html
import json
import os
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from typing import Iterable


XML_NAMESPACES = {
    "atom": "http://www.w3.org/2005/Atom",
    "content": "http://purl.org/rss/1.0/modules/content/",
    "dc": "http://purl.org/dc/elements/1.1/",
}

HTML_TAG_RE = re.compile(r"<[^>]+>")
SOURCE_DESCRIPTION_LIMIT = 500


def parse_limit(env_name: str, default: int | None) -> int | None:
    raw = os.getenv(env_name)
    if raw is None:
        return default

    raw = raw.strip()
    if raw == "":
        return default

    try:
        value = int(raw)
    except ValueError:
        return default

    if value <= 0:
        return None

    return value


CONTENT_TEXT_LIMIT = parse_limit("RSS_CONTENT_TEXT_LIMIT", 20000)


def strip_html(text: str) -> str:
    return html.unescape(HTML_TAG_RE.sub("", text)).strip()


def clean_text(value: str | None, *, strip_tags: bool = False, limit: int | None = None) -> str:
    if not value:
        return ""
    text = strip_html(value) if strip_tags else html.unescape(value)
    text = text.strip()
    if limit is not None:
        text = text[:limit]
    return text


def text_content(elem: ET.Element | None, *, strip_tags: bool = False, limit: int | None = None) -> str:
    if elem is None:
        return ""
    if elem.text:
        return clean_text(elem.text, strip_tags=strip_tags, limit=limit)
    joined = "".join(elem.itertext())
    return clean_text(joined, strip_tags=strip_tags, limit=limit)


def first_text(elem: ET.Element, candidates: Iterable[str], *, strip_tags: bool = False, limit: int | None = None) -> str:
    for candidate in candidates:
        found = elem.find(candidate, XML_NAMESPACES)
        value = text_content(found, strip_tags=strip_tags, limit=limit)
        if value:
            return value
    return ""


def first_text_with_source(
    elem: ET.Element,
    candidates: Iterable[str],
    *,
    strip_tags: bool = False,
    limit: int | None = None,
) -> tuple[str, str]:
    for candidate in candidates:
        found = elem.find(candidate, XML_NAMESPACES)
        value = text_content(found, strip_tags=strip_tags, limit=limit)
        if value:
            return value, candidate
    return "", ""


def atom_link(elem: ET.Element) -> str:
    for link in elem.findall("atom:link", XML_NAMESPACES):
        rel = (link.attrib.get("rel") or "alternate").strip().lower()
        href = (link.attrib.get("href") or "").strip()
        if href and rel == "alternate":
            return href
    for link in elem.findall("atom:link", XML_NAMESPACES):
        href = (link.attrib.get("href") or "").strip()
        if href:
            return href
    return ""


def atom_author_name(elem: ET.Element) -> str:
    for author in elem.findall("atom:author", XML_NAMESPACES):
        name = text_content(author.find("atom:name", XML_NAMESPACES))
        if name:
            return name
        joined = "".join(author.itertext())
        joined = clean_text(joined)
        if joined:
            return joined
    return ""


def build_record(
    *,
    feed_url: str,
    source_type: str,
    source_title: str,
    source_link: str,
    source_description: str,
    source_author: str,
    source_contact: str,
    title: str,
    link: str,
    guid: str,
    description: str,
    content_source_field: str,
    pub_date: str,
    item_author: str,
) -> dict[str, str]:
    if not guid:
        guid = link or f"{title[:50]}_{pub_date}"

    author = item_author or source_author or source_title
    author_source = "item_author" if item_author else "source_author" if source_author else "source_title" if source_title else ""

    return {
        "title": title,
        "link": link,
        "guid": guid,
        "description": description,
        "content_source_field": content_source_field,
        "pubDate": pub_date,
        "feed_url": feed_url,
        "source_type": source_type,
        "source_title": source_title,
        "source_link": source_link,
        "source_description": source_description,
        "source_author": source_author,
        "source_contact": source_contact,
        "item_author": item_author,
        "author": author,
        "author_source": author_source,
    }


def parse_rss(root: ET.Element, feed_url: str) -> list[dict[str, str]]:
    channel = root.find("channel")
    if channel is None:
        return []

    source_title = first_text(channel, ["title"])
    source_link = first_text(channel, ["link"])
    source_description = first_text(channel, ["description"], strip_tags=True, limit=SOURCE_DESCRIPTION_LIMIT)
    source_author = ""
    source_contact = first_text(channel, ["managingEditor", "webMaster"])

    records: list[dict[str, str]] = []
    for item in channel.findall("item"):
        title = first_text(item, ["title"])
        link = first_text(item, ["link"])
        guid = first_text(item, ["guid"]) or link
        description, content_source_field = first_text_with_source(
            item,
            ["description", "content:encoded", "content"],
            strip_tags=True,
            limit=CONTENT_TEXT_LIMIT,
        )
        pub_date = first_text(item, ["pubDate"])
        item_author = first_text(item, ["author", "dc:creator"])

        records.append(
            build_record(
                feed_url=feed_url,
                source_type="rss",
                source_title=source_title,
                source_link=source_link,
                source_description=source_description,
                source_author=source_author,
                source_contact=source_contact,
                title=title,
                link=link,
                guid=guid,
                description=description,
                content_source_field=content_source_field,
                pub_date=pub_date,
                item_author=item_author,
            )
        )

    return records


def parse_atom(root: ET.Element, feed_url: str) -> list[dict[str, str]]:
    source_title = first_text(root, ["atom:title"])
    source_link = atom_link(root)
    source_description = first_text(root, ["atom:subtitle"], strip_tags=True, limit=SOURCE_DESCRIPTION_LIMIT)
    source_author = atom_author_name(root)
    source_contact = ""

    records: list[dict[str, str]] = []
    for entry in root.findall("atom:entry", XML_NAMESPACES):
        title = first_text(entry, ["atom:title"])
        link = atom_link(entry)
        guid = first_text(entry, ["atom:id"]) or link
        description, content_source_field = first_text_with_source(
            entry,
            ["atom:summary", "atom:content", "content:encoded"],
            strip_tags=True,
            limit=CONTENT_TEXT_LIMIT,
        )
        pub_date = first_text(entry, ["atom:published", "atom:updated"])
        item_author = atom_author_name(entry) or first_text(entry, ["dc:creator"])

        records.append(
            build_record(
                feed_url=feed_url,
                source_type="atom",
                source_title=source_title,
                source_link=source_link,
                source_description=source_description,
                source_author=source_author,
                source_contact=source_contact,
                title=title,
                link=link,
                guid=guid,
                description=description,
                content_source_field=content_source_field,
                pub_date=pub_date,
                item_author=item_author,
            )
        )

    return records


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: fetch_feed_items.py <feed_url>", file=sys.stderr)
        return 1

    url = sys.argv[1]

    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            content_bytes = response.read()
            encoding = response.headers.get_content_charset() or "utf-8"
            content = content_bytes.decode(encoding, errors="replace")

        root = ET.fromstring(content)
        tag = root.tag.split("}", 1)[-1].lower()
        if tag == "feed":
            records = parse_atom(root, url)
        else:
            records = parse_rss(root, url)

        for record in records:
            print(json.dumps(record, ensure_ascii=False))
        return 0
    except urllib.error.HTTPError as e:
        details = ""
        try:
            details = e.read(300).decode("utf-8", errors="replace").strip()
        except Exception:
            pass
        suffix = f": {details}" if details else ""
        print(f"Error fetching {url}: HTTP {e.code}{suffix}", file=sys.stderr)
        if e.code in (401, 403):
            return 11
        if e.code in (429, 503):
            return 12
        return 1
    except urllib.error.URLError as e:
        print(f"Error fetching {url}: URL error: {e.reason}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"Error fetching {url}: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
