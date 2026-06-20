import type { JobOptions } from 'bunqueue/client';
import type { AgentProvider } from '../../agent/types';
import type { Logger } from '../../utils';

export interface AgentTaskRunOptions {
  reuseConversationId?: string;
}

export interface TaskContext {
  agent: AgentProvider;
  logger: Logger;
  /** 主动向 owner 发纯文本消息（由 SageCore 注入），返回 message_id */
  sendMessageToOwner?: (text: string) => Promise<string | void>;
  /** 主动触发一次 agent 任务并以流式卡片发送给 owner（由 SageCore 注入） */
  runAgentTask?: (prompt: string, title?: string, options?: AgentTaskRunOptions) => Promise<void>;
}

/** Handler function for built-in tasks */
export type TaskHandler = (ctx: TaskContext) => Promise<void>;

/** Schedule config for built-in tasks */
export interface BuiltinTaskDef {
  name: string;
  /** Cron pattern, e.g. "0 8 * * *" for daily 8:00 */
  pattern: string;
  handler: TaskHandler;
  /** Allow in dev environment (default false) */
  allowInDev?: boolean;
}

export interface BuiltinTaskSummary {
  name: string;
  pattern: string;
  allowInDev: boolean;
}

export type DynamicTaskKind = 'message' | 'agent' | 'workflow';
export type WorkflowStepKind = 'shell' | 'agent';

export interface WorkflowShellStep {
  id?: string;
  kind: 'shell';
  command: string;
  cwd?: string | null;
  timeoutSec?: number | null;
}

export interface WorkflowAgentStep {
  id?: string;
  kind: 'agent';
  prompt: string;
  title?: string | null;
}

export type WorkflowStep = WorkflowShellStep | WorkflowAgentStep;

export interface WorkflowJobOptions {
  attempts?: number;
  backoff?: number;
}

export interface WorkflowTaskPayload {
  version: 1;
  steps: WorkflowStep[];
  jobOptions?: WorkflowJobOptions;
}

export interface DynamicTaskContext {
  reuseConversationId?: string;
}

export interface DynamicTaskWriteOptions {
  kind?: DynamicTaskKind;
  message: string;
  title?: string;
  payload?: WorkflowTaskPayload;
  context?: DynamicTaskContext;
  reuseConversationId?: string;
  pattern?: string;
  triggerAt?: number;
}

/** A dynamic scheduled task stored in SQLite */
export interface DynamicTask {
  id: string;
  /** message=纯文本提醒；agent=单步 agent；workflow=顺序执行多个 step */
  kind: DynamicTaskKind;
  /** message 文本；agent prompt；workflow 的人类可读摘要 */
  message: string;
  /** agent / workflow 主标题 */
  title: string | null;
  /** workflow 结构化定义 */
  payload: WorkflowTaskPayload | null;
  /** Optional runtime context for agent/workflow execution */
  context: DynamicTaskContext | null;
  /** Cron pattern (recurring) OR null for one-shot */
  pattern: string | null;
  /** Epoch ms for one-shot trigger time */
  trigger_at: number | null;
  /** active / completed / cancelled */
  status: string;
  created_at: number;
}

export interface RawDynamicTask extends Omit<DynamicTask, 'payload' | 'context'> {
  payload: string | null;
  context_json: string | null;
}

/** Job data flowing through bunqueue */
export interface TaskJobData {
  type: 'builtin' | 'dynamic';
  /** For builtin: task name; for dynamic: task id */
  task_id: string;
  /** For dynamic: kind */
  kind?: DynamicTaskKind;
  /** For dynamic: text/prompt/summary */
  message?: string;
  /** For dynamic agent/workflow: proactive topic text */
  title?: string;
  /** For workflow: serialized payload */
  payload?: string;
  /** Serialized DynamicTaskContext */
  context?: string;
}

export interface WorkflowStepRunRecord {
  stepId: string;
  kind: WorkflowStepKind;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outputDir: string;
  title?: string | null;
  command?: string;
  cwd?: string;
  timeoutSec?: number;
  exitCode?: number;
  timedOut?: boolean;
  stdoutPath?: string;
  stderrPath?: string;
  promptPath?: string;
  preview?: string;
}

export interface SchedulerQueue {
  setStallConfig?: (config: { enabled: boolean }) => void;
  add: (name: string, data: TaskJobData, opts?: JobOptions) => Promise<unknown>;
  upsertJobScheduler: (
    id: string,
    repeatOptions: { pattern: string; timezone: string },
    job: { name: string; data: TaskJobData; opts?: JobOptions },
  ) => Promise<unknown>;
  removeJobScheduler: (id: string) => Promise<unknown>;
  removeAsync: (id: string) => Promise<unknown>;
  close: () => void;
}
