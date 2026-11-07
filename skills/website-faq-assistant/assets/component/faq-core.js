(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoundedFaqCore = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_QUESTION = 1200;
  var STATUSES = ['answer', 'clarify', 'handoff', 'out_of_scope'];
  var ID = /^[a-z][a-z0-9_-]{0,63}$/;

  function plain(value) {
    return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '').trim() : '';
  }
  function normalize(value) {
    return plain(value).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
  }
  function fallback(source) { return {status: 'handoff', ids: [], source: source === 'server' ? 'server' : 'local'}; }
  function decision(status, ids) { return {status: status, ids: ids || [], source: 'local'}; }

  // Patterns belong to the approved configuration, never to a visitor. The
  // deliberately small regexp subset excludes unbounded/nested repetition.
  function safePattern(pattern) {
    if (typeof pattern !== 'string' || !pattern || pattern.length > 240) return null;
    if (/\(\?|\\[1-9]|\\[kKgpP]|[*+]|\)[?{]|\{[^}]*\{/.test(pattern)) return null;
    var quantifiers = pattern.match(/\{[^}]*\}/g) || [];
    if (quantifiers.some(function (q) {
      var m = /^\{(\d{1,2})(?:,(\d{1,2}))?\}$/.exec(q);
      return !m || Number(m[1]) > 60 || (m[2] !== undefined && (Number(m[2]) > 60 || Number(m[2]) < Number(m[1])));
    })) return null;
    try {
      var regexp = new RegExp(pattern.replace(/[ёЁ]/g, 'е'), 'iu');
      return regexp.test('') ? null : regexp;
    } catch (_) { return null; }
  }

  function validateKnowledge(k) {
    if (!k || typeof k !== 'object' || Array.isArray(k) || k.schemaVersion !== 1 || !Array.isArray(k.cards) || !k.cards.length || k.cards.length > 100) return false;
    if (typeof k.brand !== 'string' || !plain(k.brand) || typeof k.messages !== 'object' || !k.messages) return false;
    if (['handoff', 'out_of_scope', 'clarify', 'error'].some(function (key) { return typeof k.messages[key] !== 'string' || !plain(k.messages[key]); })) return false;
    var seen = Object.create(null);
    return k.cards.every(function (card) {
      if (!card || typeof card !== 'object' || Array.isArray(card) || typeof card.id !== 'string' || !ID.test(card.id) || seen[card.id]) return false;
      seen[card.id] = true;
      if (typeof card.approved !== 'boolean' || typeof card.title !== 'string' || !plain(card.title) || typeof card.answer !== 'string' || !plain(card.answer)) return false;
      if (!Array.isArray(card.patterns) || card.patterns.length > 30 || card.patterns.some(function (p) { return !safePattern(p); })) return false;
      if (card.excludePatterns !== undefined && (!Array.isArray(card.excludePatterns) || card.excludePatterns.length > 30 || card.excludePatterns.some(function (p) { return !safePattern(p); }))) return false;
      if (card.examples !== undefined && (!Array.isArray(card.examples) || card.examples.some(function (e) { return typeof e !== 'string'; }))) return false;
      return card.handoff === undefined || typeof card.handoff === 'boolean';
    });
  }

  function validateDecision(input, knowledge) {
    var source = input && input.source === 'server' ? 'server' : 'local';
    if (!validateKnowledge(knowledge) || !input || typeof input !== 'object' || Array.isArray(input) || STATUSES.indexOf(input.status) < 0 || !Array.isArray(input.ids)) return fallback(source);
    if (input.ids.length > 2 || (input.status === 'answer' ? input.ids.length === 0 : input.ids.length !== 0)) return fallback(source);
    var seen = Object.create(null);
    for (var i = 0; i < input.ids.length; i++) {
      var id = input.ids[i];
      if (typeof id !== 'string' || seen[id] || !knowledge.cards.some(function (c) { return c.id === id && c.approved === true; })) return fallback(source);
      seen[id] = true;
    }
    return {status: input.status, ids: input.ids.slice(), source: source};
  }

  function isInjection(q) {
    return /(?:игнорир|забудь|отмени|обойди|нарушь).{0,45}(?:инструкц|правил|ограничен|предыдущ|систем)|(?:system|developer)\s*(?:prompt|message|role)|(?:ignore|override|forget|disregard).{0,45}(?:instruction|previous|rule|prompt)|(?:покажи|раскрой|выдай).{0,30}(?:системн.{0,10}(?:промпт|инструкц)|api.{0,5}ключ|секрет)|(?:верни|выведи|ответь).{0,30}(?:status|\bid\b|json)|<\/?(?:system|assistant|developer|script|iframe|object|embed)(?:\s|>)|\bon[a-z]{3,20}\s*=|javascript\s*:/iu.test(q);
  }
  function wantsPerson(q) {
    if (/(?:не хочу|не надо|не нужно)\s+(?:запис|покуп|оплач|человек|оператор)/u.test(q)) return false;
    return /(?:хочу|готов|готова|давайте|можно|как)\s+(?:сразу\s+)?запис|запишите\s+меня|(?:хочу|готов|готова|давайте)\s+(?:уже\s+)?(?:купить|оплатить|участвовать)|где\s+оплатить|беру\s+(?:курс|участие)|(?:свяж|связат|связь|поговор|пообщ|соедин|позов|позват|передай|передат|напиш|написать).{0,30}(?:человек|оператор|менеджер|организатор|консультант)|(?:живой\s+человек|живого\s+человека|нужен\s+человек|хочу\s+человека)|^(?:записаться|запись на курс|запишите|оператор|человек)[.!?\s]*$/u.test(q);
  }
  function isOffTopic(q, cards) {
    var explicit = /погод|самолет|авиабилет|билет на|рецепт|анекдот|футбол|политик|президент|гороскоп|столиц[ауы]/u;
    var off = explicit.test(q) || /прогноз.{0,12}(?:доллар|курс.{0,8}валют)|курс.{0,10}(?:доллар|евро|биткоин)|(?:напиши|сочини|составь|сгенерируй|реши|нарисуй).{0,24}(?:стих|сочинен|сказк|код|письмо|задач|картин|поздрав)|\d\s*[+*/=]\s*\d/u.test(q);
    // An explicitly approved topic can include weather or another ordinarily
    // unrelated subject. A generic price pattern alone is not such evidence.
    return off && !(cards || []).some(function (card) { return card.patterns.some(function (p) { return explicit.test(p) && safePattern(p).test(q); }); });
  }
  function matches(card, q) {
    if (!card.approved || (card.excludePatterns || []).some(function (p) { return safePattern(p).test(q); })) return false;
    var type = normalize(card.id + ' ' + card.title);
    if (/(?:price|cost|стоим|цен[аы])/u.test(type) && !/(?:^|[^а-яa-z0-9_])(?:стоим|сколько.{0,18}стоит|цен[аыуе]|тариф|денег|дорого|дешево|оплат|предоплат|брон|остаток|\d[\d ]{2,8}|cost|price|pricing|how much|expens|cheap)/u.test(q)) return false;
    if (/(?:schedule|date|start|расписан|старт|даты)/u.test(type) && !/(?:дата|дату|даты|старт|начал|расписан|врем|час|числ|день|дни|дня|суббот|воскресен|понедель|вторник|сред[ау]|четверг|пятниц|длительн|во сколько|(?:сколько|пять|шесть|семь|восемь|девять|десять|\d).{0,25}(?:занят|встреч)|когда.{0,24}(?:начн|занят|курс|обуч|урок)|date|schedule|start|time|when.{0,24}(?:course|lesson|begin|start))/u.test(q)) return false;
    return card.patterns.some(function (p) { return safePattern(p).test(q); });
  }
  function significant(q) {
    var s = q.replace(/(?:^|\s)(?:здравствуйте|привет|спасибо|пожалуйста|подскажите|скажите|хочу узнать)(?=\s|$)/gu, ' ').trim();
    return s.length > 2 && !/^(?:я|мы|у меня|мой|моя|мое|не хочу записываться|не хочу покупать)(?:\s|$)/u.test(s);
  }

  function classify(question, knowledge, context) {
    if (!validateKnowledge(knowledge)) return fallback();
    if (typeof question !== 'string') return decision('clarify');
    var q = normalize(question);
    if (question.length > MAX_QUESTION) return fallback();
    if (isInjection(q)) return fallback();
    if (wantsPerson(q)) return fallback();
    if (!q || !/[\p{L}\p{N}]/u.test(q) || q.length < 3 || /^(?:да|нет|ок|ага|это|как|что|когда|сколько|а если|почему|зачем|подробнее)[.!?\s]*$/u.test(q)) {
      if (!/подробнее/u.test(q)) return decision('clarify');
    }
    var cards = knowledge.cards.filter(function (c) { return matches(c, q); });
    if (!cards.length && q.length < 85 && /^(?:а\s+)?(?:подробнее|расскажите подробнее|можно подробнее|поясните|объясните подробнее|что это значит|уточните|повторите)(?:[.!?\s]*)$/u.test(q)) {
      var last = context && Array.isArray(context.lastIds) ? context.lastIds : [];
      return validateDecision(decision(last.length ? 'answer' : 'clarify', last.slice(0, 2)), knowledge);
    }
    var clauses = q.split(/[?;!\n]+|\.(?:\s+|$)|\s+(?:а также|и еще|а еще|а|и|но)\s+/u).map(function (c) { return c.trim(); }).filter(significant);
    if (cards.length && clauses.length > 1 && clauses.some(function (c) { return !knowledge.cards.some(function (card) { return matches(card, c); }); })) return fallback();
    if (cards.length > 2) return fallback();
    if (isOffTopic(q, cards)) return decision('out_of_scope');
    if (cards.length) return decision('answer', cards.map(function (c) { return c.id; }));
    if (q.length < 9 || /^(?:привет|здравствуйте|добрый день|помогите|подскажите|есть вопрос|спасибо|какой курс|а это как|что за курс)[.!?\s]*$/u.test(q)) return decision('clarify');
    return fallback();
  }

  function createCode() {
    var bytes = new Uint8Array(6);
    if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
    else if (typeof require === 'function') {
      try { bytes.set(require('node:crypto').randomBytes(6)); } catch (_) { return ''; }
    } else return '';
    return Array.prototype.map.call(bytes, function (v) { return v.toString(16).padStart(2, '0'); }).join('').toUpperCase();
  }
  function excerpt(s, limit) {
    var t = plain(s).replace(/\s+/g, ' ');
    var chars = Array.from(t);
    return chars.length > limit ? chars.slice(0, limit - 1).join('').trim() + '…' : t;
  }
  function buildHandoff(knowledge, history, code, intent) {
    if (!validateKnowledge(knowledge)) return '';
    var reference = typeof code === 'string' && /^[a-z0-9-]{4,24}$/i.test(code) ? code.toUpperCase() : createCode();
    var configuredLead = intent === 'enroll' ? knowledge.enrollLead : knowledge.handoffLead;
    var lead = plain(configuredLead) || (intent === 'enroll' ? 'хочу обсудить заказ.' : 'вопрос специалисту.');
    var lines = [knowledge.brand + ': ' + excerpt(lead, 160)];
    if (reference) lines.push('Код обращения: ' + reference);
    if (intent === 'enroll' && typeof knowledge.enrollText === 'string' && plain(knowledge.enrollText)) lines.push(excerpt(knowledge.enrollText, 220));
    var turns = Array.isArray(history) ? history.slice(-12) : [];
    var questions = turns.filter(function (t) { return t && t.role === 'user' && plain(t.text); }).slice(-3);
    if (questions.length) lines.push('Мои вопросы:\n' + questions.map(function (t) { return '• ' + excerpt(t.text, 200); }).join('\n'));
    var ids = [];
    turns.forEach(function (t) {
      if (!t || t.role !== 'assistant' || !Array.isArray(t.ids)) return;
      t.ids.forEach(function (id) { if (ids.indexOf(id) < 0 && knowledge.cards.some(function (c) { return c.id === id && c.approved; })) ids.push(id); });
    });
    if (ids.length) lines.push('Открытые темы: ' + ids.slice(-4).map(function (id) { return excerpt(knowledge.cards.find(function (c) { return c.id === id; }).title, 60); }).join(', ') + '.');
    return lines.join('\n\n').slice(0, 1300);
  }
  function telegramUrl(username, draftText) {
    if (typeof username !== 'string' || typeof draftText !== 'string') return '';
    var name = username.replace(/^@/, '');
    if (!/^[a-z][a-z0-9_]{4,31}$/i.test(name) || /^(?:your_telegram|your_username|username|example|telegram|replace_me)$/i.test(name)) return '';
    try { return 'https://t.me/' + name + '?text=' + encodeURIComponent(Array.from(draftText).slice(0, 2000).join('')); } catch (_) { return ''; }
  }

  return Object.freeze({classify: classify, validateDecision: validateDecision, validateKnowledge: validateKnowledge, buildHandoff: buildHandoff, telegramUrl: telegramUrl, createCode: createCode, MAX_QUESTION: MAX_QUESTION});
}));
