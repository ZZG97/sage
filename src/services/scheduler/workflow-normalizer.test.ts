import { describe, expect, it } from 'bun:test';
import { buildDynamicTask } from './dynamic-task-repository';
import { normalizeWorkflowPayload, summarizeWorkflowPayload } from './workflow-normalizer';

describe('scheduler workflow normalizer', () => {
  it('normalizes linear workflow steps and job options', () => {
    const workflow = normalizeWorkflowPayload({
      steps: [
        { kind: 'shell', command: '  echo hello  ', cwd: ' . ', timeoutSec: 3.8 },
        { kind: 'agent', prompt: '  summarize results  ', title: ' Summary ' },
      ],
      jobOptions: { attempts: 2, backoff: 100.4 },
    });

    expect(workflow).toEqual({
      version: 1,
      steps: [
        { id: 'step_01', kind: 'shell', command: 'echo hello', cwd: '.', timeoutSec: 3 },
        { id: 'step_02', kind: 'agent', prompt: 'summarize results', title: 'Summary' },
      ],
      jobOptions: { attempts: 2, backoff: 100 },
    });
  });

  it('rejects non-integer or non-positive workflow attempts', () => {
    const baseWorkflow = {
      steps: [{ kind: 'shell', command: 'echo hello' }],
    };

    expect(() => normalizeWorkflowPayload({ ...baseWorkflow, jobOptions: { attempts: 0.5 } }))
      .toThrow('workflow.jobOptions.attempts 必须是正整数');
    expect(() => normalizeWorkflowPayload({ ...baseWorkflow, jobOptions: { attempts: 0 } }))
      .toThrow('workflow.jobOptions.attempts 必须是正整数');
    expect(() => normalizeWorkflowPayload({ ...baseWorkflow, jobOptions: { attempts: 2.9 } }))
      .toThrow('workflow.jobOptions.attempts 必须是正整数');
  });

  it('rejects invalid workflow payloads at the boundary', () => {
    expect(() => normalizeWorkflowPayload({ steps: [] })).toThrow('workflow.steps 必须是非空数组');
    expect(() => normalizeWorkflowPayload({ steps: [{ kind: 'shell', command: '' }] }))
      .toThrow('workflow.steps[0].command 不能为空');
    expect(() => normalizeWorkflowPayload({ steps: [{ kind: 'agent', prompt: '' }] }))
      .toThrow('workflow.steps[0].prompt 不能为空');
  });

  it('uses workflow summary as message when workflow message is blank', () => {
    const payload = normalizeWorkflowPayload({
      steps: [
        { kind: 'shell', command: 'bun run rss:ai:refresh' },
        { kind: 'agent', prompt: '检查刷新结果并汇报' },
      ],
    });
    const task = buildDynamicTask('task-1', {
      kind: 'workflow',
      message: '  ',
      payload,
      pattern: '0 8 * * *',
    }, 123);

    expect(task.message).toBe(summarizeWorkflowPayload(payload));
    expect(task.payload).toEqual(payload);
  });
});
