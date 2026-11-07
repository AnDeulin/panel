<?php
declare(strict_types=1);

// PHP 8.1+ and cURL. Copy this file OUTSIDE the document root; never upload a
// populated configuration into public hosting or git. Set BOUNDED_FAQ_CONFIG to
// its absolute path. Environment variables may also supply individual values.
// Nothing is paid until enabled, key, secret, private storage and verified
// token-price ceilings have all been supplied. No automatic API retries.
return [
    'enabled' => false,
    'api_key' => '',                         // Prefer DEEPSEEK_API_KEY environment.
    'model' => 'deepseek-flash',             // Verify against provider docs.
    'session_secret' => '',                 // BOUNDED_FAQ_SECRET, >=32 random chars.
    'storage_dir' => '',                    // Existing private directory, outside web root.
    'knowledge_path' => '',                 // Absolute path to your public knowledge.json.
    'allowed_origins' => ['https://example.invalid'],
    // Operator-verified upper bounds, RUB per million tokens including currency
    // conversion/fees. Zero disables paid requests; no price is assumed here.
    'input_rub_per_million' => 0,
    'output_rub_per_million' => 0,
    'call_reserve_rub' => 1.0,               // Every admitted attempt consumes this or more.
    'max_total_rub' => 300.0,               // This pilot's ceiling; only private config can change it.
    'max_daily_rub' => 30.0,
    'max_total_requests' => 100,
    'max_daily_requests' => 30,
    'max_session_daily_requests' => 12,
    'max_ip_daily_requests' => 20,
    'max_concurrent' => 2,
    // Fixed code limits: 1,200 question characters, 4 short context turns,
    // 24,000 request bytes to provider, max_tokens=160, 8-second timeout.
    // A reservation remains consumed after timeout/error: uncertain charges
    // are never refunded automatically and requestId is never retried.
];
