import path from 'node:path';
import type { AgentEvent } from '../agent/types';

// 飞书卡片大小限制 30KB，预留 2KB buffer
export const CARD_SIZE_LIMIT = 28 * 1024;

export const MAX_TABLES_PER_CARD = 5;
const MARKDOWN_TABLE_REGEX = /^\|.+\|[ \t]*\n\|[\s:|-]+\|[ \t]*\n(?:\|.+\|[ \t]*\n?)+/gm;
export const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;
export const FENCED_CODE_BLOCK_REGEX = /```[\s\S]*?```/g;

// 工具图标映射
const TOOL_ICONS: Record<string, string> = {
  Read: 'file-link-bitable_outlined',
  Write: 'edit_outlined',
  Edit: 'edit_outlined',
  Bash: 'computer_outlined',
  Glob: 'card-search_outlined',
  Grep: 'doc-search_outlined',
  WebSearch: 'search_outlined',
  WebFetch: 'language_outlined',
  Agent: 'robot_outlined',
  Skill: 'file-link-mindnote_outlined',
  // codex
  command: 'computer_outlined',
  file_change: 'edit_outlined',
  web_search: 'search_outlined',
};

/** 按表格数量拆分 markdown，每块最多 maxTables 个表格 */
export function splitMarkdownByTables(markdown: string, maxTables: number = MAX_TABLES_PER_CARD): string[] {
  if (countMarkdownTables(markdown) <= maxTables) return [markdown];

  const regex = new RegExp(MARKDOWN_TABLE_REGEX.source, 'gm');
  const positions: { start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    positions.push({ start: match.index, end: match.index + match[0].length });
  }

  const chunks: string[] = [];
  let chunkStart = 0;
  let count = 0;

  for (let i = 0; i < positions.length; i++) {
    count++;
    if (count >= maxTables && i < positions.length - 1) {
      chunks.push(markdown.slice(chunkStart, positions[i]!.end).trim());
      chunkStart = positions[i]!.end;
      count = 0;
    }
  }

  const remaining = markdown.slice(chunkStart).trim();
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function countMarkdownTables(markdown: string): number {
  return markdown.match(MARKDOWN_TABLE_REGEX)?.length || 0;
}

export function hasTooManyMarkdownTables(markdown: string, maxTables: number = MAX_TABLES_PER_CARD): boolean {
  return countMarkdownTables(markdown) > maxTables;
}

export function isRemoteImageSource(src: string): boolean {
  return src.startsWith('http://') || src.startsWith('https://') || src.startsWith('img_');
}

/**
 * 飞书卡片 markdown 中，图片语法只接受 URL 或飞书 image_key。
 * 本地绝对/相对路径会被当作 image_key 校验并触发 400。
 * 流式阶段先降级成普通文本，最终阶段再走 uploadImage() 替换。
 */
function sanitizeCardMarkdown(markdown: string): string {
  return markdown.replace(MARKDOWN_IMAGE_REGEX, (_full, altText: string, src: string) => {
    if (isRemoteImageSource(src)) return _full;

    const label = altText?.trim() || '图片';
    const displayPath = path.isAbsolute(src) ? src : path.normalize(src);
    return `**${label}**: \`${displayPath}\``;
  });
}

/** 构建流式卡片（含中间步骤的 collapsible_panel + 流式文字） */
export function buildStreamingCard(events: AgentEvent[], streaming: boolean, resultText?: string): string {
  const steps: any[] = [];
  let thinkingCount = 0;
  let lastTextContent = '';
  const notices: string[] = [];

  for (const event of events) {
    if (event.type === 'thinking') {
      thinkingCount++;
    } else if (event.type === 'tool_call') {
      const icon = TOOL_ICONS[event.toolName || ''] || 'setting-inter_outlined';
      steps.push({
        tag: 'div',
        icon: { tag: 'standard_icon', token: icon, color: 'grey' },
        text: {
          tag: 'plain_text',
          text_color: 'grey',
          text_size: 'notation',
          content: event.content || event.toolName || 'tool',
        },
      });
    } else if (event.type === 'notice' && event.content) {
      notices.push(event.content);
    } else if (event.type === 'text' && event.content) {
      // 中间文本作为步骤保留在面板中，截断过长内容
      const truncated = event.content.length > 200 ? event.content.slice(0, 200) + '...' : event.content;
      steps.push({
        tag: 'div',
        icon: { tag: 'standard_icon', token: 'chat_outlined', color: 'grey' },
        text: {
          tag: 'plain_text',
          text_color: 'grey',
          text_size: 'notation',
          content: truncated,
        },
      });
      lastTextContent = event.content;
    }
  }

  // 如果有 thinking 事件，加一个汇总步骤
  if (thinkingCount > 0) {
    steps.unshift({
      tag: 'div',
      icon: { tag: 'standard_icon', token: 'robot_outlined', color: 'grey' },
      text: {
        tag: 'plain_text',
        text_color: 'grey',
        text_size: 'notation',
        content: 'Thinking...',
      },
    });
  }

  const elements: any[] = [];

  // notice banner（fallback 等系统提示，始终显示在顶部，不被 resultText 覆盖）
  if (notices.length > 0) {
    elements.push({
      tag: 'markdown',
      text_size: 'notation',
      text_align: 'left',
      content: notices.join(' | '),
    });
  }

  // collapsible_panel（有步骤时才显示）
  if (steps.length > 0) {
    const stepCount = steps.length;
    const stepCountText = `${stepCount} step${stepCount === 1 ? '' : 's'}`;

    elements.push({
      tag: 'collapsible_panel',
      expanded: streaming,
      border: { color: 'grey-300', corner_radius: '6px' },
      vertical_spacing: '2px',
      header: {
        title: {
          tag: 'plain_text',
          text_color: 'grey',
          text_size: 'notation',
          content: streaming ? `Working on it (${stepCountText})` : `Show ${stepCountText}`,
        },
        icon: { tag: 'standard_icon', token: 'right_outlined', color: 'grey' },
        icon_position: 'right',
        icon_expanded_angle: 90,
      },
      elements: steps,
    });
  }

  // 文字内容：streaming 时显示最新一段中间 text，完成时显示 resultText
  const displayText = streaming ? lastTextContent : resultText;
  if (displayText) {
    elements.push({
      tag: 'markdown',
      content: sanitizeCardMarkdown(displayText),
    });
  }

  // streaming 指示器
  if (streaming) {
    elements.push({
      tag: 'div',
      icon: { tag: 'standard_icon', token: 'more_outlined', color: 'grey' },
    });
  }

  // 确保 elements 不为空
  if (elements.length === 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'plain_text', content: '' },
    });
  }

  const summary = streaming
    ? (lastTextContent ? lastTextContent.slice(0, 100) : (steps.length > 0 ? `Working on it (${steps.length} steps)` : 'Thinking...'))
    : (resultText?.slice(0, 100) || '');

  const card = {
    schema: '2.0',
    config: {
      streaming_mode: true,
      update_multi: true,
      enable_forward: true,
      width_mode: 'fill',
      summary: { content: summary },
    },
    body: { elements },
  };

  return JSON.stringify(card);
}

/** 构建错误卡片 */
export function buildErrorCard(errorText: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [{ tag: 'markdown', content: errorText }],
    },
  });
}
