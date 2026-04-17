#!/bin/bash
# fetch_and_dedup.sh
# Fetches RSS feeds, deduplicates against history, outputs new items to a single pending file.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$SKILL_DIR/data"
PENDING_DIR="$DATA_DIR/pending"
PUSHED_CSV="$DATA_DIR/pushed.csv"
LOCK_DIR="$DATA_DIR/.rss_reader.lock"

cleanup() {
    if [[ -d "$LOCK_DIR" ]]; then
        rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
}
trap cleanup EXIT

mkdir -p "$PENDING_DIR" "$DATA_DIR"

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

# Output file for this run (timestamped, returned to caller)
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUTPUT_FILE="$PENDING_DIR/items_${TIMESTAMP}.jsonl"
TEMP_FILE="$PENDING_DIR/temp_${TIMESTAMP}.jsonl"

> "$TEMP_FILE"

total_feeds=0
successful_feeds=0
failed_feeds=0

# Process each feed
while IFS= read -r line; do
    # Skip comments and empty lines
    [[ "$line" =~ ^# ]] && continue
    [[ -z "$line" ]] && continue

    URL=$(echo "$line" | sed 's/#.*//' | tr -d ' ')
    [[ -z "$URL" ]] && continue

    ((total_feeds += 1))
    echo "Fetching: $URL" >&2

    # Fetch RSS and parse with Python
    python3 - "$URL" "$TEMP_FILE" << 'PYEOF'
import sys
import xml.etree.ElementTree as ET
import re
import html
import json

url = sys.argv[1]
output_file = sys.argv[2]

try:
    import urllib.request
    with urllib.request.urlopen(url, timeout=30) as response:
        content_bytes = response.read()
        encoding = response.headers.get_content_charset() or "utf-8"
        content = content_bytes.decode(encoding, errors='replace')

    root = ET.fromstring(content)
    channel = root.find('channel')
    if channel is None:
        sys.exit(0)

    with open(output_file, 'a', encoding='utf-8') as out:
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
            out.write(json.dumps(record, ensure_ascii=False) + '\n')

except Exception as e:
    print(f"Error fetching {url}: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF
    if [[ $? -eq 0 ]]; then
        ((successful_feeds += 1))
    else
        ((failed_feeds += 1))
    fi

done < "$FEEDS_FILE"

if [[ "$total_feeds" -gt 0 && "$successful_feeds" -eq 0 && "$failed_feeds" -gt 0 ]]; then
    echo "ERROR: All feed fetches failed ($failed_feeds/$total_feeds)" >&2
    exit 2
fi

# Deduplicate and write final output
python3 - "$TEMP_FILE" "$OUTPUT_FILE" "$PUSHED_CSV" << 'PYEOF'
import csv
import json
import sys
import os

temp_file = sys.argv[1]
output_file = sys.argv[2]
pushed_csv = sys.argv[3]

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
with open(temp_file, 'r', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
            guid = item.get('guid', '')
            if guid and guid not in pushed_guids:
                new_items.append(item)
                pushed_guids.add(guid)
        except json.JSONDecodeError:
            continue

# Write new items
with open(output_file, 'w', encoding='utf-8') as f:
    for item in new_items:
        f.write(json.dumps(item, ensure_ascii=False) + '\n')

print(f"New items after dedup: {len(new_items)}", file=sys.stderr)

# Update pushed.csv
with open(pushed_csv, 'a', encoding='utf-8') as f:
    writer = csv.writer(f)
    for item in new_items:
        writer.writerow([item['guid'], item['title'][:100], item['feed_url'], ''])

# Cleanup temp
os.remove(temp_file)

print(f"DONE: {len(new_items)} new items -> {output_file}", file=sys.stderr)
PYEOF

dedup_rc=$?
if [[ $dedup_rc -ne 0 ]]; then
    echo "ERROR: Deduplicate step failed" >&2
    exit $dedup_rc
fi

echo "FETCH_SUMMARY: total=$total_feeds ok=$successful_feeds failed=$failed_feeds" >&2

# Print the output file path so caller can pick it up
echo "$OUTPUT_FILE"
