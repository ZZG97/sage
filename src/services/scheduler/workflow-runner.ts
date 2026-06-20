import { mkdirSync } from 'fs';
import { resolve } from 'path';
import type {
  DynamicTaskContext,
  WorkflowAgentStep,
  WorkflowStepRunRecord,
  WorkflowTaskPayload,
} from './types';
import { truncateText } from './workflow-normalizer';
import { createWorkflowStepOutputDir, WorkflowShellRunner } from './workflow-shell-runner';

const PREVIEW_CHAR_LIMIT = 1200;

export type WorkflowAgentPromptRunner = (
  prompt: string,
  title?: string,
  context?: DynamicTaskContext,
) => Promise<void>;

export interface WorkflowRunnerOptions {
  runAgentPrompt: WorkflowAgentPromptRunner;
  shellRunner?: WorkflowShellRunner;
  outputRoot?: string;
}

function formatRunTimestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

export function buildWorkflowAgentPrompt(
  taskId: string,
  runDir: string,
  previousResults: WorkflowStepRunRecord[],
  stepPrompt: string,
  workflowTitle?: string,
): string {
  const lines = [
    '[Workflow 上下文]',
    `- taskId: ${taskId}`,
    `- workflowTitle: ${workflowTitle || '(none)'}`,
    `- runDir: ${runDir}`,
    '- 这是 Sage scheduler 自动触发的 workflow。',
    '- 如果前置 shell step 已成功完成，不要重复运行这些 shell 命令；直接复用已有产物。',
    '- 如需详细内容，优先读取上面 runDir 中的文件，而不是重跑准备步骤。',
    '',
    '[前序步骤结果]',
  ];

  if (previousResults.length === 0) {
    lines.push('- (none)');
  } else {
    for (const result of previousResults) {
      lines.push(`- stepId: ${result.stepId}`);
      lines.push(`  kind: ${result.kind}`);
      lines.push(`  durationMs: ${result.durationMs}`);
      if (result.kind === 'shell') {
        if (result.command) lines.push(`  command: ${result.command}`);
        if (result.cwd) lines.push(`  cwd: ${result.cwd}`);
        if (typeof result.exitCode === 'number') lines.push(`  exitCode: ${result.exitCode}`);
        if (typeof result.timedOut === 'boolean') lines.push(`  timedOut: ${String(result.timedOut)}`);
        if (result.stdoutPath) lines.push(`  stdoutPath: ${result.stdoutPath}`);
        if (result.stderrPath) lines.push(`  stderrPath: ${result.stderrPath}`);
      } else {
        if (result.title) lines.push(`  title: ${result.title}`);
        if (result.promptPath) lines.push(`  promptPath: ${result.promptPath}`);
      }
      if (result.preview) {
        lines.push('  preview:');
        for (const previewLine of result.preview.split('\n')) {
          lines.push(`    ${previewLine}`);
        }
      }
    }
  }

  lines.push('');
  lines.push('[当前步骤要求]');
  lines.push(stepPrompt);
  return lines.join('\n');
}

export class WorkflowRunner {
  private shellRunner: WorkflowShellRunner;
  private outputRoot: string;

  constructor(private options: WorkflowRunnerOptions) {
    this.shellRunner = options.shellRunner || new WorkflowShellRunner();
    this.outputRoot = options.outputRoot || resolve(import.meta.dir, '../../../agent_home/workspace/outputs/workflows');
  }

  async run(
    taskId: string,
    workflow: WorkflowTaskPayload,
    workflowTitle?: string,
    context?: DynamicTaskContext,
  ): Promise<void> {
    const runDir = this.createRunDir(taskId);
    const resultsFile = resolve(runDir, 'results.json');
    const results: WorkflowStepRunRecord[] = [];

    await Bun.write(
      resolve(runDir, 'workflow.json'),
      JSON.stringify({ taskId, title: workflowTitle || null, workflow }, null, 2),
    );

    for (let index = 0; index < workflow.steps.length; index++) {
      const step = workflow.steps[index];
      if (step.kind === 'shell') {
        const result = await this.shellRunner.run(step, index, runDir);
        results.push(result);
      } else {
        const result = await this.runAgentStep(taskId, step, index, runDir, results, workflowTitle, context);
        results.push(result);
      }

      await Bun.write(
        resultsFile,
        JSON.stringify(
          {
            taskId,
            title: workflowTitle || null,
            runDir,
            steps: results,
          },
          null,
          2,
        ),
      );
    }
  }

  private async runAgentStep(
    taskId: string,
    step: WorkflowAgentStep,
    index: number,
    runDir: string,
    previousResults: WorkflowStepRunRecord[],
    workflowTitle?: string,
    context?: DynamicTaskContext,
  ): Promise<WorkflowStepRunRecord> {
    const outputDir = createWorkflowStepOutputDir(runDir, index, step.id, step.kind);
    mkdirSync(outputDir, { recursive: true });

    const startedAt = new Date();
    const finalPrompt = buildWorkflowAgentPrompt(taskId, runDir, previousResults, step.prompt, workflowTitle);
    const promptPath = resolve(outputDir, 'prompt.md');
    await Bun.write(promptPath, finalPrompt);

    await this.options.runAgentPrompt(finalPrompt, step.title || workflowTitle || undefined, context);

    const finishedAt = new Date();
    return {
      stepId: step.id || `step_${index + 1}`,
      kind: 'agent',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      outputDir,
      title: step.title || workflowTitle || null,
      promptPath,
      preview: truncateText(step.prompt, PREVIEW_CHAR_LIMIT),
    };
  }

  private createRunDir(taskId: string): string {
    const runDir = resolve(this.outputRoot, taskId, formatRunTimestamp());
    mkdirSync(runDir, { recursive: true });
    return runDir;
  }
}
