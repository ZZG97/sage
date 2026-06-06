import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
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

describe('FeishuService post message parsing', () => {
  it('downloads images embedded in rich text post messages', async () => {
    const service = createFeishuServiceWithInternals() as any;
    const calls: any[] = [];
    service.downloadMessageResource = async (
      messageId: string,
      fileKey: string,
      fileName?: string,
      resourceType?: string,
    ) => {
      calls.push({ messageId, fileKey, fileName, resourceType });
      return `workspace/uploads/images/${fileKey}.jpeg`;
    };

    const parsed = await service.parseMessageContent({
      message_id: 'om_post',
      message_type: 'post',
      chat_id: 'oc_chat',
      chat_type: 'p2p',
      content: JSON.stringify({
        content: [[
          { tag: 'text', text: '看这个 ' },
          { tag: 'img', image_key: 'img_v3_post', width: 100, height: 80 },
        ]],
      }),
    });

    expect(parsed.text).toBe('看这个 ![user_uploaded_image](workspace/uploads/images/img_v3_post.jpeg)');
    expect(parsed.attachments).toEqual([
      { type: 'image', path: 'workspace/uploads/images/img_v3_post.jpeg' },
    ]);
    expect(calls).toEqual([
      { messageId: 'om_post', fileKey: 'img_v3_post', fileName: undefined, resourceType: 'image' },
    ]);
  });

  it('keeps rich text post parsing alive when embedded image download fails', async () => {
    const service = createFeishuServiceWithInternals() as any;
    service.downloadMessageResource = async () => {
      throw new Error('download failed');
    };

    const parsed = await service.parseMessageContent({
      message_id: 'om_post',
      message_type: 'post',
      chat_id: 'oc_chat',
      chat_type: 'p2p',
      content: JSON.stringify({
        content: [[
          { tag: 'text', text: '先看图 ' },
          { tag: 'img', image_key: 'img_v3_post' },
        ]],
      }),
    });

    expect(parsed.text).toBe('先看图 [图片: 下载失败]');
    expect(parsed.attachments).toBeUndefined();
  });

  it('stores declared image resources under images when Feishu returns octet-stream metadata', async () => {
    const service = createFeishuServiceWithInternals() as any;
    const fileKey = `test_post_image_${Date.now()}`;
    service.client = {
      im: {
        v1: {
          messageResource: {
            get: async () => ({
              headers: {
                get: (name: string) => name === 'inner_file_data_meta'
                  ? JSON.stringify({ Mime: 'application/octet-stream', FileName: 'image' })
                  : undefined,
              },
              writeFile: async (targetPath: string) => {
                fs.writeFileSync(targetPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
              },
            }),
          },
        },
      },
    };

    const localPath = await service.downloadMessageResource('om_post', fileKey, undefined, 'image');
    const absolutePath = path.resolve(process.env.HOME || '', 'workspace/sage/agent_home', localPath);

    try {
      expect(localPath).toBe(`workspace/uploads/images/${fileKey}.png`);
      expect(fs.existsSync(absolutePath)).toBe(true);
    } finally {
      fs.rmSync(absolutePath, { force: true });
    }
  });
});

describe('FeishuService.processImagesInMarkdown', () => {
  it('uploads local images outside fenced code blocks only', async () => {
    const service = createFeishuServiceWithInternals() as any;
    const uploaded: string[] = [];
    service.uploadImage = async (src: string) => {
      uploaded.push(src);
      return `img_uploaded_${uploaded.length}`;
    };

    const result = await service.processImagesInMarkdown([
      '正文图：![outside](workspace/uploads/images/outside.png)',
      '',
      '```text',
      '代码块里展示原文：![inside](workspace/uploads/images/inside.png)',
      '```',
      '',
      '远程图：![remote](https://example.com/remote.png)',
    ].join('\n'));

    expect(result).toContain('正文图：![outside](img_uploaded_1)');
    expect(result).toContain('代码块里展示原文：![inside](workspace/uploads/images/inside.png)');
    expect(result).toContain('远程图：![remote](https://example.com/remote.png)');
    expect(uploaded).toEqual(['workspace/uploads/images/outside.png']);
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
