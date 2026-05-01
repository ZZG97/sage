import { createHash } from 'crypto';
import { createAgentProvider, StructuredAgentRunner } from '../../agent';
import type { AgentProviderConfig } from '../../agent';
import type { FreshRssEntry, LabelResult, RssPriority, RssTopic } from './types';

interface BatchOutput {
  items: BatchItemOutput[];
}

interface BatchItemOutput {
  id: string;
  priority: RssPriority;
  topics: RssTopic[];
  confidence: number;
  reason: string;
  summary: string;
  fact_or_opinion: LabelResult['fact_or_opinion'];
}

const PRIORITIES = ['must_read', 'skim', 'skip'] as const;
const TOPICS = ['investment', 'ai', 'engineering', 'macro', 'life'] as const;
const FACT_OR_OPINION = ['fact', 'opinion', 'mixed', 'unknown'] as const;

export class RssClassifier {
  private runner?: StructuredAgentRunner;

  async classifyBatch(entries: FreshRssEntry[]): Promise<LabelResult[]> {
    if (entries.length === 0) return [];
    const runner = await this.getRunner();
    const expectedIds = entries.map((entry) => String(entry.id));
    const prompt = buildPrompt(entries);

    const result = await runner.run<BatchOutput>({
      name: 'rss.classify.batch',
      prompt,
      outputSchema: RSS_BATCH_OUTPUT_SCHEMA,
      validate: (raw) => validateBatchOutput(raw, expectedIds),
      timeoutMs: parsePositiveInt(process.env.RSS_AI_TIMEOUT_MS, 120000),
      retries: parseNonNegativeInt(process.env.RSS_AI_RETRIES, 1),
    });

    const byId = new Map(result.value.items.map((item) => [item.id, item]));
    return entries.map((entry) => {
      const item = byId.get(String(entry.id));
      if (!item) {
        throw new Error(`missing classified item: ${entry.id}`);
      }
      return {
        priority: item.priority,
        topics: item.topics,
        confidence: item.confidence,
        reason: item.reason,
        summary: item.summary,
        fact_or_opinion: item.fact_or_opinion,
        model: process.env.RSS_AI_MODEL || process.env.RSS_AI_CODEX_MODEL || process.env.CODEX_MODEL || 'gpt-5.3-codex',
      };
    });
  }

  contentHash(entry: FreshRssEntry): string {
    return createHash('sha256')
      .update(`${entry.title}\n${entry.content ?? ''}\n${entry.link}`)
      .digest('hex');
  }

  batchSize(): number {
    return parsePositiveInt(process.env.RSS_AI_BATCH_SIZE, 10);
  }

  private async getRunner(): Promise<StructuredAgentRunner> {
    if (this.runner) return this.runner;
    const provider = createAgentProvider([buildRssAgentProviderConfig()]);
    await provider.initialize();
    this.runner = new StructuredAgentRunner(provider);
    return this.runner;
  }
}

function buildRssAgentProviderConfig(): AgentProviderConfig {
  const provider = process.env.RSS_AI_PROVIDER || 'codex';
  if (provider !== 'codex') {
    throw new Error(`RSS_AI_PROVIDER=${provider} is not supported yet; use codex`);
  }

  return {
    type: 'codex',
    workDir: process.env.RSS_AI_WORK_DIR || process.env.CODEX_WORK_DIR || process.cwd(),
    model: process.env.RSS_AI_MODEL || process.env.RSS_AI_CODEX_MODEL || process.env.CODEX_MODEL || 'gpt-5.3-codex',
    reasoningEffort: parseReasoningEffort(process.env.RSS_AI_REASONING || 'low'),
    sandboxMode: 'read-only',
  };
}

