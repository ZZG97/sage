import type { MessageContext } from '../types';

export type SlashCommandResult =
  | { kind: 'reply'; text: string }
  | { kind: 'async' }
  | null;

export interface SlashThreadInfo {
  threadId?: string;
  messageId: string;
  conversationId: string | null;
  agentProvider: string;
  agentSessionId?: string | null;
  creatorOpenId?: string | null;
  lastActiveAt?: string | null;
}

export interface SlashRuntimeStatus {
  agentProvider: string;
  isRunning: boolean;
  sessionCount: number;
  activeRunCount: number;
  isDraining: boolean;
}

export interface SlashProviderInfo {
  activeProvider: string;
  availableProviders: string[];
  autoFallbackEnabled: boolean;
  isFallback: boolean;
}

export interface SlashRestartPolicyContext {
  ownerOpenId?: string;
  isDevProcess: boolean;
}

export type SlashRestartRejectReason =
  | 'non-owner'
  | 'dev-non-p2p'
  | 'prod-owner-missing';

export interface SlashCommandRuntime {
  getThreadInfo(ctx: MessageContext): SlashThreadInfo;
  clearCurrentContext(ctx: MessageContext): boolean;
  stopActiveRun(ctx: MessageContext): boolean;
  getStatus(): SlashRuntimeStatus;
  getProviderInfo(): SlashProviderInfo;
  setAutoFallback(enabled: boolean): void;
  switchProvider(name: string): boolean;
  getRestartPolicyContext(): SlashRestartPolicyContext;
  recordRestartRejected(reason: SlashRestartRejectReason, ctx: MessageContext): void;
  restart(ctx: MessageContext): void;
}

export const RESTART_COMPLETE_TEXT = '✅ 服务即将重启，请稍后发送消息继续。';
export const RESTART_INTERRUPTED_TEXT = '⚠️ 服务正在重启，当前对话已中断。请重新发送消息继续。';

export function buildRestartStartText(activeRunCount: number): string {
  return `🔄 正在优雅重启...\n活跃任务: ${activeRunCount}，等待处理完成后重启。`;
}

export function getRestartExecutorCommand(processName: string): string {
  return processName === 'sage-dev'
    ? 'bun run dev:restart'
    : 'bun run prod:restart';
}

export function handleSlashCommand(
  ctx: MessageContext,
  runtime: SlashCommandRuntime,
): SlashCommandResult {
  const text = ctx.text.trim();

  if (text === '/thread_id') return reply(cmdThreadId(ctx, runtime));
  if (text === '/clear') return reply(cmdClear(ctx, runtime));
  if (text === '/stop') return reply(cmdStop(ctx, runtime));
  if (text === '/help') return reply(cmdHelp(runtime));
  if (text === '/status') return reply(cmdStatus(runtime));
  if (text.startsWith('/fallback')) return reply(cmdFallback(text, runtime));
  if (text.startsWith('/provider')) return reply(cmdProvider(text, runtime));
  if (text === '/restart') {
    const access = getRestartAccessDecision(ctx, runtime);
    if (!access.allowed) return reply(access.message);
    runtime.restart(ctx);
    return { kind: 'async' };
  }

  return null;
}

function reply(text: string): SlashCommandResult {
  return { kind: 'reply', text };
}

function cmdThreadId(ctx: MessageContext, runtime: SlashCommandRuntime): string {
  const info = runtime.getThreadInfo(ctx);

  if (info.threadId) {
    return [
      `Thread ID: ${info.threadId}`,
      `Conversation ID: ${info.conversationId || '未创建'}`,
      `Agent Provider: ${info.agentProvider}`,
      `Session: ${info.agentSessionId || '未创建'}`,
      `创建者: ${info.creatorOpenId || 'N/A'}`,
      `最后活跃: ${info.lastActiveAt || 'N/A'}`,
    ].join('\n');
  }

  return `当前不在话题中。消息 ID: ${info.messageId}`;
}

function cmdClear(ctx: MessageContext, runtime: SlashCommandRuntime): string {
  if (runtime.clearCurrentContext(ctx)) {
    return '已清空当前话题的上下文。下一条消息将开启新的对话。';
  }
  return '当前话题没有活跃的上下文。';
}

function cmdStop(ctx: MessageContext, runtime: SlashCommandRuntime): string {
  if (runtime.stopActiveRun(ctx)) {
    return '⏹ 已中断当前任务';
  }
  return '当前话题没有正在执行的任务。';
}

