# Component and integration

## Knowledge schema

The JSON object contains `schemaVersion:1`, `version`, `brand`, `assistantName`, `greeting`, `telegramUsername`, `privacyUrl`, `enrollLabel`, `enrollText`, `suggestedIds`, `messages` and `cards`.

Set `launcherLabel`, `questionLabel`, `questionPlaceholder`, `humanLabel`, `handoffTitle`, `handoffCta`, `enrollLead` and `handoffLead` for the product's own wording. Defaults describe a general question or order. The supplied runtime's interface and routing heuristics primarily target Russian-language sites; other languages require a separate interface and question evaluation.

Cards have `id`, `title`, plain `answer`, bounded regex `patterns`, optional `excludePatterns`, `examples`, `handoff`, `approved` and a source in the private working copy. Only `approved:true` cards can be shown. The packager removes internal source paths from public JSON. Retain the working evidence separately.

Use short bounded matching patterns. Avoid regex lookarounds, backreferences, unbounded quantifiers and quantified groups. Broad keywords can match the wrong intent; add near-miss evaluation examples.

Match the intent, not an object noun alone. For a furniture repair service, a pattern for only "chair" can incorrectly treat "How long does chair repair take?" as answered by a list of repair services. Test the same object with unknown price, duration, guarantees and delivery conditions. If a critical near miss fails, narrow the patterns or use handoff; do not deploy that configuration merely because the component's sample tests pass.

## Static integration

Package with:

```text
python scripts/package_site.py --knowledge YOUR_APPROVED_JSON --output NEW_PACKAGE_DIRECTORY --page CURRENT_PAGE_HTML
```

The output contains `faq/`, an insertion snippet, a manifest and the patched page when provided. The original page is unchanged. A managed block is replaced idempotently; ambiguous markup and externally edited package files are rejected. The script never uploads or deletes site files.

Without `--endpoint`, the mode is local. Optional model mode requires an explicitly configured same-origin endpoint, for example `--endpoint /faq/chat.php`. Keep private configuration and storage outside the public root and validate the backend before enabling it.

The widget can also be mounted with `BoundedFaqWidget.mount({knowledgeUrl, endpoint:'', mode:'local', selector:'[data-faq-open]'})`. It remembers limited history in the current browser session. No cross-device persistence is promised.

## Routing

`BoundedFaqCore.classify(question, knowledge, context)` produces `answer`, `clarify`, `handoff` or `out_of_scope`, with up to two approved card IDs. `validateDecision` rejects unsupported IDs and invalid structures. `buildHandoff` produces plain text; `telegramUrl` encodes a draft link. The user always controls sending.

The optional `chat.php` does not run indefinitely. It accepts a bounded request, reserves configured limits, calls the classifier once and returns an allowed decision. A timeout falls back to contact rather than retrying a paid call blindly. Origin checks supplement limits and do not authenticate a public caller.

The PHP option needs PHP 8.1+ with cURL and writable private storage. Its example is disabled and contains no credentials or assumed token prices. Configure verified price ceilings and quotas before enabling it. Provider request fields were checked against the [official DeepSeek Chat Completions documentation](https://api-docs.deepseek.com/api/create-chat-completion/) on 2026-11-07; recheck them when activating the optional model.

## Acceptance

Run `node --test tests/component.test.cjs`. Evaluate project examples with `node scripts/evaluate.cjs --knowledge YOUR_JSON --cases YOUR_EVALUATION_JSON --core assets/component/faq-core.js`.

For the optional backend, run `node --test tests/backend.test.cjs` where PHP CLI is available. This checks strict decisions, private storage, UTF-8 limits, idempotency, concurrency and budget reservations without calling a model. A skipped PHP check is not evidence that the backend works on the target hosting.

An evaluation JSON is `{ "cases": [{ "question": "...", "status": "answer", "ids": ["price"], "critical": true }] }`. Contextual cases may include `{ "context": { "lastIds": ["price"] } }`. Report the total, observed accuracy and individual failures. Require all critical facts and handoff cases to pass in the selected release set.

Inspect mobile keyboard layout, close/focus behavior, purchase access, visible editable summary, copying, actual messenger destination, storage failure, disabled backend, double submission and hostile HTML. Test endpoint quotas before public model access. Separate a local preview, a hosting smoke test and a live release in the status report.
