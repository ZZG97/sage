#!/usr/bin/env python3
"""
Split a specific pending RSS items file into batches for subagent analysis.
Usage: split_items.py <pending_file>
"""
import json
import sys
import os
from pathlib import Path

BATCH_SIZE = 10
SCRIPT_DIR = Path(__file__).parent.resolve()
SKILL_DIR = SCRIPT_DIR.parent
BATCHES_DIR = SKILL_DIR / "data" / "batches"


def split_file(input_path: Path):
    """Read items from a single pending file and split into batches."""
    items = []
    with open(input_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                items.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    if not items:
        print("No items to process")
        return 0

    BATCHES_DIR.mkdir(parents=True, exist_ok=True)

    # Clear old batches
    for f in BATCHES_DIR.glob("batch_*.jsonl"):
        f.unlink()

    batch_files = []
    for i in range(0, len(items), BATCH_SIZE):
        batch = items[i:i + BATCH_SIZE]
        batch_num = (i // BATCH_SIZE) + 1
        batch_file = BATCHES_DIR / f"batch_{batch_num:03d}.jsonl"

        with open(batch_file, 'w', encoding='utf-8') as f:
            for item in batch:
                f.write(json.dumps(item, ensure_ascii=False) + '\n')

        batch_files.append(batch_file)
        print(f"Created {batch_file.name} with {len(batch)} items")

    return len(items)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: split_items.py <pending_file.jsonl>")
        sys.exit(1)

    input_path = Path(sys.argv[1])
    if not input_path.exists():
        print(f"File not found: {input_path}")
        sys.exit(1)

    total = split_file(input_path)
    print(f"Total: {total} items split into {(total + BATCH_SIZE - 1) // BATCH_SIZE} batches")
    print(f"BATCH_FILES: {' '.join(str(f) for f in BATCHES_DIR.glob('batch_*.jsonl'))}")