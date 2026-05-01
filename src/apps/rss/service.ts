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

  async runOnce(options: RssWorkerOptions): Promise<{ refreshed: RefreshResult[]; labeled: number }> {
    const refreshed = options.refresh
      ? await this.refreshController.refreshEligibleFeeds(options.feedLimit, options.dryRun)
      : [];

    const labeled = options.label
      ? await this.labelNewEntries(options)
      : 0;

    return { refreshed, labeled };
  }

  private async labelNewEntries(options: RssWorkerOptions): Promise<number> {
    const entries = this.repository.listUnprocessedEntries(options.sinceHours, options.limit);
    let labeled = 0;

    for (const entry of entries) {
      const result = await this.classifier.classify(entry);
      const labels = labelsForResult(result);
      const contentHash = this.classifier.contentHash(entry);
      this.repository.applyLabelResult(entry, result, labels, contentHash, options.dryRun);
      labeled += 1;
      logger.info(`打标 ${entry.feed_name}#${entry.id}: ${labels.join(',')} (${result.reason})`);
    }

    return labeled;
  }
}
