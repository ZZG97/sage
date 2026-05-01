import { Logger } from '../../utils';
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

  async runOnce(options: RssWorkerOptions): Promise<{ refreshed: RefreshResult[]; outputRefreshed: RefreshResult[]; labeled: number }> {
    const refreshed = options.refresh
      ? await this.refreshController.refreshEligibleFeeds(options.feedLimit, options.dryRun)
      : [];

    const labeled = options.label
      ? await this.labelNewEntries(options)
      : 0;

    const outputRefreshed = options.label && options.refreshOutputFeeds
      ? await this.refreshOutputFeeds(options)
      : [];

    return { refreshed, outputRefreshed, labeled };
  }

  private async labelNewEntries(options: RssWorkerOptions): Promise<number> {
    const entries = this.repository.listUnprocessedEntries(options.sinceHours, options.limit);
    let labeled = 0;

    for (let i = 0; i < entries.length; i += this.classifier.batchSize()) {
      const batch = entries.slice(i, i + this.classifier.batchSize());
      try {
        const results = await this.classifier.classifyBatch(batch);
        for (let j = 0; j < batch.length; j += 1) {
          const entry = batch[j];
          const result = results[j];
          const labels = labelsForResult(result);
          const contentHash = this.classifier.contentHash(entry);
          this.repository.recordAiResult(entry, result, labels, contentHash, options.dryRun);
          labeled += 1;
          logger.info(`AI 打标 ${entry.feed_name}#${entry.id}: ${labels.join(',')} (${result.reason})`);
        }
      } catch (error) {
        logger.error(`RSS AI batch 打标失败: offset=${i}, size=${batch.length}, reason=${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return labeled;
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
