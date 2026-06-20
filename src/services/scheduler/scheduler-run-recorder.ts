import { getOperationsService, type OperationRunHandle } from '../../apps/operations/service';
import type { TaskJobData } from './types';

export type SchedulerRunOperation = Pick<OperationRunHandle, 'addMetrics' | 'failure' | 'success' | 'warn'>;

export class SchedulerRunRecorder {
  async record(jobData: TaskJobData, fn: (operation: SchedulerRunOperation) => Promise<void>): Promise<void> {
    const { type, task_id, kind, title } = jobData;
    const contextKind = type === 'builtin' ? 'builtin' : (kind || 'message');
    const operation = getOperationsService().startRun({
      operationType: type === 'builtin' ? 'scheduler.builtin' : `scheduler.dynamic.${contextKind}`,
      operationName: task_id,
      triggerType: 'scheduler',
      metadata: {
        kind: contextKind,
        title: title || null,
      },
    });

    try {
      await fn(operation);
    } catch (error) {
      operation.failure(error);
      throw error;
    }
  }
}