function buildPrompt(entries: FreshRssEntry[]): string {
  const items = entries.map((entry) => ({
    id: String(entry.id),
    feed: entry.feed_name,
    domain: entry.domain,
    author: entry.author,
    title: entry.title,
    link: entry.link,
    text: normalizeText(`${entry.title}\n${entry.content ?? ''}`).slice(0, parsePositiveInt(process.env.RSS_AI_TEXT_LIMIT, 5000)),
  }));

  return [
    '你是老张的 RSS 信息流筛选器。老张是服务端工程师，关注投资、AI、工程实践、宏观变化、Sage 个人项目和个人效率。',
    '',
    '任务：判断每条内容是否值得在 FreshRSS 里优先阅读。',
    '',
    '判定标准：',
    '- must_read：值得打开看；有新事实、新判断、清晰假设、风险/机会、工程经验、AI 趋势、投资线索，或短内容但信息密度高。',
    '- skim：可能有用但不紧急；观点一般、信息不完整、需要结合上下文。',
    '- skip：广告、转发抽奖、纯情绪、低信息密度、离主题远、重复、无明确观点。',
    '',
    '注意：不要因为内容短就自动 skip；对作者碎片化表达，要看是否有明确判断或可跟踪线索。不要为了覆盖率提高优先级，宁可保守。',
    '只根据给定内容判断，不要调用工具，不要访问网页。',
    '',
    '待分类内容 JSON：',
    JSON.stringify({ items }, null, 2),
  ].join('\n');
}

function validateBatchOutput(raw: string, expectedIds: string[]): BatchOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isObject(parsed) || !Array.isArray(parsed.items)) {
    throw new Error('output must be object with items array');
  }

  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  const items: BatchItemOutput[] = [];

  for (const rawItem of parsed.items) {
    if (!isObject(rawItem)) throw new Error('item must be object');
    const id = stringField(rawItem, 'id', 80);
    if (!expected.has(id)) throw new Error(`unexpected item id: ${id}`);
    if (seen.has(id)) throw new Error(`duplicate item id: ${id}`);
    seen.add(id);

    const priority = enumField(rawItem, 'priority', PRIORITIES);
    const topics = topicsField(rawItem);
    const confidence = numberField(rawItem, 'confidence', 0, 1);
    const reason = stringField(rawItem, 'reason', 300);
    const summary = stringField(rawItem, 'summary', 300);
    const factOrOpinion = enumField(rawItem, 'fact_or_opinion', FACT_OR_OPINION);

    items.push({
      id,
      priority,
      topics,
      confidence,
      reason,
      summary,
      fact_or_opinion: factOrOpinion,
    });
  }

  for (const id of expectedIds) {
    if (!seen.has(id)) throw new Error(`missing item id: ${id}`);
  }

  return { items };
}

function topicsField(item: Record<string, unknown>): RssTopic[] {
  const value = item.topics;
  if (!Array.isArray(value)) throw new Error('topics must be array');
  const topics = value.filter((topic): topic is RssTopic => typeof topic === 'string' && TOPICS.includes(topic as RssTopic));
  const unique = [...new Set(topics)].slice(0, 2);
  if (unique.length === 0) throw new Error('topics must include at least one known topic');
  return unique;
}

function stringField(item: Record<string, unknown>, key: string, maxLength: number): string {
  const value = item[key];
  if (typeof value !== 'string') throw new Error(`${key} must be string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${key} must not be empty`);
  return trimmed.slice(0, maxLength);
}

function numberField(item: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = item[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be number`);
  return Math.max(min, Math.min(max, value));
}

function enumField<T extends readonly string[]>(item: Record<string, unknown>, key: string, values: T): T[number] {
  const value = item[key];
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new Error(`${key} must be one of ${values.join(',')}`);
  }
  return value as T[number];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseReasoningEffort(value: string): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  if (['minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)) {
    return value as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  }
  return 'low';
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function normalizeText(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const RSS_BATCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'priority', 'topics', 'confidence', 'reason', 'summary', 'fact_or_opinion'],
        properties: {
          id: { type: 'string' },
          priority: { type: 'string', enum: PRIORITIES },
          topics: {
            type: 'array',
            minItems: 1,
            maxItems: 2,
            items: { type: 'string', enum: TOPICS },
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string', minLength: 1, maxLength: 300 },
          summary: { type: 'string', minLength: 1, maxLength: 300 },
          fact_or_opinion: { type: 'string', enum: FACT_OR_OPINION },
        },
      },
    },
  },
};
