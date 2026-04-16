// 定时任务：同步 Claude Code / Codex 系统提示文件
import { resolve } from 'path';
import type { TaskContext } from '../task-scheduler';

async function streamToText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  return await new Response(stream).text();
}

export async function syncSystemPrompts(ctx: TaskContext): Promise<void> {
  const repoRoot = resolve(import.meta.dir, '../../..');
  const agentHome = resolve(repoRoot, 'agent_home');
  const scriptPath = resolve(agentHome, 'scripts/render_agents.py');

  const proc = Bun.spawn(['python3', scriptPath], {
    cwd: agentHome,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    streamToText(proc.stdout),
    streamToText(proc.stderr),
    proc.exited,
  ]);

  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');

  if (exitCode !== 0) {
    const message = `系统提示同步失败(exit=${exitCode})${output ? `:\n${output}` : ''}`;
    ctx.logger.error(message);
    if (ctx.sendMessageToOwner) {
      await ctx.sendMessageToOwner(`⚠️ ${message}`);
    }
    throw new Error(message);
  }

  if (output.includes('updated ')) {
    ctx.logger.info(`系统提示已同步:\n${output}`);
    return;
  }

  ctx.logger.info(`系统提示无需同步: ${output.replace(/\n/g, '; ')}`);
}
