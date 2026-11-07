'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const php = process.env.BOUNDED_FAQ_PHP || 'php';
const available = spawnSync(php, ['--version'], {encoding:'utf8', windowsHide:true, timeout:5000});
test('PHP backend: decisions, UTF-8, private storage, deduplication and budgets (no API)', {skip: available.error ? 'PHP CLI is not installed' : false}, () => {
  assert.equal(available.status, 0, available.stderr);
  for (const file of ['../assets/component/chat.php', '../assets/component/chat.config.example.php', 'backend.test.php']) {
    const lint = spawnSync(php, ['-l', path.join(__dirname, file)], {encoding:'utf8', windowsHide:true, timeout:5000});
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  }
  const run = spawnSync(php, [path.join(__dirname, 'backend.test.php')], {encoding:'utf8', windowsHide:true, timeout:10000});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /PASS fail-closed corrupt ledger/);
});
