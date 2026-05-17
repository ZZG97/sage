import { RssAiService } from './service';
import type { RssWorkerOptions } from './types';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const service = new RssAiService();
  const result = await service.runOnce(options);

  console.log(JSON.stringify({
    ok: true,
    options,
    refreshed: result.refreshed.map((item) => ({
      feedId: item.feedId,
      feedName: item.feedName,
      domain: item.domain,
      ok: item.ok,
      reason: item.reason,
      newArticles: item.newArticles,
    })),
    outputRefreshed: result.outputRefreshed.map((item) => ({
      feedId: item.feedId,
      feedName: item.feedName,
      domain: item.domain,
      ok: item.ok,
      reason: item.reason,
      newArticles: item.newArticles,
    })),
    labeled: result.labeled,
    labelStats: result.labelStats,
  }, null, 2));
}

function parseArgs(args: string[]): RssWorkerOptions {
  const options: RssWorkerOptions = {
    refresh: false,
    label: true,
    limit: 50,
    feedLimit: 5,
    sinceHours: 48,
    dryRun: false,
    refreshOutputFeeds: true,
    outputFeedIds: parseNumberList(process.env.RSS_AI_OUTPUT_FEED_IDS),
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--refresh':
        options.refresh = true;
        break;
      case '--refresh-only':
        options.refresh = true;
        options.label = false;
        break;
      case '--label-only':
        options.refresh = false;
        options.label = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--no-output-refresh':
        options.refreshOutputFeeds = false;
        break;
      case '--output-feed-id':
        options.outputFeedIds.push(parseNumberArg(args[++i], '--output-feed-id'));
        break;
      case '--output-feed-ids':
        options.outputFeedIds.push(...parseNumberList(args[++i], '--output-feed-ids'));
        break;
      case '--limit':
        options.limit = parseNumberArg(args[++i], '--limit');
        break;
      case '--feed-limit':
        options.feedLimit = parseNumberArg(args[++i], '--feed-limit');
        break;
      case '--since-hours':
        options.sinceHours = parseNumberArg(args[++i], '--since-hours');
        break;
      case '--once':
        break;
      default:
        throw new Error(`未知参数: ${arg}`);
    }
  }

  return options;
}

function parseNumberArg(value: string | undefined, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} 需要正数`);
  }
  return Math.floor(number);
}

function parseNumberList(value: string | undefined, name = 'number list'): number[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => parseNumberArg(item, name));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
