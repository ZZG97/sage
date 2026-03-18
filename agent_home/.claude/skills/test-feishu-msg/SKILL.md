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

### 2. Start Sage Dev Service

**Always use pm2 to manage the `sage-dev` instance. NEVER start a raw `bun` process or kill processes by port/pid — that risks killing the prod `sage` instance.**

```bash
cd /Users/zhangzhiguo/workspace/sage && pm2 restart sage-dev
```

Wait 3s, then verify startup:

```bash
tail -20 /Users/zhangzhiguo/workspace/sage/logs/sage-dev.log
```

Look for "启动成功". If `sage-dev` is not in pm2 list yet, start it first:

```bash
cd /Users/zhangzhiguo/workspace/sage && pm2 start ecosystem.config.cjs --only sage-dev
```

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
grep -i "keyword" /Users/zhangzhiguo/workspace/sage/logs/sage-dev.log
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

Leave `sage-dev` running via pm2 — do NOT kill it manually. If you need to stop it:

```bash
pm2 stop sage-dev
```

**NEVER use `kill` with grep patterns like `bun.*src/index.ts` — this will also kill the prod `sage` instance.**

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

### Dev vs Prod Separation
- **sage** (prod): port 3000, `.env`, managed by pm2, logs at `logs/sage.log`
- **sage-dev** (dev): port 3001, `.env.dev`, managed by pm2, logs at `logs/sage-dev.log`
- **ALWAYS** use `pm2 restart sage-dev` for testing — never start a raw bun process
- **NEVER** kill processes by grep pattern (`bun.*src/index.ts`) or by port (`lsof -i :3000 | kill`) — this will take down prod
- If port 3001 is already in use, that IS sage-dev — just `pm2 restart sage-dev`

### Debugging
- Check dev logs: `tail -f /Users/zhangzhiguo/workspace/sage/logs/sage-dev.log`
- Use `grep -i "keyword" /Users/zhangzhiguo/workspace/sage/logs/sage-dev.log` to check specific behaviors
- Feishu page title shows unread count: "飞书 (N)" means N new messages arrived

### Screenshots & Temp Files
- **Never** save to repo root or anywhere that pollutes git
- Always save to: `agent_home/workspace/outputs/screenshots/`
