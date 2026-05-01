import { createHash } from 'crypto';
import type { FreshRssEntry, LabelResult, RssPriority, RssTopic } from './types';

const TOPIC_KEYWORDS: Array<[RssTopic, RegExp]> = [
  ['investment', /股票|股价|估值|财报|基金|港股|美股|A股|公司|收入|利润|现金流|资产|负债|投资|市场|雪球|\$[A-Z0-9.]+|\b[A-Z]{2,5}\b/i],
  ['ai', /AI|LLM|大模型|模型|Claude|OpenAI|Anthropic|Gemini|agent|智能体|推理|训练|算力|GPU|芯片/i],
  ['engineering', /代码|架构|数据库|服务端|后端|前端|工程|系统|API|开源|框架|部署|性能|缓存|并发|TypeScript|Python|Go|Rust/i],
  ['macro', /宏观|政策|央行|利率|通胀|汇率|财政|地产|就业|GDP|周期|关税|贸易|美联储|债券/i],
  ['life', /生活|旅行|吃|电影|音乐|游戏|家庭|孩子|北京|海淀|健身|睡眠|情绪|娱乐/i],
];

const NOISE_RE = /抽奖|转发微博|关注并转发|直播预约|招聘|内推|优惠券|带货|团购|开奖|粉丝福利/i;

export class RssClassifier {
  async classify(entry: FreshRssEntry): Promise<LabelResult> {
    const ruleResult = this.classifyByRules(entry);
    if (!this.shouldUseLlm(ruleResult, entry)) {
      return ruleResult;
    }

    try {
      return await this.classifyByLlm(entry, ruleResult);
    } catch {
      return {
        ...ruleResult,
        reason: `${ruleResult.reason}; llm_failed_rule_fallback`,
      };
    }
  }

  contentHash(entry: FreshRssEntry): string {
    return createHash('sha256')
      .update(`${entry.title}\n${entry.content ?? ''}\n${entry.link}`)
      .digest('hex');
  }

  private classifyByRules(entry: FreshRssEntry): LabelResult {
    const text = normalizeText(`${entry.title}\n${entry.content ?? ''}`);
    const topics = detectTopics(text);
    const length = text.length;
    const noisy = NOISE_RE.test(text);
    const hasStrongTopic = topics.some((topic) => topic !== 'life');
    const hasUsefulSignals = /数据|原因|因为|结论|变化|增长|下降|风险|机会|复盘|分析|验证|假设|预期|观察|趋势/.test(text);

    let priority: RssPriority = 'skim';
    const reasons: string[] = [];

    if (noisy) {
      priority = 'skip';
      reasons.push('noise_keyword');
    } else if (length < 80 && !hasUsefulSignals) {
      priority = 'skip';
      reasons.push('too_short_low_signal');
    } else if (hasStrongTopic && (length >= 500 || hasUsefulSignals)) {
      priority = 'must_read';
      reasons.push('strong_topic_with_signal');
    } else if (hasStrongTopic || hasUsefulSignals) {
      priority = 'skim';
      reasons.push('some_signal');
    } else {
      priority = 'skip';
      reasons.push('off_topic_or_low_signal');
    }

    return {
      priority,
      topics: topics.length > 0 ? topics : ['life'],
      confidence: priority === 'skim' ? 0.62 : 0.72,
      reason: reasons.join(','),
      fact_or_opinion: inferFactOrOpinion(text),
      model: 'rules-v1',
    };
  }

  private shouldUseLlm(ruleResult: LabelResult, entry: FreshRssEntry): boolean {
    if (process.env.RSS_AI_ENABLE_LLM !== '1') return false;
    if (!process.env.OPENAI_API_KEY || !process.env.RSS_AI_MODEL) return false;
    if (ruleResult.priority === 'skip' && ruleResult.confidence >= 0.7) return false;
    const contentLength = normalizeText(`${entry.title}\n${entry.content ?? ''}`).length;
    return contentLength >= 80;
  }

  private async classifyByLlm(entry: FreshRssEntry, fallback: LabelResult): Promise<LabelResult> {
    const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const model = process.env.RSS_AI_MODEL!;
    const text = normalizeText(`${entry.title}\n${entry.content ?? ''}`).slice(0, 6000);
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: '你是老张的 RSS 信息流质量分类器。只输出 JSON，不要 markdown。priority 只能是 must_read/skim/skip；topics 从 investment/ai/engineering/macro/life 中选 1-2 个；confidence 0-1；fact_or_opinion 为 fact/opinion/mixed/unknown。',
          },
          {
            role: 'user',
            content: JSON.stringify({
              feed: entry.feed_name,
              author: entry.author,
              title: entry.title,
              text,
              rule_hint: fallback,
            }, null, 2),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status}`);
    }

    const data = await response.json() as any;
    const raw = data.choices?.[0]?.message?.content;
    if (!raw || typeof raw !== 'string') {
      throw new Error('LLM response missing content');
    }

    const parsed = JSON.parse(raw);
    return normalizeLlmResult(parsed, model, fallback);
  }
}

function detectTopics(text: string): RssTopic[] {
  const topics: RssTopic[] = [];
  for (const [topic, pattern] of TOPIC_KEYWORDS) {
    if (pattern.test(text)) {
      topics.push(topic);
    }
  }
  return topics.slice(0, 2);
}

function inferFactOrOpinion(text: string): LabelResult['fact_or_opinion'] {
  const hasFact = /数据|公告|财报|报告|显示|同比|环比|收入|利润|发布|发生|完成|增长|下降/.test(text);
  const hasOpinion = /认为|感觉|我觉得|可能|预期|估计|判断|看好|不看好|风险|机会|应该|或许/.test(text);
  if (hasFact && hasOpinion) return 'mixed';
  if (hasFact) return 'fact';
  if (hasOpinion) return 'opinion';
  return 'unknown';
}

function normalizeLlmResult(input: any, model: string, fallback: LabelResult): LabelResult {
  const priority = ['must_read', 'skim', 'skip'].includes(input.priority) ? input.priority as RssPriority : fallback.priority;
  const topics = Array.isArray(input.topics)
    ? input.topics.filter((topic: string) => ['investment', 'ai', 'engineering', 'macro', 'life'].includes(topic)).slice(0, 2) as RssTopic[]
    : fallback.topics;
  const confidence = typeof input.confidence === 'number'
    ? Math.max(0, Math.min(1, input.confidence))
    : fallback.confidence;
  const factOrOpinion = ['fact', 'opinion', 'mixed', 'unknown'].includes(input.fact_or_opinion)
    ? input.fact_or_opinion
    : fallback.fact_or_opinion;

  return {
    priority,
    topics: topics.length > 0 ? topics : fallback.topics,
    confidence,
    reason: typeof input.reason === 'string' ? input.reason.slice(0, 500) : fallback.reason,
    fact_or_opinion: factOrOpinion,
    model,
  };
}

function normalizeText(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
