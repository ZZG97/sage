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
  const title = `${labelPrefix(item.labels)} ${stripHtml(item.title)}`.trim();
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
    '<div class="sage-ai" data-sage-ai="true">',
    '<h2>AI 摘要</h2>',
    `<p>${escapeHtml(item.summary || '无摘要')}</p>`,
    '<h2>判断理由</h2>',
    `<p>${escapeHtml(item.reason)}</p>`,
    `<p><strong>标签：</strong>${escapeHtml(item.labels.join(' / '))}</p>`,
    `<p><strong>来源：</strong>${escapeHtml(item.feed_name)}${item.author ? ` / ${escapeHtml(item.author)}` : ''}</p>`,
    `<p><strong>原文时间：</strong>${escapeHtml(originalPubDate)}</p>`,
    `<p><strong>AI 处理时间：</strong>${escapeHtml(aiProcessedAt)}</p>`,
    `<p><strong>原文链接：</strong><a href="${escapeAttr(item.link)}">${escapeHtml(item.link)}</a></p>`,
    '</div>',
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

function labelPrefix(labels: string[]): string {
  return labels
    .map((label) => `[${label.replace(/^主题·/, '')}]`)
    .join('');
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
