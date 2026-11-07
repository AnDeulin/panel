(function (global) {
  'use strict';

  if (global.BoundedFaqWidget && typeof global.BoundedFaqWidget.mount === 'function') return;

  var ownScript = document.currentScript;
  var instance = null;
  var MAX_INPUT = 1000;
  var MAX_HISTORY = 24;
  var MAX_HISTORY_CHARS = 12000;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className, action) {
    var node = el('button', 'wfq-button ' + (className || ''), label);
    node.type = 'button';
    if (action) node.addEventListener('click', action);
    return node;
  }

  function sameOriginUrl(value) {
    try {
      var url = new URL(value, document.baseURI);
      if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) return '';
      if (url.username || url.password) return '';
      return url.href;
    } catch (_) { return ''; }
  }

  function limitedHistory(items) {
    if (!Array.isArray(items)) return [];
    var total = 0;
    var safe = [];
    items.slice(-MAX_HISTORY).reverse().some(function (item) {
      if (!item || !['user', 'assistant'].includes(item.role) || typeof item.text !== 'string') return false;
      var text = item.text.slice(0, 2400);
      if (total + text.length > MAX_HISTORY_CHARS) return true;
      total += text.length;
      safe.unshift({ role: item.role, text: text, ids: Array.isArray(item.ids) ? item.ids.filter(function (id) {
        return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
      }).slice(0, 2) : [] });
      return false;
    });
    return safe;
  }

  function mount(options) {
    if (instance) return instance;
    var config = options || {};
    var knowledgeUrl = sameOriginUrl(config.knowledgeUrl || 'knowledge.json');
    var endpoint = config.mode === 'remote' ? sameOriginUrl(config.endpoint || '') : '';
    var remote = config.mode === 'remote' && !!config.endpoint && !!endpoint;
    var selector = config.selector || '[data-faq-open]';
    var timeoutMs = Math.min(15000, Math.max(1000, Number(config.timeoutMs) || 8000));
    var knowledge = null;
    var loadPromise = null;
    var history = [];
    var lastIds = [];
    var storageKey = '';
    var storageWorking = true;
    var busy = false;
    var sequence = 0;
    var controller = null;
    var previousFocus = null;
    var openState = false;
    var destroyed = false;
    var pendingIntent = '';
    var draftCode = '';
    var draftIntent = '';
    var obstacleFrame = 0;
    var obstacleObserver = null;
    var root = el('div', 'wfq-root');
    var launcher = button('Задать вопрос', 'wfq-launcher', function () { open(); });
    var dialog = el('dialog', 'wfq-dialog');
    dialog.id = 'wfq-dialog';
    dialog.setAttribute('aria-labelledby', 'wfq-title');
    dialog.setAttribute('aria-describedby', 'wfq-description');
    launcher.setAttribute('aria-controls', dialog.id);
    launcher.setAttribute('aria-haspopup', 'dialog');
    launcher.setAttribute('aria-expanded', 'false');
    var header = el('div', 'wfq-header');
    var headingGroup = el('div', 'wfq-heading-group');
    var brand = el('p', 'wfq-eyebrow', 'Вопросы и ответы');
    var title = el('h2', 'wfq-title', 'Помощник');
    title.id = 'wfq-title';
    var closeButton = button('×', 'wfq-close', close);
    closeButton.setAttribute('aria-label', 'Закрыть помощника');
    headingGroup.append(brand, title);
    header.append(headingGroup, closeButton);
    var actions = el('div', 'wfq-actions');
    var enrollButton = button('Записаться', 'wfq-primary', function () { handoff('enroll'); });
    var humanButton = button('Написать организатору', 'wfq-secondary', function () { handoff('question'); });
    actions.append(enrollButton, humanButton);
    var chatView = el('div', 'wfq-chat-view');
    var scroll = el('div', 'wfq-scroll');
    var intro = el('p', 'wfq-intro', 'Загружаем готовые ответы…');
    intro.id = 'wfq-description';
    var log = el('div', 'wfq-log');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    log.setAttribute('aria-relevant', 'additions');
    log.setAttribute('aria-label', 'История вопросов и ответов');
    var topicsSection = el('section', 'wfq-topics-section');
    var topicsTitle = el('h3', 'wfq-topics-title', 'Готовые темы');
    var topics = el('div', 'wfq-topics');
    topicsSection.append(topicsTitle, topics);
    var clearButton = button('Очистить историю', 'wfq-text-button', clearHistory);
    clearButton.hidden = true;
    scroll.append(intro, log, topicsSection, clearButton);
    var composer = el('form', 'wfq-composer');
    var inputLabel = el('label', 'wfq-input-label', 'Ваш вопрос');
    inputLabel.htmlFor = 'wfq-question';
    var inputRow = el('div', 'wfq-input-row');
    var input = el('textarea', 'wfq-input');
    input.id = 'wfq-question';
    input.name = 'question';
    input.rows = 2;
    input.maxLength = MAX_INPUT;
    input.placeholder = 'Что вы хотите уточнить?';
    input.setAttribute('aria-describedby', 'wfq-mode-note wfq-input-help');
    var sendButton = el('button', 'wfq-button wfq-primary wfq-send', 'Отправить');
    sendButton.type = 'submit';
    inputRow.append(input, sendButton);
    var inputHelp = el('p', 'wfq-small wfq-input-help', 'Enter: отправить · Shift + Enter: новая строка');
    inputHelp.id = 'wfq-input-help';
    var status = el('p', 'wfq-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    composer.append(inputLabel, inputRow, inputHelp, status);
    chatView.append(scroll, composer);
    var preview = el('div', 'wfq-preview');
    preview.hidden = true;
    var previewHeading = el('h3', 'wfq-preview-title', 'Сообщение организатору');
    previewHeading.tabIndex = -1;
    var previewExplanation = el('p', 'wfq-preview-explanation', 'Проверьте и при необходимости измените текст. Затем откройте Telegram и отправьте сообщение сами.');
    var summaryLabel = el('label', 'wfq-input-label', 'Текст сообщения');
    summaryLabel.htmlFor = 'wfq-summary';
    var summary = el('textarea', 'wfq-summary');
    summary.id = 'wfq-summary';
    summary.rows = 7;
    summary.maxLength = 2000;
    var previewActions = el('div', 'wfq-preview-actions');
    var telegramLink = el('a', 'wfq-button wfq-primary wfq-telegram', 'Открыть Telegram');
    telegramLink.target = '_blank';
    telegramLink.rel = 'noopener noreferrer';
    telegramLink.setAttribute('aria-disabled', 'true');
    var copyButton = button('Скопировать текст', 'wfq-secondary', copySummary);
    var backButton = button('Вернуться к вопросам', 'wfq-text-button', backToChat);
    var previewStatus = el('p', 'wfq-status');
    previewStatus.setAttribute('role', 'status');
    previewActions.append(telegramLink, copyButton);
    preview.append(previewHeading, previewExplanation, summaryLabel, summary, previewActions, previewStatus, backButton);
    var footer = el('div', 'wfq-footer');
    var modeNote = el('p', 'wfq-small wfq-mode-note', remote ? 'Вопрос отправляется на сервер для подбора готового ответа. Не пишите личные и платёжные данные.' : 'Готовые ответы подбираются в браузере. Вопросы не отправляются на сервер.');
    modeNote.id = 'wfq-mode-note';
    var privacy = el('a', 'wfq-privacy', 'Обработка данных');
    privacy.hidden = true;
    footer.append(modeNote, privacy);
    dialog.append(header, actions, chatView, preview, footer);
    root.append(launcher, dialog);
    document.body.append(root);

    function event(type, code, ids) {
      var detail = { type: type };
      if (code) detail.code = String(code).slice(0, 80);
      if (ids && ids.length) detail.ids = ids.filter(function (id) { return /^[a-zA-Z0-9_-]{1,80}$/.test(id); }).slice(0, 2);
      root.dispatchEvent(new CustomEvent('bounded-faq:event', { bubbles: true, detail: detail }));
    }

    function core() {
      if (!global.BoundedFaqCore) throw new Error('core_unavailable');
      return global.BoundedFaqCore;
    }

    function getCards() {
      return knowledge ? knowledge.cards.filter(function (card) { return card.approved === true; }) : [];
    }

    function saveHistory() {
      history = limitedHistory(history);
      if (!storageWorking || !storageKey) return;
      try { sessionStorage.setItem(storageKey, JSON.stringify(history)); }
      catch (_) { storageWorking = false; }
    }

    function renderMessage(item) {
      var article = el('div', 'wfq-message wfq-message-' + item.role);
      var name = el('span', 'wfq-message-name', item.role === 'user' ? 'Вы' : (knowledge.assistantName || 'Помощник'));
      var text = el('p', 'wfq-message-text', item.text);
      article.append(name, text);
      if (item.role === 'assistant' && getCards().some(function (card) { return card.handoff && item.ids.includes(card.id); })) {
        article.append(button(knowledge.handoffCta || 'Уточнить у организатора', 'wfq-secondary wfq-message-cta', function () { showPreview('question', 'card_handoff'); }));
      }
      log.append(article);
    }

    function addMessage(role, text, ids) {
      if (!text) return;
      var item = { role: role, text: String(text).slice(0, 2400), ids: ids || [] };
      history.push(item);
      saveHistory();
      log.replaceChildren();
      history.forEach(renderMessage);
      clearButton.hidden = !history.length;
      scroll.scrollTop = Math.max(0, intro.offsetHeight + log.offsetHeight + 34 - scroll.clientHeight);
    }

    function clearHistory() {
      cancelRequest();
      history = [];
      lastIds = [];
      saveHistory();
      log.replaceChildren();
      clearButton.hidden = true;
      input.value = '';
      summary.value = '';
      backToChat();
      status.textContent = 'История этой вкладки очищена.';
      event('history_clear');
    }

    function loadKnowledge() {
      if (knowledge) return Promise.resolve(knowledge);
      if (loadPromise) return loadPromise;
      if (!knowledgeUrl) return Promise.reject(new Error('invalid_knowledge_url'));
      var loadController = new AbortController();
      var timer = setTimeout(function () { loadController.abort(); }, timeoutMs);
      loadPromise = fetch(knowledgeUrl, { credentials: 'same-origin', signal: loadController.signal, cache: 'no-cache' }).then(function (response) {
        if (!response.ok) throw new Error('knowledge_unavailable');
        return response.json();
      }).then(function (data) {
        if (!data || data.schemaVersion !== 1 || typeof data.brand !== 'string' || typeof data.greeting !== 'string' || !Array.isArray(data.cards) || !core().validateKnowledge(data)) throw new Error('invalid_knowledge');
        data.cards = data.cards.filter(function (card) {
          return card && card.approved === true && /^[a-zA-Z0-9_-]{1,80}$/.test(card.id) && typeof card.title === 'string' && typeof card.answer === 'string';
        });
        knowledge = data;
        brand.textContent = data.brand;
        title.textContent = data.assistantName || 'Помощник';
        intro.textContent = data.greeting;
        launcher.textContent = typeof data.launcherLabel === 'string' && data.launcherLabel.trim() ? data.launcherLabel : 'Задать вопрос';
        inputLabel.textContent = typeof data.questionLabel === 'string' && data.questionLabel.trim() ? data.questionLabel : 'Ваш вопрос';
        input.placeholder = typeof data.questionPlaceholder === 'string' && data.questionPlaceholder.trim() ? data.questionPlaceholder : 'Что вы хотите уточнить?';
        enrollButton.textContent = data.enrollLabel || 'Записаться';
        humanButton.textContent = data.humanLabel || 'Написать организатору';
        var policyUrl = sameOriginUrl(data.privacyUrl || '');
        if (data.privacyUrl && policyUrl) { privacy.href = policyUrl; privacy.hidden = false; }
        storageKey = 'wfq:session:v1:' + new URL(knowledgeUrl).pathname + ':' + data.brand + ':' + (data.version || '1');
        try { history = limitedHistory(JSON.parse(sessionStorage.getItem(storageKey) || '[]')); }
        catch (_) { storageWorking = false; history = []; }
        history.forEach(renderMessage);
        lastIds = history.reduce(function (ids, item) { return item.role === 'assistant' && item.ids.length ? item.ids : ids; }, []);
        clearButton.hidden = !history.length;
        renderTopics();
        event('knowledge_ready', remote ? 'remote' : 'local');
        return data;
      }).catch(function (error) {
        loadPromise = null;
        intro.textContent = 'Готовые ответы пока не загрузились. Попробуйте открыть помощника ещё раз.';
        status.textContent = 'Проверьте подключение к сайту.';
        event('error', 'knowledge_unavailable');
        throw error;
      }).finally(function () { clearTimeout(timer); });
      return loadPromise;
    }

    function renderTopics() {
      topics.replaceChildren();
      var cards = getCards();
      var suggested = Array.isArray(knowledge.suggestedIds) ? knowledge.suggestedIds : [];
      cards.sort(function (a, b) {
        var ai = suggested.indexOf(a.id), bi = suggested.indexOf(b.id);
        return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      });
      var primary = cards.filter(function (card) { return suggested.includes(card.id); }).slice(0, 4);
      if (!primary.length) primary = cards.slice(0, 3);
      var extraCards = cards.filter(function (card) { return !primary.includes(card); });
      var extraTopics = el('div', 'wfq-topics wfq-extra-topics');
      function topicButton(card, parent) {
        var node = button(card.title, 'wfq-topic', function () {
          if (busy) return;
          addMessage('user', card.title);
          showDecision({ status: 'answer', ids: [card.id], source: 'local' });
        });
        node.dataset.topic = card.id;
        parent.append(node);
      }
      primary.forEach(function (card) { topicButton(card, topics); });
      if (extraCards.length) {
        var disclosure = el('details', 'wfq-all-topics');
        var disclosureTitle = el('summary', 'wfq-all-topics-title', 'Ещё темы (' + extraCards.length + ')');
        extraCards.forEach(function (card) { topicButton(card, extraTopics); });
        disclosure.append(disclosureTitle, extraTopics);
        topics.append(disclosure);
      }
    }

    function setBusy(value) {
      busy = value;
      sendButton.disabled = value;
      input.readOnly = value;
      topics.querySelectorAll('button').forEach(function (node) { node.disabled = value; });
      composer.setAttribute('aria-busy', String(value));
      sendButton.textContent = value ? 'Подбираем…' : 'Отправить';
    }

    function cancelRequest() {
      sequence += 1;
      if (controller) controller.abort();
      controller = null;
      setBusy(false);
      status.textContent = '';
    }

    function fallbackMessage(key, fallback) {
      return knowledge && knowledge.messages && typeof knowledge.messages[key] === 'string' ? knowledge.messages[key] : fallback;
    }

    function showDecision(raw, question) {
      var decision = core().validateDecision(raw, knowledge);
      if (!decision || !['answer', 'clarify', 'handoff', 'out_of_scope'].includes(decision.status)) decision = { status: 'handoff', ids: [] };
      var cards = getCards().filter(function (card) { return Array.isArray(decision.ids) && decision.ids.includes(card.id); }).slice(0, 2);
      if (decision.status === 'answer' && cards.length) {
        lastIds = cards.map(function (card) { return card.id; });
        addMessage('assistant', cards.map(function (card) { return card.answer; }).join('\n\n'), lastIds);
        event('answer', decision.source === 'server' ? 'server' : 'local', lastIds);
      } else if (decision.status === 'clarify') {
        addMessage('assistant', fallbackMessage('clarify', 'Уточните, пожалуйста, ваш вопрос.'));
        event('clarify');
      } else if (decision.status === 'out_of_scope') {
        addMessage('assistant', fallbackMessage('out_of_scope', 'Выберите одну из готовых тем или напишите организатору.'));
        event('out_of_scope');
      } else {
        addMessage('assistant', fallbackMessage('handoff', 'Подтверждённого ответа пока нет. Можно уточнить у организатора.'));
        var enrollIntent = typeof question === 'string' && !/(?:не хочу|не надо|не нужно)\s+(?:запис|покуп|оплач)/iu.test(question) && /(?:хочу|готов[аы]?|давайте|можно|как)\s+(?:сразу\s+)?(?:запис|купить|оплатить)|запишите\s+меня|^записаться[.!?\s]*$/iu.test(question);
        showPreview(enrollIntent ? 'enroll' : 'question', enrollIntent ? 'enroll' : 'unknown');
        event('handoff', 'unknown');
      }
    }

    async function submit(eventObject) {
      if (eventObject) eventObject.preventDefault();
      if (busy || !knowledge || destroyed) return;
      var question = input.value.trim();
      if (!question) { status.textContent = 'Напишите вопрос или выберите готовую тему.'; input.focus(); return; }
      if (question.length > MAX_INPUT) { status.textContent = 'Сократите вопрос до ' + MAX_INPUT + ' знаков.'; return; }
      var requestSequence = ++sequence;
      var requestId = global.crypto && typeof global.crypto.randomUUID === 'function' ? global.crypto.randomUUID() : 'wfq-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      var previousHistory = history.slice(-8);
      addMessage('user', question);
      input.value = '';
      setBusy(true);
      status.textContent = remote ? 'Подбираем готовый ответ…' : '';
      var timer = null;
      try {
        var decision;
        if (remote) {
          controller = new AbortController();
          var requestController = controller;
          var timeout = new Promise(function (_, reject) {
            timer = setTimeout(function () { requestController.abort(); reject(new Error('request_timeout')); }, timeoutMs);
          });
          var request = fetch(endpoint, {
            method: 'POST', credentials: 'same-origin', signal: requestController.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: question, requestId: requestId, lastIds: lastIds.slice(0, 2), history: previousHistory })
          }).then(function (response) { if (!response.ok) throw new Error('endpoint_unavailable'); return response.json(); });
          decision = await Promise.race([request, timeout]);
        } else {
          decision = core().classify(question, knowledge, { lastIds: lastIds.slice(), history: previousHistory });
        }
        if (requestSequence !== sequence || destroyed) return;
        status.textContent = '';
        showDecision(decision, question);
      } catch (_) {
        if (requestSequence !== sequence || destroyed) return;
        addMessage('assistant', fallbackMessage('error', 'Можно открыть готовые темы или написать организатору.'));
        status.textContent = 'Ответ не получен. Повторного запроса нет.';
        event('error', remote ? 'endpoint_unavailable' : 'local_unavailable');
        showPreview('question', 'unavailable');
        previewStatus.textContent = fallbackMessage('error', 'Можно вернуться к готовым темам или написать организатору.');
        backButton.textContent = 'Вернуться к готовым темам';
      } finally {
        if (timer) clearTimeout(timer);
        if (requestSequence === sequence) { controller = null; setBusy(false); }
      }
    }

    function safeTelegramUrl(text) {
      try {
        var value = core().telegramUrl(knowledge.telegramUsername, text);
        var url = new URL(value);
        if (url.protocol !== 'https:' || url.hostname !== 't.me' || url.port || url.username || url.password) return '';
        if (url.pathname !== '/' + knowledge.telegramUsername.replace(/^@/, '')) return '';
        return url.href;
      } catch (_) { return ''; }
    }

    function updateTelegramLink() {
      var url = knowledge && !preview.hidden && summary.value.trim() ? safeTelegramUrl(summary.value.trim()) : '';
      if (url) {
        telegramLink.href = url;
        telegramLink.setAttribute('aria-disabled', 'false');
      } else {
        telegramLink.removeAttribute('href');
        telegramLink.setAttribute('aria-disabled', 'true');
      }
    }

    function showPreview(intent, reason) {
      cancelRequest();
      draftIntent = intent;
      draftCode = reason || (intent === 'enroll' ? 'enroll' : 'human');
      var draft;
      try { draft = core().buildHandoff(knowledge, history, core().createCode(), intent); }
      catch (_) { draft = intent === 'enroll' ? knowledge.enrollText : 'Здравствуйте! У меня вопрос по «' + knowledge.brand + '».'; }
      summary.value = String(draft || knowledge.enrollText || '').slice(0, 2000);
      previewStatus.textContent = '';
      backButton.textContent = 'Вернуться к вопросам';
      var explanation = 'Проверьте и при необходимости измените текст. Затем откройте Telegram и отправьте сообщение сами.';
      if (reason === 'unknown') explanation = fallbackMessage('handoff', 'Подтверждённого ответа пока нет.') + ' ' + explanation;
      if (reason === 'unavailable') explanation = fallbackMessage('error', 'Готовый ответ сейчас недоступен.') + ' ' + explanation;
      previewExplanation.textContent = explanation;
      previewHeading.textContent = intent === 'enroll' ? (knowledge.enrollLabel || 'Запись') : (knowledge.handoffTitle || 'Сообщение организатору');
      chatView.hidden = true;
      preview.hidden = false;
      updateTelegramLink();
      previewHeading.focus({ preventScroll: true });
      event('handoff_preview', draftCode);
    }

    function handoff(intent) {
      if (!knowledge) { pendingIntent = intent; open(intent); return; }
      if (!openState) open();
      showPreview(intent, intent === 'enroll' ? 'enroll' : 'human');
    }

    async function copySummary() {
      try {
        if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard_unavailable');
        await navigator.clipboard.writeText(summary.value);
        previewStatus.textContent = 'Текст скопирован. Вставьте его в Telegram и отправьте сами.';
        event('handoff_copy', draftCode);
      } catch (_) {
        summary.focus();
        summary.select();
        summary.setSelectionRange(0, summary.value.length);
        previewStatus.textContent = 'Текст выделен. Скопируйте его через меню устройства или Ctrl + C.';
      }
    }

    function backToChat() {
      preview.hidden = true;
      chatView.hidden = false;
      updateTelegramLink();
      if (openState) input.focus({ preventScroll: true });
    }

    function fitViewport() {
      scheduleObstacles();
      if (!openState) return;
      var viewport = global.visualViewport;
      var height = viewport ? viewport.height : global.innerHeight;
      root.classList.toggle('wfq-compact', height < 540);
      root.style.setProperty('--wfq-viewport-height', height + 'px');
      root.style.setProperty('--wfq-viewport-top', (viewport ? viewport.offsetTop : 0) + 'px');
      root.style.setProperty('--wfq-dialog-top', ((viewport ? viewport.offsetTop : 0) + Math.max(20, height - 760)) + 'px');
    }

    function fitObstacles() {
      obstacleFrame = 0;
      if (destroyed) return;
      var width = global.innerWidth;
      var height = global.innerHeight;
      var launcherWidth = launcher.getBoundingClientRect().width || 220;
      var bottom = 0;
      document.querySelectorAll('.dock, .cookie, [data-faq-avoid]').forEach(function (node) {
        if (root.contains(node)) return;
        var rect = node.getBoundingClientRect();
        var position = getComputedStyle(node).position;
        if (!rect.width || !rect.height || !['fixed', 'sticky'].includes(position)) return;
        if (rect.right > width - launcherWidth - 32 && rect.left < width - 16 && rect.bottom >= height - 240 && rect.top > height * 0.25) bottom = Math.max(bottom, height - rect.top + 12);
      });
      var value = bottom + 'px';
      if (root.style.getPropertyValue('--wfq-obstacle-bottom') !== value) root.style.setProperty('--wfq-obstacle-bottom', value);
    }

    function scheduleObstacles() {
      if (!obstacleFrame && !destroyed) obstacleFrame = requestAnimationFrame(fitObstacles);
    }

    async function open(intent) {
      if (destroyed) return;
      if (!openState) {
        previousFocus = document.activeElement;
        openState = true;
        launcher.setAttribute('aria-expanded', 'true');
        root.classList.add('wfq-open');
        fitViewport();
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else { dialog.setAttribute('open', ''); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); }
        closeButton.focus({ preventScroll: true });
        event('open');
      }
      if (intent) pendingIntent = intent;
      try {
        await loadKnowledge();
        if (!openState || destroyed) return;
        if (pendingIntent) { var nextIntent = pendingIntent; pendingIntent = ''; showPreview(nextIntent, nextIntent === 'enroll' ? 'enroll' : 'human'); }
      } catch (_) { /* Loading failure is shown inside the dialog. */ }
    }

    function close() {
      if (!openState) return;
      openState = false;
      pendingIntent = '';
      cancelRequest();
      launcher.setAttribute('aria-expanded', 'false');
      root.classList.remove('wfq-open');
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else dialog.removeAttribute('open');
      if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus({ preventScroll: true });
      else launcher.focus({ preventScroll: true });
      event('close');
    }

    function handleTriggers(eventObject) {
      if (!(eventObject.target instanceof Element)) return;
      var trigger;
      try { trigger = eventObject.target.closest(selector); } catch (_) { return; }
      if (!trigger || root.contains(trigger)) return;
      eventObject.preventDefault();
      var intent = trigger.dataset.faqIntent === 'enroll' ? 'enroll' : trigger.dataset.faqIntent === 'human' ? 'question' : '';
      if (!intent) { pendingIntent = ''; backToChat(); }
      open(intent);
    }

    function trapFocus(eventObject) {
      if (!openState) return;
      if (eventObject.key === 'Escape') { eventObject.preventDefault(); close(); return; }
      if (eventObject.key !== 'Tab') return;
      var focusable = Array.from(dialog.querySelectorAll('button:not([disabled]), a[href], textarea:not([disabled]), input:not([disabled]), summary, [tabindex="0"]')).filter(function (node) { return !node.closest('[hidden]') && node.getClientRects().length; });
      if (!focusable.length) { eventObject.preventDefault(); closeButton.focus(); return; }
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (eventObject.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { eventObject.preventDefault(); last.focus(); }
      else if (!eventObject.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { eventObject.preventDefault(); first.focus(); }
    }

    composer.addEventListener('submit', submit);
    input.addEventListener('keydown', function (eventObject) {
      if (eventObject.key === 'Enter' && !eventObject.shiftKey && !eventObject.isComposing) { eventObject.preventDefault(); submit(); }
    });
    summary.addEventListener('input', function () { updateTelegramLink(); previewStatus.textContent = ''; });
    telegramLink.addEventListener('click', function (eventObject) {
      if (!telegramLink.getAttribute('href')) { eventObject.preventDefault(); previewStatus.textContent = 'Введите текст сообщения. Его можно скопировать и отправить организатору.'; return; }
      event('telegram_open', draftIntent === 'enroll' ? 'enroll' : draftCode);
      previewStatus.textContent = 'Открывается Telegram. Сообщение ещё нужно отправить в чате.';
    });
    dialog.addEventListener('cancel', function (eventObject) { eventObject.preventDefault(); close(); });
    dialog.addEventListener('close', function () { if (openState) close(); });
    document.addEventListener('click', handleTriggers);
    document.addEventListener('keydown', trapFocus);
    global.addEventListener('resize', fitViewport);
    if (global.visualViewport) { global.visualViewport.addEventListener('resize', fitViewport); global.visualViewport.addEventListener('scroll', fitViewport); }
    if (global.MutationObserver) {
      obstacleObserver = new MutationObserver(function (records) { if (records.some(function (record) { return !root.contains(record.target); })) scheduleObstacles(); });
      obstacleObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    }
    scheduleObstacles();

    instance = {
      open: open, close: close, clearHistory: clearHistory,
      destroy: function () {
        close(); destroyed = true; cancelRequest();
        document.removeEventListener('click', handleTriggers);
        document.removeEventListener('keydown', trapFocus);
        global.removeEventListener('resize', fitViewport);
        if (global.visualViewport) { global.visualViewport.removeEventListener('resize', fitViewport); global.visualViewport.removeEventListener('scroll', fitViewport); }
        if (obstacleObserver) obstacleObserver.disconnect();
        if (obstacleFrame) cancelAnimationFrame(obstacleFrame);
        root.remove(); instance = null;
      }
    };
    return instance;
  }

  global.BoundedFaqWidget = { mount: mount };
  if (ownScript && ownScript.dataset.knowledge) {
    var autoOptions = { knowledgeUrl: ownScript.dataset.knowledge, endpoint: ownScript.dataset.endpoint || '', mode: ownScript.dataset.mode || 'local', selector: ownScript.dataset.selector || '[data-faq-open]' };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mount(autoOptions); }, { once: true });
    else mount(autoOptions);
  }
}(window));