function cmdHelp(runtime: SlashCommandRuntime): string {
  return [
    '可用命令:',
    '',
    '/thread_id - 查看当前话题 ID 和会话信息',
    '/clear - 清空当前话题的上下文',
    '/stop - 中断当前话题正在执行的任务',
    '/status - 查看服务状态',
    '/fallback [on|off] - 查看/切换自动降级开关',
    '/provider [name] - 查看/切换活跃 provider',
    '/restart - 优雅重启服务（需 OWNER_OPEN_ID owner；dev 未配置时仅私聊可用）',
    '/help - 显示此帮助信息',
    '',
    '使用说明:',
    `• 当前 Agent: ${runtime.getStatus().agentProvider}`,
    '• 每条新消息会创建独立的话题上下文',
    '• 在话题中回复的消息共享同一上下文',
    '• 不同话题之间完全隔离',
  ].join('\n');
}

function cmdStatus(runtime: SlashCommandRuntime): string {
  const status = runtime.getStatus();
  const provider = runtime.getProviderInfo();
  const lines = [
    `Agent: ${status.agentProvider}`,
    `运行中: ${status.isRunning ? '是' : '否'}`,
    `活跃会话: ${status.sessionCount}`,
    `活跃任务: ${status.activeRunCount}`,
  ];
  if (provider.isFallback) {
    lines.push(`自动降级: ${provider.autoFallbackEnabled ? '开启' : '关闭'}`);
    lines.push(`当前活跃: ${provider.activeProvider}`);
  }
  if (status.isDraining) lines.push('⚠️ 服务正在关闭中 (drain)');
  return lines.join('\n');
}

function cmdFallback(text: string, runtime: SlashCommandRuntime): string {
  const provider = runtime.getProviderInfo();
  if (!provider.isFallback) {
    return '当前未配置 fallback provider，无法切换。';
  }

  const arg = text.replace('/fallback', '').trim().toLowerCase();
  if (!arg) {
    return `自动降级: ${provider.autoFallbackEnabled ? '✅ 开启' : '❌ 关闭'}\n用法: /fallback on|off`;
  }

  if (arg === 'on') {
    runtime.setAutoFallback(true);
    return '✅ 自动降级已开启';
  }
  if (arg === 'off') {
    runtime.setAutoFallback(false);
    return '❌ 自动降级已关闭';
  }

  return `无效参数: ${arg}\n用法: /fallback on|off`;
}

function cmdProvider(text: string, runtime: SlashCommandRuntime): string {
  const provider = runtime.getProviderInfo();
  if (!provider.isFallback) {
    return `当前 provider: ${provider.activeProvider}\n仅配置了单个 provider，无法切换。`;
  }

  const arg = text.replace('/provider', '').trim();
  if (!arg) {
    const lines = [
      `当前活跃: ${provider.activeProvider}`,
      `可用 providers:`,
      ...provider.availableProviders.map(p => `  ${p === provider.activeProvider ? '→' : ' '} ${p}`),
      '',
      '用法: /provider <name>',
    ];
    return lines.join('\n');
  }

  if (runtime.switchProvider(arg)) {
    return `✅ 已切换到 ${arg}（新会话生效，已有会话不受影响）`;
  }

  return `未知 provider: ${arg}\n可用: ${provider.availableProviders.join(', ')}`;
}

function getRestartAccessDecision(
  ctx: MessageContext,
  runtime: SlashCommandRuntime,
): { allowed: true } | { allowed: false; message: string } {
  const policy = runtime.getRestartPolicyContext();

  if (policy.ownerOpenId) {
    if (ctx.openId === policy.ownerOpenId) return { allowed: true };
    runtime.recordRestartRejected('non-owner', ctx);
    return {
      allowed: false,
      message: '⛔ /restart 已拒绝：只有 OWNER_OPEN_ID 配置的 owner 可以重启服务。',
    };
  }

  if (policy.isDevProcess) {
    if (ctx.chatType === 'p2p') return { allowed: true };
    runtime.recordRestartRejected('dev-non-p2p', ctx);
    return {
      allowed: false,
      message: '⛔ /restart 已拒绝：dev 未配置 OWNER_OPEN_ID 时，仅允许私聊触发重启。',
    };
  }

  runtime.recordRestartRejected('prod-owner-missing', ctx);
  return {
    allowed: false,
    message: '⛔ /restart 已禁用：生产环境必须配置 OWNER_OPEN_ID，且只能由 owner 执行。',
  };
}
