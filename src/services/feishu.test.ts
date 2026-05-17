import { describe, expect, it } from 'bun:test';
import { FeishuService, splitMarkdownByTables } from './feishu';
import type { AgentEvent } from '../agent/types';

function createFeishuService(): FeishuService {
  return Object.create(FeishuService.prototype) as FeishuService;
}

function createFeishuServiceWithInternals(): FeishuService {
  const service = createFeishuService() as any;
  service.processedMessages = new Set<string>();
  service.logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  return service as FeishuService;
}

function parseCard(cardJson: string): any {
  return JSON.parse(cardJson);
}

function findMarkdownElements(card: any): any[] {
  return card.body.elements.filter((element: any) => element.tag === 'markdown');
}

describe('splitMarkdownByTables', () => {
  it('keeps markdown without too many tables as a single chunk', () => {
    const markdown = [
      'intro',
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      'outro',
    ].join('\n');

    expect(splitMarkdownByTables(markdown, 5)).toEqual([markdown]);
  });

  it('splits markdown by table count boundaries', () => {
    const table = (index: number) => [
      `table ${index}`,
      '| A | B |',
      '| - | - |',
      `| ${index} | value |`,
    ].join('\n');
    const markdown = Array.from({ length: 6 }, (_, index) => table(index + 1)).join('\n\n');

    const chunks = splitMarkdownByTables(markdown, 5);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('table 1');
    expect(chunks[0]).toContain('table 5');
    expect(chunks[0]).not.toContain('table 6');
    expect(chunks[1]).toContain('table 6');
  });
});

describe('FeishuService.buildStreamingCard', () => {
  it('sanitizes local image markdown before rendering card content', () => {
    const service = createFeishuService();
    const card = parseCard(
      service.buildStreamingCard([], false, '结果图：![chart](workspace/outputs/chart.png)'),
    );

    const markdown = findMarkdownElements(card).at(-1);

    expect(markdown.content).toContain('**chart**: `workspace/outputs/chart.png`');
    expect(markdown.content).not.toContain('![chart](workspace/outputs/chart.png)');
  });

  it('keeps remote URLs and Feishu image keys as image markdown', () => {
    const service = createFeishuService();
    const card = parseCard(
      service.buildStreamingCard(
        [],
        false,
        [
          '远程图：![remote](https://example.com/a.png)',
          '飞书图：![uploaded](img_v3_abc)',
        ].join('\n'),
      ),
    );

    const markdown = findMarkdownElements(card).at(-1);

    expect(markdown.content).toContain('![remote](https://example.com/a.png)');
    expect(markdown.content).toContain('![uploaded](img_v3_abc)');
  });

  it('renders streaming steps, latest text, and streaming indicator', () => {
    const service = createFeishuService();
    const events: AgentEvent[] = [
      { type: 'thinking', content: 'thinking', ts: '2026-05-17T00:00:00.000Z', persist: true },
      { type: 'tool_call', toolName: 'Bash', content: 'bun test', ts: '2026-05-17T00:00:01.000Z', persist: true },
      { type: 'text', content: '正在跑测试', ts: '2026-05-17T00:00:02.000Z', persist: true },
    ];

    const card = parseCard(service.buildStreamingCard(events, true));
    const panel = card.body.elements.find((element: any) => element.tag === 'collapsible_panel');
    const markdown = findMarkdownElements(card).at(-1);
    const indicator = card.body.elements.at(-1);

    expect(card.config.streaming_mode).toBe(true);
    expect(panel.header.title.content).toBe('Working on it (3 steps)');
    expect(markdown.content).toBe('正在跑测试');
    expect(indicator.icon.token).toBe('more_outlined');
  });
});

describe('FeishuService message recall', () => {
  it('dispatches recalled message ids from Feishu event payloads', async () => {
    const service = createFeishuServiceWithInternals() as any;
    const recalled: string[] = [];
    service.setMessageRecallHandler((messageId: string) => {
      recalled.push(messageId);
    });

    await service.handleMessageRecall({
      header: { event_id: 'evt-recall-1' },
      event: { message_id: 'om_recalled' },
    });

    expect(recalled).toEqual(['om_recalled']);
  });

  it('deduplicates recalled message events', async () => {
    const service = createFeishuServiceWithInternals() as any;
    let calls = 0;
    service.setMessageRecallHandler(() => {
      calls += 1;
    });

    await service.handleMessageRecall({
      event_id: 'evt-recall-duplicate',
      message_id: 'om_recalled',
    });
    await service.handleMessageRecall({
      event_id: 'evt-recall-duplicate',
      message_id: 'om_recalled',
    });

    expect(calls).toBe(1);
  });
});
