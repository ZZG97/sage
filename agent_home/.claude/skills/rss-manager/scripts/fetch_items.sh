#!/bin/bash
# fetch_items.sh
# Fetches RSS feeds, deduplicates against history, splits into batches, writes chunk files.
# Single entry point for the RSS reader skill.
#
# Output: absolute chunk file paths to stdout, one per line
#
# Exit codes:
#   0 - success (may output nothing if no new items)
#   1 - no feeds file found
#   2 - all feed fetches failed
#   3 - another run is in progress

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$SKILL_DIR/data"
CHUNKS_DIR="$DATA_DIR/chunks"
PUSHED_CSV="$DATA_DIR/pushed.csv"
BATCH_SIZE=10
LOCK_DIR="$DATA_DIR/.rss_reader.lock"
TEMP_FILE=""

cleanup() {
    if [[ -n "${TEMP_FILE:-}" && -f "$TEMP_FILE" ]]; then
        rm -f "$TEMP_FILE"
    fi
    if [[ -d "$LOCK_DIR" ]]; then
        rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
}
trap cleanup EXIT

mkdir -p "$DATA_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "ERROR: Another RSS reader run is in progress" >&2
    exit 3
fi

# Find feeds file (txt only)
if [[ -f "$HOME/.rsshub/feeds.txt" ]]; then
    FEEDS_FILE="$HOME/.rsshub/feeds.txt"
elif [[ -f "$SKILL_DIR/feeds.txt" ]]; then
    FEEDS_FILE="$SKILL_DIR/feeds.txt"
else
    echo "ERROR: No feeds file found (expected ~/.rsshub/feeds.txt or $SKILL_DIR/feeds.txt)" >&2
    exit 1
fi

# Initialize pushed.csv if not exists
if [[ ! -f "$PUSHED_CSV" ]]; then
    echo "guid,title,feed_url,pushed_at" > "$PUSHED_CSV"
fi

# Clean and prepare chunks dir
mkdir -p "$CHUNKS_DIR"
rm -f "$CHUNKS_DIR"/chunk_*.jsonl

# Build Python script for fetching
FETCH_SCRIPT=$(cat << 'PYEOF'
import sys
import xml.etree.ElementTree as ET
import re
import html
import json
import urllib.request

url = sys.argv[1]

try:
    with urllib.request.urlopen(url, timeout=30) as response:
        content_bytes = response.read()
        encoding = response.headers.get_content_charset() or "utf-8"
        content = content_bytes.decode(encoding, errors='replace')

    root = ET.fromstring(content)
    channel = root.find('channel')
    if channel is None:
        sys.exit(0)

    for item in channel.findall('item'):
        title_elem = item.find('title')
        link_elem = item.find('link')
        guid_elem = item.find('guid')
        desc_elem = item.find('description')
        pubdate_elem = item.find('pubDate')

        title = html.unescape(title_elem.text.strip()) if title_elem is not None and title_elem.text else ""
        link = link_elem.text.strip() if link_elem is not None and link_elem.text else ""
        guid = guid_elem.text.strip() if guid_elem is not None and guid_elem.text else link
        pubdate = pubdate_elem.text if pubdate_elem is not None and pubdate_elem.text else ""

        desc_text = ""
        if desc_elem is not None and desc_elem.text:
            desc_text = re.sub(r'<[^>]+>', '', desc_elem.text)
            desc_text = html.unescape(desc_text.strip())[:500]

        if not guid:
            guid = f"{title[:50]}_{pubdate}"

        record = {
            "title": title,
            "link": link,
            "guid": guid,
            "description": desc_text,
            "pubDate": pubdate,
            "feed_url": url
        }
        print(json.dumps(record, ensure_ascii=False))
except Exception as e:
    print(f"Error fetching {url}: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF
)

# Fetch all feeds into temp file
TEMP_FILE=$(mktemp)
> "$TEMP_FILE"

total_feeds=0
successful_feeds=0
failed_feeds=0

while IFS= read -r line; do
    [[ "$line" =~ ^# ]] && continue
    [[ -z "$line" ]] && continue

    URL=$(echo "$line" | sed 's/#.*//' | tr -d ' ')
    [[ -z "$URL" ]] && continue

    ((total_feeds += 1))
    echo "Fetching: $URL" >&2
    if python3 -c "$FETCH_SCRIPT" "$URL" >> "$TEMP_FILE"; then
        ((successful_feeds += 1))
    else
        ((failed_feeds += 1))
    fi
done < "$FEEDS_FILE"

if [[ "$total_feeds" -gt 0 && "$successful_feeds" -eq 0 && "$failed_feeds" -gt 0 ]]; then
    echo "ERROR: All feed fetches failed ($failed_feeds/$total_feeds)" >&2
    exit 2
fi

# Deduplicate and write chunks
python3 - "$TEMP_FILE" "$PUSHED_CSV" "$CHUNKS_DIR" "$BATCH_SIZE" << 'PYEOF'
import csv
import json
import sys
import os

temp_file = sys.argv[1]
pushed_csv = sys.argv[2]
chunks_dir = sys.argv[3]
batch_size = int(sys.argv[4])

# Load pushed guids
pushed_guids = set()
try:
    with open(pushed_csv, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            pushed_guids.add(row['guid'])
except FileNotFoundError:
    pass

new_items = []
seen_guids = set()

with open(temp_file, 'r', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
            guid = item.get('guid', '')
            if guid and guid not in pushed_guids and guid not in seen_guids:
                new_items.append(item)
                seen_guids.add(guid)
                pushed_guids.add(guid)
        except json.JSONDecodeError:
            continue

os.remove(temp_file)

# Update pushed.csv
with open(pushed_csv, 'a', encoding='utf-8') as f:
    writer = csv.writer(f)
    for item in new_items:
        writer.writerow([item['guid'], item['title'][:100], item['feed_url'], ''])

# Write chunk files
chunk_files = []
for i in range(0, len(new_items), batch_size):
    chunk = new_items[i:i + batch_size]
    chunk_num = (i // batch_size) + 1
    chunk_file = f"{chunks_dir}/chunk_{chunk_num:03d}.jsonl"

    with open(chunk_file, 'w', encoding='utf-8') as f:
        for item in chunk:
            f.write(json.dumps(item, ensure_ascii=False) + '\n')

    chunk_files.append(chunk_file)

# Output chunk file paths to stdout
for cf in chunk_files:
    print(cf)

print(f"SUMMARY: new_items={len(new_items)} chunks={len(chunk_files)}", file=sys.stderr)
PYEOF

dedup_rc=$?
if [[ $dedup_rc -ne 0 ]]; then
    echo "ERROR: Deduplicate/chunk step failed" >&2
    exit $dedup_rc
fi

echo "FETCH_SUMMARY: total=$total_feeds ok=$successful_feeds failed=$failed_feeds" >&2
