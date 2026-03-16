---
name: test-feishu-msg
description: >
  End-to-end test for Feishu messaging features. Use after modifying message-related code in Sage
  (feishu.ts, core.ts, or agent providers). Launches Chrome + Sage service, sends a test message
  via Feishu Web, verifies server logs and UI response. Also use when user says "test feishu",
  "test message", "test owl", "run feishu test", or "验证飞书消息".
user_invocable: true
---

# Test Feishu Message

End-to-end smoke test: modify code → start service → send message in Feishu → verify logs + UI.

## Prerequisites

- Chrome debug profile at `~/chrome-debug-profile` with Feishu login session
- Sage project at `/Users/zhangzhiguo/workspace/sage`
- Playwright MCP server available

## Execution Steps

### 1. Start Chrome (if not running)

Check port 9222 first. Only launch if not already running.

```bash
lsof -i :9222 2>/dev/null | head -1
```

If not running:
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=$HOME/chrome-debug-profile &>/dev/null &
```

Wait 2s, verify port 9222 is listening.

### 2. Start Sage Service

**Always redirect logs to file** — background processes lose stdout otherwise.

```bash
cd /Users/zhangzhiguo/workspace/sage
bun run src/index.ts > /tmp/sage.log 2>&1 &
```

Wait 3s, verify process is running and log shows "启动成功".

### 3. Open Feishu & Navigate to OWL

```js
await page.goto('https://www.feishu.cn/messenger/');
```

Then find and click the OWL bot conversation in the sidebar. Look for text "OWL" with "机器人" label.

### 4. Send Test Message

**CRITICAL: Feishu input is contenteditable div. Never use `fill()`. Always use `keyboard.type()`.**

```js
async (page) => {
  const editor = page.locator('[contenteditable="true"]').last();
  await editor.click();
  await page.keyboard.type('your test message here');
  await page.keyboard.press('Enter');
}
```

### 5. Verify Server Logs

Wait 5-10s for processing, then check logs:

```bash
grep -i "keyword" /tmp/sage.log
```

Look for:
- Message received log (消息事件)
- Expected behavior logs (e.g., "表情回复已添加")
- Any ERROR lines

### 6. Verify UI

Take screenshot to `agent_home/workspace/outputs/screenshots/`:

```js
await page.screenshot({
  path: '/Users/zhangzhiguo/workspace/sage/agent_home/workspace/outputs/screenshots/test-result.png'
});
```

Or use `mcp__playwright__browser_take_screenshot` with absolute path in filename.

### 7. Cleanup

```bash
kill $(ps aux | grep "bun.*src/index.ts" | grep -v grep | awk '{print $2}')
```

## Lessons Learned

These are hard-won insights — do NOT skip them.

### Feishu Web Input
- The input box is a `contenteditable` div, not an `<input>` or `<textarea>`
- `fill()` and `type()` with `slowly: true` both timeout on it
- Correct approach: `editor.click()` then `page.keyboard.type(text)` then `page.keyboard.press('Enter')`
- If snapshot is too large (>80k chars), use `browser_run_code` instead of `browser_snapshot`

### Feishu API Permissions
- **Before using any new Feishu API**, check if the required permission scope is enabled
- Permission errors show clearly in logs: "Access denied. One of the following scopes is required: [...]"
- Fix at: 飞书开放平台 → 应用 → 权限管理 → 搜索权限名 → 开通
- Common permissions needed:
  - `im:message` — send/receive messages
  - `im:message.reactions:write_only` — add emoji reactions

### Debugging
- Always redirect service logs: `> /tmp/sage.log 2>&1`
- Use `grep -i "keyword" /tmp/sage.log` to check specific behaviors
- Feishu page title shows unread count: "飞书 (N)" means N new messages arrived

### Screenshots & Temp Files
- **Never** save to repo root or anywhere that pollutes git
- Always save to: `agent_home/workspace/outputs/screenshots/`
