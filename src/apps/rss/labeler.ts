import type { LabelResult, RssPriority, RssTopic } from './types';

export const PRIORITY_LABELS: Record<RssPriority, string> = {
  must_read: 'AI·必读',
  skim: 'AI·可看',
  skip: 'AI·略过',
};

export const TOPIC_LABELS: Record<RssTopic, string> = {
  investment: '主题·投资',
  ai: '主题·AI',
  engineering: '主题·工程',
  macro: '主题·宏观',
  life: '主题·生活',
};

export const ALL_PRIORITY_LABELS = Object.values(PRIORITY_LABELS);
export const ALL_TOPIC_LABELS = Object.values(TOPIC_LABELS);

export function labelsForResult(result: LabelResult): string[] {
  const labels = [PRIORITY_LABELS[result.priority]];
  for (const topic of result.topics.slice(0, 2)) {
    labels.push(TOPIC_LABELS[topic]);
  }
  return [...new Set(labels)];
}
