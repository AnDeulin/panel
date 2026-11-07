<?php
declare(strict_types=1);
define('BOUNDED_FAQ_LIBRARY_ONLY', true);
require dirname(__DIR__) . '/assets/component/chat.php';

// No API transport is called here. All state is in freshly allocated temp dirs.
function expect(bool $value, string $message): void { if (!$value) throw new RuntimeException($message); }
function rejects(callable $operation, string $message): void {
    try { $operation(); } catch (Throwable $e) { return; }
    throw new RuntimeException($message);
}
function config_for(string $dir, array $overrides = []): array {
    return array_replace(['storage_dir' => $dir, 'max_total_requests' => 10, 'max_daily_requests' => 10, 'max_session_daily_requests' => 10, 'max_ip_daily_requests' => 10, 'max_concurrent' => 2, 'max_total_rub' => 10.0, 'max_daily_rub' => 10.0], $overrides);
}
$directories = [];
function new_directory(): string {
    global $directories;
    $path = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'bfaq-test-' . bin2hex(random_bytes(8));
    if (!mkdir($path, 0700)) throw new RuntimeException('temp');
    $directories[] = $path;
    return $path;
}
try {
    $cards = [['id' => 'price', 'title' => 'Price', 'answer' => 'Approved'], ['id' => 'format', 'title' => 'Format', 'answer' => 'Approved']];
    expect(bfaq_decision(['status' => 'answer', 'ids' => ['price']], $cards)['ids'] === ['price'], 'known answer');
    foreach ([null, [], ['status' => 'unknown', 'ids' => []], ['status' => 'answer', 'ids' => []], ['status' => 'answer', 'ids' => ['secret']], ['status' => 'answer', 'ids' => ['price', 'price']], ['status' => 'answer', 'ids' => [['price']]], ['status' => 'out_of_scope', 'ids' => ['price']]] as $invalid) {
        expect(bfaq_decision($invalid, $cards) === bfaq_handoff(), 'invalid decision must fail closed');
    }
    expect(bfaq_model_decision('{"status":"answer","ids":["price"]}', $cards)['ids'] === ['price'], 'strict model JSON accepted');
    foreach (['[]', '{invalid', '{"status":"clarify","ids":{}}', '{"status":"answer","ids":["price"],"text":"unapproved"}', '{"status":"answer","ids":["missing"]}'] as $json) expect(bfaq_model_decision($json, $cards) === bfaq_handoff(), 'strict model schema failure');
    echo "PASS strict decisions\n";

    $unicode = str_repeat('🙂я', 400);
    $excerpt = bfaq_excerpt($unicode, 601);
    expect(preg_match('//u', $excerpt) === 1, 'excerpt UTF-8');
    expect(preg_match_all('/./us', $excerpt) === 601, 'excerpt characters');
    json_encode(['text' => $excerpt], JSON_THROW_ON_ERROR);
    echo "PASS UTF-8 context limits\n";

    expect(bfaq_inside('/tmp/public/file', '/tmp/public'), 'child path');
    expect(!bfaq_inside('/tmp/public-other/file', '/tmp/public'), 'sibling is not child');
    rejects(fn() => bfaq_private_path(__DIR__, dirname(__DIR__)), 'public storage must be rejected');
    $c = require dirname(__DIR__) . '/assets/component/chat.config.example.php';
    expect($c['enabled'] === false && $c['api_key'] === '' && $c['input_rub_per_million'] === 0 && !bfaq_ready($c), 'default is unpaid');
    echo "PASS disabled config and private paths\n";

    $dir = new_directory(); $c = config_for($dir, ['max_total_rub' => 2.0, 'max_daily_rub' => 2.0]);
    $session = hash('sha256', 'session'); $ip = hash('sha256', 'private-ip');
    $request = hash('sha256', 'request'); $fingerprint = hash('sha256', 'private-question');
    expect(bfaq_reserve($c, $session, $ip, $request, $fingerprint, 1000000)['allowed'], 'first reservation');
    expect(!bfaq_reserve($c, $session, $ip, $request, $fingerprint, 1000000)['allowed'], 'pending duplicate cannot pay');
    expect(!bfaq_reserve($c, 'other-session', $ip, 'parallel-request', 'f', 1000000)['allowed'], 'IP parallelism');
    bfaq_ledger($dir, function (array &$state) use ($request): void {
        $state['requests'][$request]['pending_until'] = 0;
        $state['requests'][$request]['decision'] = ['status' => 'answer', 'ids' => ['price'], 'source' => 'server'];
    });
    $duplicate = bfaq_reserve($c, $session, $ip, $request, $fingerprint, 1000000);
    expect(!$duplicate['allowed'] && $duplicate['decision']['ids'] === ['price'], 'completed duplicate returns cached decision');
    expect(bfaq_reserve($c, $session, $ip, $request, 'changed-fingerprint', 1000000)['decision'] === bfaq_handoff(), 'requestId reuse with changed body');
    expect(bfaq_reserve($c, $session, $ip, 'request-2', 'f2', 1000000)['allowed'], 'second reservation');
    expect(!bfaq_reserve($c, 'other-session', 'other-ip', 'request-3', 'f3', 1)['allowed'], 'budget cap');
    $raw = (string)file_get_contents($dir . '/faq-ledger.json'); $state = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
    expect($state['total'] === 2 && $state['reserved'] === 2000000, 'no duplicate charge or refund');
    expect(!str_contains($raw, 'private-question') && !str_contains($raw, 'private-ip'), 'no raw question or IP in storage');
    echo "PASS deduplication, IP concurrency and immutable spend reservations\n";

    $dir = new_directory(); $c = config_for($dir, ['max_concurrent' => 1]);
    expect(bfaq_reserve($c, 's1', 'ip1', 'r1', 'f1', 1)['allowed'], 'global concurrency first');
    expect(!bfaq_reserve($c, 's2', 'ip2', 'r2', 'f2', 1)['allowed'], 'global concurrency second');
    echo "PASS global concurrency\n";

    $dir = new_directory(); $c = config_for($dir, ['max_session_daily_requests' => 1]);
    expect(bfaq_reserve($c, 's1', 'ip1', 'r1', 'f1', 1)['allowed'], 'session limit first');
    bfaq_ledger($dir, function (array &$state): void { $state['requests']['r1']['pending_until'] = 0; });
    expect(!bfaq_reserve($c, 's1', 'ip2', 'r2', 'f2', 1)['allowed'], 'session limit persists over IP');
    echo "PASS session limits\n";

    $dir = new_directory(); file_put_contents($dir . '/faq-ledger.json', '');
    rejects(fn() => bfaq_ledger($dir, fn(array &$state) => true), 'empty existing ledger must not reset budget');
    file_put_contents($dir . '/faq-ledger.json', '{invalid');
    rejects(fn() => bfaq_ledger($dir, fn(array &$state) => true), 'corrupt ledger must not reset budget');
    echo "PASS fail-closed corrupt ledger\n";
} finally {
    foreach ($directories as $dir) {
        // Only these two files can be created by the exercised code. No
        // recursive traversal/deletion is needed for an isolated test fixture.
        foreach (['faq-ledger.json', 'faq-ledger.lock'] as $name) {
            $file = $dir . DIRECTORY_SEPARATOR . $name;
            if (is_file($file)) unlink($file);
        }
        rmdir($dir);
    }
}
