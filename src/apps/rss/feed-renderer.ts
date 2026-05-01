import type { AiFeedItem } from './freshrss-repository';

interface RenderOptions {
  title: string;
  description: string;
  selfUrl: string;
}

export function renderAiRssFeed(items: AiFeedItem[], options: RenderOptions): string {
  const now = new Date().toUTCString();
  const renderedItems = items.map(renderItem).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(options.title)}</title>
    <link>${escapeXml(options.selfUrl)}</link>
    <description>${escapeXml(options.description)}</description>
    <generator>Sage RSS AI</generator>
    <lastBuildDate>${escapeXml(now)}</lastBuildDate>
    <ttl>10</ttl>
${renderedItems}
  </channel>
</rss>
`;
}

function renderItem(item: AiFeedItem): string {
  const title = item.title;
  const pubDate = item.published_at
    ? new Date(item.published_at * 1000).toUTCString()
    : parseLocalDate(item.processed_at).toUTCString();
  const originalPubDate = item.published_at
    ? new Date(item.published_at * 1000).toLocaleString('zh-CN', { hour12: false })
    : '未知';
  const aiProcessedAt = parseLocalDate(item.processed_at).toLocaleString('zh-CN', { hour12: false });
  const originalContent = item.content || escapeHtml(item.title);
  const body = [
    '<!-- SAGE_AI_BEGIN -->',
    renderAiBlock(item, originalPubDate, aiProcessedAt),
    '<!-- SAGE_AI_END -->',
    '<hr>',
    originalContent,
  ].join('\n');

  return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="false">sage:rss-ai:${escapeXml(item.priority)}:${item.entry_id}</guid>
      <pubDate>${escapeXml(pubDate)}</pubDate>
      <author>${escapeXml(item.author || item.feed_name)}</author>
${item.labels.map((label) => `      <category>${escapeXml(label)}</category>`).join('\n')}
      <description><![CDATA[${escapeCdata(body)}]]></description>
    </item>`;
}

function renderAiBlock(item: AiFeedItem, originalPubDate: string, aiProcessedAt: string): string {
  const source = `${item.feed_name}${item.author ? ` / ${item.author}` : ''}`;
  const labels = item.labels.length > 0 ? item.labels.join(' / ') : '无';

  return [
    '<div class="sage-ai" data-sage-ai="true" style="margin:0 0 16px 0;padding:12px 14px;border:1px solid #dbeafe;border-left:4px solid #2563eb;border-radius:8px;background:#f8fafc;color:#0f172a;font-size:14px;line-height:1.7;">',
    '<div style="margin:0 0 8px 0;color:#2563eb;font-size:12px;font-weight:700;letter-spacing:0;">Sage AI</div>',
    `<p style="margin:0 0 10px 0;"><strong style="color:#0f172a;">摘要：</strong>${escapeHtml(item.summary || '无摘要')}</p>`,
    `<p style="margin:0 0 10px 0;color:#334155;"><strong style="color:#0f172a;">理由：</strong>${escapeHtml(item.reason)}</p>`,
    '<div style="margin-top:10px;padding-top:8px;border-top:1px solid #e2e8f0;color:#475569;font-size:12px;line-height:1.6;">',
    `<div><strong>标签：</strong>${escapeHtml(labels)}</div>`,
    `<div><strong>来源：</strong>${escapeHtml(source)}</div>`,
    `<div><strong>AI 处理：</strong>${escapeHtml(aiProcessedAt)}</div>`,
    '</div>',
    '</div>',
  ].join('\n');
}

function parseLocalDate(value: string): Date {
  const parsed = new Date(value.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeXml(value: string): string {
  return escapeHtml(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function escapeCdata(value: string): string {
  return value.replace(/]]>/g, ']]]]><![CDATA[>');
}
