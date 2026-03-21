// 查询对话历史 — 供 skill 使用
// 用法: bun agent_home/.claude/skills/summarize-journal/scripts/query-history.ts --date 2026-03-21
//       bun agent_home/.claude/skills/summarize-journal/scripts/query-history.ts --recent 7
import { HistoryStore } from '@sage/services/history-store';
import { parseArgs } from 'util';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    date: { type: 'string' },
    recent: { type: 'string' },
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

if (values.date) {
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
  console.error('用法: --date YYYY-MM-DD | --date today | --recent N');
  process.exit(1);
}

store.destroy();
