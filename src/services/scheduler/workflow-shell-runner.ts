import { mkdirSync } from 'fs';
import { resolve } from 'path';
import type { WorkflowShellStep, WorkflowStepKind, WorkflowStepRunRecord } from './types';

const DEFAULT_SHELL_TIMEOUT_SEC = 60 * 60;
const PREVIEW_CHAR_LIMIT = 1200;

async function streamToText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  return await new Response(stream).text();
}

function expandHomeDir(input?: string | null): string | undefined {
  if (!input) return undefined;
  if (input.startsWith('~')) {
    return input.replace('~', process.env.HOME || '');
  }
  return input;
}

function tailText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `...(${text.length - maxChars} chars omitted)\n${text.slice(-maxChars)}`;
}

function sanitizePathSegment(input: string): string {
  const cleaned = input
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || 'step';
}

export function createWorkflowStepOutputDir(
  runDir: string,
  index: number,
  stepId: string | undefined,
  stepKind: WorkflowStepKind,
): string {
  return resolve(runDir, `${String(index + 1).padStart(2, '0')}-${sanitizePathSegment(stepId || stepKind)}`);
}

export class WorkflowShellRunner {
  async run(step: WorkflowShellStep, index: number, runDir: string): Promise<WorkflowStepRunRecord> {
    const outputDir = createWorkflowStepOutputDir(runDir, index, step.id, step.kind);
    mkdirSync(outputDir, { recursive: true });

    const startedAt = new Date();
    const cwd = this.resolveStepCwd(step.cwd);
    const timeoutSec = step.timeoutSec || DEFAULT_SHELL_TIMEOUT_SEC;
    const timeoutMs = timeoutSec * 1000;

    const proc = Bun.spawn(['/bin/zsh', '-lc', step.command], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      streamToText(proc.stdout),
      streamToText(proc.stderr),
      proc.exited,
    ]);
    clearTimeout(timeoutHandle);

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const stdoutPath = resolve(outputDir, 'stdout.txt');
    const stderrPath = resolve(outputDir, 'stderr.txt');
    const metaPath = resolve(outputDir, 'meta.json');

    await Promise.all([
      Bun.write(stdoutPath, stdout),
      Bun.write(stderrPath, stderr),
      Bun.write(
        metaPath,
        JSON.stringify(
          {
            stepId: step.id,
            kind: step.kind,
            command: step.command,
            cwd,
            timeoutSec,
            exitCode,
            timedOut,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs,
          },
          null,
          2,
        ),
      ),
    ]);

    const previewParts = [
      stdout.trim() ? `stdout (tail):\n${tailText(stdout.trim(), PREVIEW_CHAR_LIMIT)}` : '',
      stderr.trim() ? `stderr (tail):\n${tailText(stderr.trim(), PREVIEW_CHAR_LIMIT)}` : '',
    ].filter(Boolean);

    const result: WorkflowStepRunRecord = {
      stepId: step.id || `step_${index + 1}`,
      kind: 'shell',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      outputDir,
      command: step.command,
      cwd,
      timeoutSec,
      exitCode,
      timedOut,
      stdoutPath,
      stderrPath,
      preview: previewParts.join('\n\n'),
    };

    if (timedOut || exitCode !== 0) {
      const reason = timedOut
        ? `超时 (${timeoutSec}s)`
        : `exit=${exitCode}`;
      throw new Error(
        `workflow shell step 失败: step=${result.stepId}, reason=${reason}, stdout=${stdoutPath}, stderr=${stderrPath}`,
      );
    }

    return result;
  }

  private resolveStepCwd(stepCwd?: string | null): string {
    const expanded = expandHomeDir(stepCwd);
    if (!expanded) return process.cwd();
    if (expanded.startsWith('/')) return expanded;
    return resolve(process.cwd(), expanded);
  }
}
