#!/bin/bash
# 小克环境一键配置脚本
# 适用于 macOS / Linux

set -e

echo "=== 1. 安装 Claude Code ==="
if command -v claude &>/dev/null; then
  echo "Claude Code 已安装，跳过"
else
  npm install -g @anthropic-ai/claude-code
fi

echo "=== 2. 添加 Playwright MCP（项目级） ==="
claude mcp add -s project playwright -- npx @playwright/mcp@latest --cdp-endpoint http://localhost:9222

echo "=== 3. 安装 Playwright 浏览器 ==="
npx playwright install --with-deps chrome

echo ""
echo "=== 搞定！==="
echo "启动: cd <repo-root>/agent_home && claude"
echo ""
echo "使用前先启动 Chrome（带登录态）:"
echo "  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir=\$HOME/.chrome-debug-profile"
