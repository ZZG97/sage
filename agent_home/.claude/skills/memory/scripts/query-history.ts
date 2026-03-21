// 查询对话历史 — 供 memory skill 使用
// 用法:
//   bun agent_home/.claude/skills/memory/scripts/query-history.ts --date today
//   bun agent_home/.claude/skills/memory/scripts/query-history.ts --date 2026-03-21
//   bun agent_home/.claude/skills/memory/scripts/query-history.ts --recent 7
//   bun agent_home/.claude/skills/memory/scripts/query-history.ts --session <id_or_prefix>
import { HistoryStore } from '@sage/services/history-store';
import { parseArgs } from 'util';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    date: { type: 'string' },
    recent: { type: 'string' },
    session: { type: 'string' },
    env: { type: 'string' },
  },
  strict: true,
});

// 与 Sage 服务保持一致的 env 推导
const env = values.env ?? (process.env.NODE_ENV === 'development' ? 'dev' : 'production');
const store = new HistoryStore(undefined, env);

// 本地日期（避免 UTC 跨天问题）
function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

if (values.session) {
  // 按 session_id 查询（支持前缀匹配）
  const sessionId = values.session;
  const events = store.getSessionEvents(sessionId);
  if (events.length > 0) {
    console.log(JSON.stringify(events, null, 2));
  } else {
    // 尝试前缀匹配
    const matched = store.findSessionsByPrefix(sessionId);
    if (matched.length === 0) {
      console.error(`未找到 session: ${sessionId}`);
      process.exit(1);
    } else if (matched.length === 1) {
      const events = store.getSessionEvents(matched[0].id);
      console.log(JSON.stringify({ session: matched[0], events }, null, 2));
    } else {
      console.log(`匹配到 ${matched.length} 个 session:`);
      console.log(JSON.stringify(matched, null, 2));
    }
  }
} else if (values.date) {
  const date = values.date === 'today' ? localDate() : values.date;
  const sessions = store.getSessionsForDate(date);
  console.log(JSON.stringify(sessions, null, 2));
} else if (values.recent) {
  const days = parseInt(values.recent, 10);
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days + 1);
  const sessions = store.getSessionsByDateRange(localDate(start), localDate(end));
  console.log(JSON.stringify(sessions, null, 2));
} else {
  console.error('用法: --date YYYY-MM-DD | --date today | --recent N | --session <id_or_prefix>');
  process.exit(1);
}

store.destroy();
