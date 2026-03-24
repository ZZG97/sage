#!/bin/bash
# PreToolUse hook: Block dangerous bash commands
# Exit 0 = allow, Exit 2 = block (Claude cannot bypass)
set -euo pipefail

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

if [ -z "$command" ]; then
  exit 0
fi

# Dangerous patterns — add more as needed
PATTERNS=(
  'rm -rf /'
  'rm -fr /'
  'rm -rf ~'
  'rm -rf \*'
  'mkfs\.'
  'dd if='
  '> /dev/sd'
  '> /dev/disk'
  ':(){:|:&};:'
  'chmod -R 777 /'
  'sudo rm'
)

for pattern in "${PATTERNS[@]}"; do
  if [[ "$command" == *"$pattern"* ]]; then
    echo "{\"hookSpecificOutput\":{\"permissionDecision\":\"deny\"},\"systemMessage\":\"BLOCKED: dangerous pattern detected: $pattern\"}" >&2
    exit 2
  fi
done

exit 0
