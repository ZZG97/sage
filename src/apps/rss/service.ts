import { Logger } from '../../utils';
import { getOperationsService } from '../operations/service';
import { RssClassifier } from './classifier';
import { FreshRssRepository } from './freshrss-repository';
import { labelsForResult } from './labeler';
import { RssRefreshController } from './refresh-controller';
import type { RefreshResult, RssWorkerOptions } from './types';

const logger = new Logger('RssAiService');

export class RssAiService {
  private repository: FreshRssRepository;
  private classifier: RssClassifier;
  private refreshController: RssRefreshController;

  constructor() {
    this.repository = new FreshRssRepository();
    this.classifier = new RssClassifier();
    this.refreshController = new RssRefreshController(this.repository);
  }

  async runOnce(options: RssWorkerOptions): Promise<{ refreshed: RefreshResult[]; outputRefreshed: RefreshResult[]; labeled: number; labelStats: LabelStats }> {
    const operation = getOperationsService().startRun({
      operationType: 'rss.ai.refresh',
      operationName: 'RSS AI refresh',
      metadata: {
        refresh: options.refresh,
        label: options.label,
        limit: options.limit,
        feedLimit: options.feedLimit,
        sinceHours: options.sinceHours,
        dryRun: options.dryRun,
      },
    });

    try {
      const refreshed = options.refresh
        ? await this.refreshController.refreshEligibleFeeds(options.feedLimit, options.dryRun)
        : [];

      const labelStats = options.label
        ? await this.labelNewEntries(options)
        : emptyLabelStats();

      const outputRefreshed = options.label && options.refreshOutputFeeds
        ? await this.refreshOutputFeeds(options)
        : [];

      const failedRefreshes = refreshed.filter((item) => !item.ok && !item.skipped).length;
      const skippedRefreshes = refreshed.filter((item) => item.skipped).length;
      const failedOutputRefreshes = outputRefreshed.filter((item) => !item.ok && !item.skipped).length;
      const newArticles = refreshed.reduce((sum, item) => sum + item.newArticles, 0);

      operation.addMetrics({
        feed_attempted: refreshed.length,
        feed_success: refreshed.filter((item) => item.ok).length,
        feed_failed: failedRefreshes,
        feed_skipped: skippedRefreshes,
        new_articles: newArticles,
        entries_seen: labelStats.entriesSeen,
        entries_classified: labelStats.labeled,
        ai_batch_count: labelStats.batchCount,
        ai_batch_failed: labelStats.batchFailed,
        must_read_count: labelStats.mustRead,
        skim_count: labelStats.skim,
        skip_count: labelStats.skip,
        output_feed_attempted: outputRefreshed.length,
        output_feed_failed: failedOutputRefreshes,
      });

      if (failedRefreshes > 0) operation.warn(`${failedRefreshes} input feeds failed`);
      if (failedOutputRefreshes > 0) operation.warn(`${failedOutputRefreshes} output feeds failed`);
      if (labelStats.batchFailed > 0) operation.warn(`${labelStats.batchFailed} AI batches failed`);
      if (options.label && labelStats.entriesSeen > 0 && labelStats.labeled === 0) {
        operation.warn('entries were seen but none were classified');
      }

      operation.success({
        summary: `feeds=${refreshed.length}, new=${newArticles}, classified=${labelStats.labeled}, output=${outputRefreshed.length}`,
      });

      return { refreshed, outputRefreshed, labeled: labelStats.labeled, labelStats };
    } catch (error) {
      operation.failure(error);
      throw error;
    }
  }

  private async labelNewEntries(options: RssWorkerOptions): Promise<LabelStats> {
    const entries = this.repository.listUnprocessedEntries(options.sinceHours, options.limit);
    const stats = emptyLabelStats();
    stats.entriesSeen = entries.length;

    for (let i = 0; i < entries.length; i += this.classifier.batchSize()) {
      const batch = entries.slice(i, i + this.classifier.batchSize());
      stats.batchCount += 1;
      try {
        const results = await this.classifier.classifyBatch(batch);
        for (let j = 0; j < batch.length; j += 1) {
          const entry = batch[j];
          const result = results[j];
          const labels = labelsForResult(result);
          const contentHash = this.classifier.contentHash(entry);
          this.repository.recordAiResult(entry, result, labels, contentHash, options.dryRun);
          stats.labeled += 1;
          if (result.priority === 'must_read') stats.mustRead += 1;
          else if (result.priority === 'skim') stats.skim += 1;
          else stats.skip += 1;
          logger.info(`AI 打标 ${entry.feed_name}#${entry.id}: ${labels.join(',')} (${result.reason})`);
        }
      } catch (error) {
        stats.batchFailed += 1;
        logger.error(`RSS AI batch 打标失败: offset=${i}, size=${batch.length}, reason=${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return stats;
  }

  private async refreshOutputFeeds(options: RssWorkerOptions): Promise<RefreshResult[]> {
    const feedIds = options.outputFeedIds.length > 0
      ? options.outputFeedIds
      : this.repository.listGeneratedFeeds().map((feed) => feed.id);

    if (feedIds.length === 0) {
      logger.info('未发现 AI 生成订阅源，跳过输出源刷新');
      return [];
    }

    return this.refreshController.refreshFeedIds(feedIds, options.dryRun);
  }
}

interface LabelStats {
  entriesSeen: number;
  labeled: number;
  batchCount: number;
  batchFailed: number;
  mustRead: number;
  skim: number;
  skip: number;
}

function emptyLabelStats(): LabelStats {
  return {
    entriesSeen: 0,
    labeled: 0,
    batchCount: 0,
    batchFailed: 0,
    mustRead: 0,
    skim: 0,
    skip: 0,
  };
}
