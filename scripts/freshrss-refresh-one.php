#!/usr/bin/env php
<?php
declare(strict_types=1);

require '/var/www/FreshRSS/cli/_cli.php';

performRequirementCheck(FreshRSS_Context::systemConf()->db['type'] ?? '');

$options = getopt('', ['user:', 'feed-id:']);
if (!is_array($options)) {
	fail('FreshRSS error: invalid options');
}

$user = $options['user'] ?? '';
$feedId = (int)($options['feed-id'] ?? 0);

if (!is_string($user) || $user === '') {
	fail('FreshRSS error: --user is required');
}
if ($feedId <= 0) {
	fail('FreshRSS error: --feed-id must be positive');
}

$username = cliInitUser($user);

try {
	FreshRSS_feed_Controller::commitNewEntries();
	[$nbUpdatedFeeds, $feed, $nbNewArticles] = FreshRSS_feed_Controller::actualizeFeedsAndCommit($feedId);
	invalidateHttpCache($username);

	echo json_encode([
		'ok' => $feed instanceof FreshRSS_Feed,
		'user' => $username,
		'feed_id' => $feedId,
		'feed_name' => $feed instanceof FreshRSS_Feed ? $feed->name() : null,
		'updated_feeds' => $nbUpdatedFeeds,
		'new_articles' => $nbNewArticles,
		'reason' => $feed instanceof FreshRSS_Feed ? 'ok' : 'feed_not_found',
	], JSON_UNESCAPED_UNICODE) . PHP_EOL;
	exit($feed instanceof FreshRSS_Feed ? 0 : 2);
} catch (Throwable $e) {
	fwrite(STDERR, $e->getMessage() . PHP_EOL);
	echo json_encode([
		'ok' => false,
		'user' => $username,
		'feed_id' => $feedId,
		'updated_feeds' => 0,
		'new_articles' => 0,
		'reason' => get_class($e),
	], JSON_UNESCAPED_UNICODE) . PHP_EOL;
	exit(1);
}
