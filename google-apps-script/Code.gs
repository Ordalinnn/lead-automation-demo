/**
 * Заявки на автопилоте: форма или сайт → ИИ-разбор → эта Google Таблица → Telegram.
 *
 * Работает внутри Google Таблицы, сервер не нужен. Настройка через меню «Заявки».
 * Адрес веб-приложения открывает форму заявки, принимает вебхуки сайтов (Tilda, WordPress и др.)
 * и нажатия кнопок в Telegram.
 */

const SHEET_NAME = 'Заявки';
const SUMMARY_SHEET = 'Сводка';
const DEFAULT_MODEL = 'claude-haiku-5-5';
const DEFAULT_REMINDER_MINUTES = 15;
const REPEAT_DAYS = 7;

// Колонки листа «Заявки» (с единицы)
const C = {
  DATE: 1, NAME: 2, PHONE: 3, EMAIL: 4, SOURCE: 5, MESSAGE: 6, CATEGORY: 7, PRIORITY: 8, SUMMARY: 9, REPLY: 10,
  STATUS: 11, OWNER: 12, TAKEN_AT: 13, REACTION: 14, REPEAT: 15, BY: 16, ID: 17, MSG_ID: 18, REMINDED: 19,
};
const HEADER = ['Дата', 'Имя', 'Телефон', 'Email', 'Источник', 'Сообщение', 'Категория', 'Приоритет', 'Суть',
  'Черновик ответа', 'Статус', 'Ответственный', 'Взята в работу', 'Реакция, мин', 'Повтор', 'Разобрано',
  'ID', 'ID сообщения', 'Напомнили'];

const CATEGORIES = ['покупка', 'консультация', 'поддержка', 'спам', 'другое'];
const PRIORITIES = ['высокий', 'средний', 'низкий'];
const PRIORITY_ICON = { 'высокий': '🔴', 'средний': '🟡', 'низкий': '⚪' };
const STATUS = { NEW: 'Новая', TAKEN: 'В работе', CONTACTED: 'Связались', DEAL: 'Сделка', LOST: 'Отказ', SPAM: 'Спам' };
const ACTIONS = {
  take: { status: STATUS.TAKEN, icon: '👤', label: 'В работе' },
  contact: { status: STATUS.CONTACTED, icon: '📞', label: 'Связались' },
  deal: { status: STATUS.DEAL, icon: '💰', label: 'Сделка' },
  lose: { status: STATUS.LOST, icon: '❌', label: 'Отказ' },
};

const props_ = () => PropertiesService.getScriptProperties();

// ================= меню =================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Заявки')
    .addItem('1. Подключить Telegram', 'setupTelegram')
    .addItem('2. Подключить Claude (необязательно)', 'setupClaude')
    .addItem('3. Включить кнопки, напоминания и отчёты', 'setupAutomation')
    .addItem('4. Отправить тестовую заявку', 'sendTestLead')
    .addSeparator()
    .addItem('Отправить отчёт сейчас', 'sendDailyReport')
    .addItem('Защитить вебхук сайта ключом', 'setupWebhookKey')
    .addItem('Изменить время напоминания', 'setupReminder')
    .addItem('Показать текущие настройки', 'showSettings')
    .addToUi();
  getSheet_();
}

function setupTelegram() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Подключить Telegram',
    'Вставьте токен бота от @BotFather.\n\nПеред этим напишите боту любое сообщение. Чтобы заявки приходили в группу ' +
    'менеджеров, добавьте бота в группу и отправьте там команду /start.', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const token = res.getResponseText().trim();
  if (!/^\d+:[\w-]{30,}$/.test(token)) {
    ui.alert('Это не похоже на токен бота. Он выглядит так: 123456789:AAE...');
    return;
  }
  // Пока у бота включён вебхук, Telegram не отдаёт сообщения через getUpdates
  tg_('deleteWebhook', {}, token);
  const chatId = findChatId_(token);
  if (!chatId) {
    ui.alert('Не нашёл переписку с ботом. Напишите боту сообщение (в группе — команду /start) и повторите этот пункт.');
    return;
  }
  props_().setProperties({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: String(chatId) });
  if (props_().getProperty('WEBAPP_URL')) setTelegramWebhook_();
  tg_('sendMessage', { chat_id: chatId, text: '✅ Бот подключён. Сюда будут приходить новые заявки.' });
  ui.alert('Готово! Бот подключён, в Telegram пришло проверочное сообщение.');
}

function setupClaude() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Подключить Claude',
    'Вставьте API-ключ с console.anthropic.com (начинается с sk-ant-).\nОставьте поле пустым, чтобы разбирать заявки по ключевым словам.',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const key = res.getResponseText().trim();
  if (!key) {
    props_().deleteProperty('ANTHROPIC_API_KEY');
    ui.alert('Ключ удалён, заявки будут разбираться по ключевым словам.');
    return;
  }
  props_().setProperty('ANTHROPIC_API_KEY', key);
  const test = classifyWithClaude_({ name: 'Тест', message: 'Сколько стоит доставка? Нужно срочно.', source: 'проверка' });
  ui.alert(test ? 'Claude подключён и отвечает.' : 'Ключ сохранён, но Claude не ответил. Проверьте ключ и баланс на console.anthropic.com.');
}

function setupAutomation() {
  const ui = SpreadsheetApp.getUi();
  if (!props_().getProperty('TELEGRAM_BOT_TOKEN')) {
    ui.alert('Сначала подключите Telegram (пункт 1).');
    return;
  }
  const guess = ScriptApp.getService().getUrl() || '';
  const res = ui.prompt('Кнопки, напоминания и отчёты',
    'Вставьте адрес веб-приложения (заканчивается на /exec).\nЕго выдаёт «Начать развертывание → Новое развертывание → Веб-приложение».' +
    (/\/exec$/.test(guess) ? '\n\nПохоже, ваш адрес:\n' + guess : ''), ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const url = res.getResponseText().trim() || guess;
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
    ui.alert('Нужен адрес вида https://script.google.com/macros/s/.../exec');
    return;
  }
  props_().setProperty('WEBAPP_URL', url);
  const hookOk = setTelegramWebhook_();

  ScriptApp.getProjectTriggers()
    .filter(t => ['checkReminders', 'sendDailyReport'].indexOf(t.getHandlerFunction()) !== -1)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkReminders').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('sendDailyReport').timeBased().everyDays(1).atHour(9).create();

  ui.alert((hookOk ? '✅ Кнопки в Telegram включены.\n' : '⚠️ Telegram не принял адрес, кнопки не работают. Проверьте, что в развертывании доступ «Все».\n') +
    '✅ Напоминание, если заявку не взяли за ' + reminderMinutes_() + ' мин.\n✅ Отчёт в Telegram каждый день в 9:00.');
}

function setupReminder() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Время напоминания', 'Через сколько минут напоминать о заявке, которую никто не взял? Сейчас: ' +
    reminderMinutes_(), ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const n = parseInt(res.getResponseText(), 10);
  if (!(n >= 5 && n <= 1440)) { ui.alert('Укажите число от 5 до 1440.'); return; }
  props_().setProperty('REMINDER_MINUTES', String(n));
  ui.alert('Готово: напоминание через ' + n + ' мин.');
}

function setupWebhookKey() {
  const key = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  props_().setProperty('WEBHOOK_KEY', key);
  SpreadsheetApp.getUi().alert('Ключ создан. Для Tilda и других сайтов добавляйте к адресу веб-приложения:\n\n?key=' + key +
    '\n\nФорма по самому адресу и кнопки Telegram продолжат работать.');
}

function showSettings() {
  const p = props_().getProperties();
  SpreadsheetApp.getUi().alert(
    'Telegram: ' + (p.TELEGRAM_BOT_TOKEN ? 'подключён, чат ' + p.TELEGRAM_CHAT_ID : 'не подключён') + '\n' +
    'Claude: ' + (p.ANTHROPIC_API_KEY ? 'подключён, модель ' + (p.CLAUDE_MODEL || DEFAULT_MODEL) : 'не подключён, разбор по ключевым словам') + '\n' +
    'Кнопки и отчёты: ' + (p.WEBAPP_URL ? 'включены' : 'не включены (пункт 3)') + '\n' +
    'Напоминание: через ' + reminderMinutes_() + ' мин\n' +
    'Ключ вебхука сайта: ' + (p.WEBHOOK_KEY ? '?key=' + p.WEBHOOK_KEY : 'не задан'));
}

function sendTestLead() {
  const r = processLead_({ name: 'Тестовый клиент', phone: '+7 701 000 00 00',
    message: 'Здравствуйте! Сколько стоит ваша услуга? Нужно срочно, сегодня.', source: 'тест из таблицы' });
  SpreadsheetApp.getUi().alert('Тестовая заявка добавлена.\nКатегория: ' + r.category + ', приоритет: ' + r.priority +
    '\nTelegram: ' + (r.notified ? 'уведомление отправлено' : 'не отправлено, подключите Telegram'));
}

// ================= веб-приложение =================

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Form')
    .setTitle('Оставить заявку')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Вызывается из формы Form.html. */
function submitForm(fields) {
  return processLead_(fields || {});
}

function doPost(e) {
  const params = (e && e.parameter) || {};
  const body = e && e.postData;
  let json = null;
  if (body && /json/.test(body.type || '')) {
    try { json = JSON.parse(body.contents); } catch (err) { json = null; }
  }

  // Нажатия кнопок и сообщения из Telegram
  if (json && json.update_id !== undefined) {
    if (params.tg !== props_().getProperty('TG_HOOK_SECRET')) return text_('forbidden');
    handleTelegramUpdate_(json);
    return text_('ok');
  }

  // Заявки с сайтов
  const required = props_().getProperty('WEBHOOK_KEY');
  if (required && params.key !== required) return text_('forbidden');
  const fields = json && typeof json === 'object' ? json : Object.assign({}, params);
  delete fields.key;

  const keys = Object.keys(fields).map(k => k.toLowerCase());
  if (keys.length === 1 && keys[0] === 'test') return text_('ok'); // проверка от Tilda

  try {
    processLead_(normalize_(fields, params.source || 'сайт'));
    return text_('ok');
  } catch (err) {
    console.error(err);
    return text_('error: ' + err.message);
  }
}

function text_(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT);
}

// ================= распознавание полей =================

const NAME_KEYS = ['name', 'имя', 'fio', 'фио', 'your-name', 'first_name', 'firstname', 'full_name', 'client_name'];
const PHONE_KEYS = ['phone', 'телефон', 'tel', 'your-phone', 'your-tel', 'phone_number', 'mobile', 'whatsapp'];
const EMAIL_KEYS = ['email', 'e-mail', 'почта', 'your-email', 'mail'];
const MESSAGE_KEYS = ['message', 'сообщение', 'comments', 'comment', 'комментарий', 'textarea', 'text', 'your-message', 'question', 'вопрос'];
const SOURCE_KEYS = ['formname', 'form_name', 'form', 'source', 'utm_source'];
const SKIP_KEYS = ['tranid', 'formid', 'cookies', 'referer', 'website', 'key', 'test', 'tg', '_wpcf7', '_wpcf7_version',
  '_wpcf7_locale', '_wpcf7_unit_tag', '_wpcf7_container_post', 'g-recaptcha-response'];

function pick_(fields, keys, used) {
  const lower = {};
  Object.keys(fields).forEach(k => { lower[k.toLowerCase().trim()] = k; });
  for (const key of keys) {
    const orig = lower[key];
    if (orig !== undefined && String(fields[orig]).trim()) {
      used[orig] = true;
      return String(fields[orig]).trim();
    }
  }
  return '';
}

function normalize_(fields, defaultSource) {
  const used = {};
  const lead = {
    name: pick_(fields, NAME_KEYS, used),
    phone: pick_(fields, PHONE_KEYS, used),
    email: pick_(fields, EMAIL_KEYS, used),
    message: pick_(fields, MESSAGE_KEYS, used),
    source: pick_(fields, SOURCE_KEYS, used) || defaultSource,
    website: String(fields.website || ''),
  };
  const extra = Object.keys(fields)
    .filter(k => !used[k] && SKIP_KEYS.indexOf(k.toLowerCase()) === -1 && String(fields[k]).trim())
    .map(k => k + ': ' + fields[k]);
  if (extra.length) lead.message = [lead.message].concat(extra).filter(Boolean).join('\n');
  return lead;
}

/** Номер для WhatsApp и поиска повторов: только цифры, 8XXXXXXXXXX → 7XXXXXXXXXX. */
function phoneDigits_(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return d.length >= 10 ? d : '';
}

// ================= обработка заявки =================

function processLead_(raw) {
  const lead = {
    name: String(raw.name || '').trim().slice(0, 100) || 'Без имени',
    phone: String(raw.phone || '').trim().slice(0, 30),
    email: String(raw.email || '').trim().slice(0, 100),
    message: String(raw.message || '').trim().slice(0, 2000),
    source: String(raw.source || 'сайт').trim().slice(0, 50),
  };
  if (String(raw.website || '').trim()) return { ok: true, category: 'спам', priority: 'низкий', notified: false }; // ловушка для ботов
  if (!lead.phone && !lead.email) throw new Error('Укажите телефон или email');

  let analysis = null, by = 'правила';
  if (props_().getProperty('ANTHROPIC_API_KEY')) {
    analysis = classifyWithClaude_(lead);
    if (analysis) by = props_().getProperty('CLAUDE_MODEL') || DEFAULT_MODEL;
  }
  if (!analysis) analysis = classifyByRules_(lead);

  const spam = analysis.category === 'спам';
  const id = Utilities.getUuid().slice(0, 8);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let row, repeat;
  try {
    const sheet = getSheet_();
    repeat = isRepeat_(sheet, lead);
    sheet.appendRow([new Date(), lead.name, lead.phone, lead.email, lead.source, lead.message,
      analysis.category, analysis.priority, analysis.summary, analysis.suggested_reply,
      spam ? STATUS.SPAM : STATUS.NEW, '', '', '', repeat ? 'да' : '', by, id, '', '']);
    row = sheet.getLastRow();
  } finally {
    lock.releaseLock();
  }

  let notified = false;
  if (!spam) {
    const msg = tg_('sendMessage', {
      chat_id: props_().getProperty('TELEGRAM_CHAT_ID'),
      text: formatMessage_(lead, analysis, repeat, ''),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard_(id, STATUS.NEW, lead.phone),
    });
    if (msg && msg.message_id) {
      getSheet_().getRange(row, C.MSG_ID).setValue(msg.message_id);
      notified = true;
    }
  }
  return { ok: true, id: id, category: analysis.category, priority: analysis.priority, repeat: repeat, notified: notified };
}

function isRepeat_(sheet, lead) {
  const last = sheet.getLastRow();
  if (last < 2) return false;
  const from = Math.max(2, last - 500);
  const rows = sheet.getRange(from, 1, last - from + 1, C.EMAIL).getValues();
  const since = Date.now() - REPEAT_DAYS * 86400000;
  const phone = phoneDigits_(lead.phone), email = lead.email.toLowerCase();
  return rows.some(r => new Date(r[C.DATE - 1]).getTime() >= since &&
    ((phone && phoneDigits_(r[C.PHONE - 1]) === phone) || (email && String(r[C.EMAIL - 1]).toLowerCase() === email)));
}

// ================= Telegram: кнопки =================

function keyboard_(id, status, phone) {
  const rows = [];
  if (status === STATUS.NEW) rows.push([{ text: '✅ Беру в работу', callback_data: 'take:' + id }]);
  if ([STATUS.NEW, STATUS.TAKEN, STATUS.CONTACTED].indexOf(status) !== -1) {
    const step = [];
    if (status !== STATUS.CONTACTED) step.push({ text: '📞 Связался', callback_data: 'contact:' + id });
    step.push({ text: '💰 Сделка', callback_data: 'deal:' + id }, { text: '❌ Отказ', callback_data: 'lose:' + id });
    rows.push(step);
  }
  const wa = phoneDigits_(phone);
  if (wa) rows.push([{ text: '💬 Написать в WhatsApp', url: 'https://wa.me/' + wa }]);
  return { inline_keyboard: rows };
}

function handleTelegramUpdate_(update) {
  // Telegram повторяет запрос, если ответ ему не понравился, поэтому каждое событие обрабатываем один раз
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const last = Number(props_().getProperty('LAST_UPDATE_ID') || 0);
    if (update.update_id <= last) return;
    props_().setProperty('LAST_UPDATE_ID', String(update.update_id));
  } finally {
    lock.releaseLock();
  }
  if (update.callback_query) handleButton_(update.callback_query);
}

function handleButton_(cq) {
  const parts = String(cq.data || '').split(':');
  const action = ACTIONS[parts[0]];
  const answer = text => tg_('answerCallbackQuery', { callback_query_id: cq.id, text: text });
  if (!action) return answer('Неизвестная кнопка');

  const sheet = getSheet_();
  const row = findRow_(sheet, parts[1]);
  if (!row) return answer('Заявка не найдена в таблице');

  const who = [cq.from && cq.from.first_name, cq.from && cq.from.last_name].filter(Boolean).join(' ') ||
    (cq.from && cq.from.username) || 'Менеджер';
  const values = sheet.getRange(row, 1, 1, HEADER.length).getValues()[0];
  const owner = String(values[C.OWNER - 1] || '');
  if (parts[0] === 'take' && values[C.STATUS - 1] !== STATUS.NEW) {
    return answer(owner ? 'Заявку уже взял ' + owner : 'Заявка уже в работе');
  }

  sheet.getRange(row, C.STATUS).setValue(action.status);
  let reaction = values[C.REACTION - 1];
  if (!owner) {
    reaction = Math.max(0, Math.round((Date.now() - new Date(values[C.DATE - 1]).getTime()) / 60000));
    sheet.getRange(row, C.OWNER, 1, 3).setValues([[who, new Date(), reaction]]);
  }

  const lead = { name: values[C.NAME - 1], phone: values[C.PHONE - 1], email: values[C.EMAIL - 1], source: values[C.SOURCE - 1] };
  const analysis = { category: values[C.CATEGORY - 1], priority: values[C.PRIORITY - 1], summary: values[C.SUMMARY - 1],
    suggested_reply: values[C.REPLY - 1] };
  const footer = action.icon + ' ' + action.label + ': ' + esc_(who) +
    (parts[0] === 'take' || !owner ? ' · реакция ' + formatMinutes_(reaction) : '');
  tg_('editMessageText', {
    chat_id: cq.message.chat.id, message_id: cq.message.message_id,
    text: formatMessage_(lead, analysis, values[C.REPEAT - 1] === 'да', footer),
    parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: keyboard_(parts[1], action.status, lead.phone),
  });
  answer('Готово: ' + action.label);
}

function findRow_(sheet, id) {
  const last = sheet.getLastRow();
  if (!id || last < 2) return 0;
  const ids = sheet.getRange(2, C.ID, last - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === id) return i + 2;
  return 0;
}

function setTelegramWebhook_() {
  const url = props_().getProperty('WEBAPP_URL');
  if (!url) return false;
  let secret = props_().getProperty('TG_HOOK_SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '');
    props_().setProperty('TG_HOOK_SECRET', secret);
  }
  const res = tg_('setWebhook', { url: url + '?tg=' + secret, allowed_updates: ['callback_query'], drop_pending_updates: true });
  return res === true;
}

// ================= напоминания и отчёт =================

function reminderMinutes_() {
  return Number(props_().getProperty('REMINDER_MINUTES') || DEFAULT_REMINDER_MINUTES);
}

/** Запускается по расписанию каждые 5 минут. */
function checkReminders() {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return;
  const from = Math.max(2, last - 300);
  const rows = sheet.getRange(from, 1, last - from + 1, HEADER.length).getValues();
  const limit = reminderMinutes_() * 60000;
  rows.forEach((r, i) => {
    if (r[C.STATUS - 1] !== STATUS.NEW || r[C.REMINDED - 1] || !r[C.MSG_ID - 1]) return;
    const waited = Date.now() - new Date(r[C.DATE - 1]).getTime();
    if (waited < limit || waited > 24 * 3600000) return;
    tg_('sendMessage', {
      chat_id: props_().getProperty('TELEGRAM_CHAT_ID'),
      text: '⏰ Заявку от <b>' + esc_(r[C.NAME - 1]) + '</b> никто не взял уже ' + formatMinutes_(Math.round(waited / 60000)) + '.',
      parse_mode: 'HTML',
      reply_parameters: { message_id: Number(r[C.MSG_ID - 1]), allow_sending_without_reply: true },
    });
    sheet.getRange(from + i, C.REMINDED).setValue('да');
  });
}

/** Запускается по расписанию каждый день в 9:00, можно вызвать из меню. */
function sendDailyReport() {
  const s = stats_(1);
  const text = ['📊 <b>Заявки за вчера</b>', '',
    'Всего: <b>' + s.total + '</b>' + (s.spam ? ' (и ' + s.spam + ' спам отсеян)' : ''),
    '🔴 Срочных: ' + s.urgent,
    '💰 Сделок: ' + s.deals,
    '⏱ Среднее время реакции: ' + (s.avgReaction === null ? 'нет данных' : formatMinutes_(s.avgReaction)),
    s.waiting ? '⚠️ Ждут ответа: <b>' + s.waiting + '</b>' : '✅ Все заявки взяты в работу',
  ];
  if (s.bySource.length) text.push('', 'Источники: ' + s.bySource.map(x => esc_(x[0]) + ' — ' + x[1]).join(', '));
  if (s.byOwner.length) text.push('Менеджеры: ' + s.byOwner.map(x => esc_(x[0]) + ' — ' + x[1]).join(', '));
  tg_('sendMessage', { chat_id: props_().getProperty('TELEGRAM_CHAT_ID'), text: text.join('\n'), parse_mode: 'HTML' });
}

/** Статистика за прошлые `days` полных дней. */
function stats_(days) {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  const end = new Date(); end.setHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - days * 86400000);
  const s = { total: 0, spam: 0, urgent: 0, deals: 0, waiting: 0, avgReaction: null, bySource: [], byOwner: [] };
  if (last < 2) return s;
  const rows = sheet.getRange(2, 1, last - 1, HEADER.length).getValues()
    .filter(r => { const t = new Date(r[C.DATE - 1]).getTime(); return t >= start.getTime() && t < end.getTime(); });
  const src = {}, own = {}, reactions = [];
  rows.forEach(r => {
    if (r[C.STATUS - 1] === STATUS.SPAM) { s.spam++; return; }
    s.total++;
    if (r[C.PRIORITY - 1] === 'высокий') s.urgent++;
    if (r[C.STATUS - 1] === STATUS.DEAL) s.deals++;
    if (r[C.STATUS - 1] === STATUS.NEW) s.waiting++;
    if (r[C.REACTION - 1] !== '' && r[C.REACTION - 1] !== null) reactions.push(Number(r[C.REACTION - 1]));
    src[r[C.SOURCE - 1]] = (src[r[C.SOURCE - 1]] || 0) + 1;
    if (r[C.OWNER - 1]) own[r[C.OWNER - 1]] = (own[r[C.OWNER - 1]] || 0) + 1;
  });
  if (reactions.length) s.avgReaction = Math.round(reactions.reduce((a, b) => a + b, 0) / reactions.length);
  const sorted = o => Object.keys(o).map(k => [k, o[k]]).sort((a, b) => b[1] - a[1]);
  s.bySource = sorted(src);
  s.byOwner = sorted(own);
  return s;
}

function formatMinutes_(m) {
  m = Number(m) || 0;
  if (m < 60) return m + ' мин';
  const h = Math.floor(m / 60), r = m % 60;
  return h + ' ч' + (r ? ' ' + r + ' мин' : '');
}

// ================= таблица =================

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME, 0);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADER);
    formatSheet_(sheet);
    buildSummary_(ss);
  }
  return sheet;
}

function formatSheet_(sheet) {
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, HEADER.length).setFontWeight('bold').setBackground('#eef2f7');
  const widths = { 1: 130, 2: 130, 3: 130, 4: 160, 5: 110, 6: 280, 7: 110, 8: 90, 9: 260, 10: 280, 11: 100, 12: 130, 13: 130, 14: 90, 15: 70, 16: 120 };
  Object.keys(widths).forEach(c => sheet.setColumnWidth(Number(c), widths[c]));
  sheet.getRange('A:A').setNumberFormat('dd.MM.yyyy HH:mm');
  sheet.getRange('M:M').setNumberFormat('dd.MM.yyyy HH:mm');
  sheet.getRange(2, C.MESSAGE, 1000, 1).setWrap(true);
  sheet.getRange(2, C.SUMMARY, 1000, 2).setWrap(true);
  sheet.hideColumns(C.ID, 3);

  const statusRange = sheet.getRange(2, C.STATUS, 2000, 1);
  statusRange.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(Object.keys(STATUS).map(k => STATUS[k]), true).build());

  const rule = (range, text, color) => SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(text).setBackground(color).setRanges([range]).build();
  const prio = sheet.getRange(2, C.PRIORITY, 2000, 1);
  sheet.setConditionalFormatRules([
    rule(prio, 'высокий', '#fde2e1'),
    rule(statusRange, STATUS.NEW, '#fff4cc'),
    rule(statusRange, STATUS.TAKEN, '#dbe8ff'),
    rule(statusRange, STATUS.CONTACTED, '#e3dcff'),
    rule(statusRange, STATUS.DEAL, '#d6f5df'),
    rule(statusRange, STATUS.LOST, '#ececec'),
    rule(statusRange, STATUS.SPAM, '#ececec'),
  ]);
}

function buildSummary_(ss) {
  let s = ss.getSheetByName(SUMMARY_SHEET);
  if (s) return;
  s = ss.insertSheet(SUMMARY_SHEET, 1);
  const L = "'" + SHEET_NAME + "'!";
  const metrics = [
    ['Сегодня', '=COUNTIFS(' + L + 'A:A,">="&TODAY(),' + L + 'K:K,"<>Спам")'],
    ['За 7 дней', '=COUNTIFS(' + L + 'A:A,">="&TODAY()-6,' + L + 'K:K,"<>Спам")'],
    ['За 30 дней', '=COUNTIFS(' + L + 'A:A,">="&TODAY()-29,' + L + 'K:K,"<>Спам")'],
    ['Ждут ответа сейчас', '=COUNTIF(' + L + 'K:K,"Новая")'],
    ['Среднее время реакции, мин', '=IFERROR(ROUND(AVERAGE(' + L + 'N2:N),0),"—")'],
    ['Сделок за 30 дней', '=COUNTIFS(' + L + 'K:K,"Сделка",' + L + 'A:A,">="&TODAY()-29)'],
    ['Конверсия в сделку', '=IFERROR(B8/B5,0)'],
    ['Спама отсеяно за 30 дней', '=COUNTIFS(' + L + 'K:K,"Спам",' + L + 'A:A,">="&TODAY()-29)'],
  ];
  s.getRange('A1').setValue('Сводка по заявкам').setFontSize(16).setFontWeight('bold');
  metrics.forEach((m, i) => {
    s.getRange(3 + i, 1).setValue(m[0]);
    s.getRange(3 + i, 2).setFormula(m[1]).setFontWeight('bold');
  });
  s.getRange('B9').setNumberFormat('0%');
  const q = (cols, label) => '=IFERROR(QUERY(' + L + 'A2:S,"' + cols + '",0),"' + label + '")';
  s.getRange('D2').setValue('По источникам').setFontWeight('bold');
  s.getRange('D3').setFormula(q("select E, count(A) where A is not null and K <> 'Спам' group by E order by count(A) desc label E 'Источник', count(A) 'Заявок'", 'Пока нет заявок'));
  s.getRange('G2').setValue('По категориям').setFontWeight('bold');
  s.getRange('G3').setFormula(q("select G, count(A) where A is not null group by G order by count(A) desc label G 'Категория', count(A) 'Заявок'", 'Пока нет заявок'));
  s.getRange('J2').setValue('По менеджерам').setFontWeight('bold');
  s.getRange('J3').setFormula(q("select L, count(A), avg(N) where L is not null and L <> '' group by L order by count(A) desc label L 'Менеджер', count(A) 'Заявок', avg(N) 'Реакция, мин'", 'Пока никто не брал заявки'));
  s.setColumnWidth(1, 220);
}

// ================= разбор =================

const SYSTEM_PROMPT = 'Ты помогаешь отделу продаж малого бизнеса разбирать входящие заявки. ' +
  'Определи категорию и приоритет заявки, кратко изложи её суть и предложи черновик ответа.\n\n' +
  'Категории: покупка (хочет купить или узнать цену), консультация (вопрос до покупки), ' +
  'поддержка (проблема с уже купленным), спам (реклама, бессмыслица, «продвинем сайт»), другое.\n' +
  'Приоритет высокий, если клиент готов купить сейчас, упоминает сроки или крупный объём, или это жалоба. ' +
  'Низкий для спама и общих вопросов.\n' +
  'Черновик ответа пиши вежливо, на языке клиента, 1-3 предложения, без выдуманных цен и сроков.';

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: CATEGORIES },
    priority: { type: 'string', enum: PRIORITIES },
    summary: { type: 'string', description: 'Суть заявки одним предложением' },
    suggested_reply: { type: 'string', description: 'Короткий черновик ответа клиенту' },
  },
  required: ['category', 'priority', 'summary', 'suggested_reply'],
  additionalProperties: false,
};

function classifyWithClaude_(lead) {
  const key = props_().getProperty('ANTHROPIC_API_KEY');
  if (!key) return null;
  try {
    const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': key, 'anthropic-version': '2026-10-21' },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        model: props_().getProperty('CLAUDE_MODEL') || DEFAULT_MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: ANALYSIS_SCHEMA } },
        messages: [{
          role: 'user',
          content: 'Имя: ' + lead.name + '\nИсточник: ' + lead.source +
            '\nСообщение:\n<message>\n' + (lead.message || '(пусто)') + '\n</message>',
        }],
      }),
    });
    if (res.getResponseCode() !== 200) {
      console.warn('Claude ответил ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 500));
      return null;
    }
    const data = JSON.parse(res.getContentText());
    if (data.stop_reason !== 'end_turn') return null;
    const block = (data.content || []).filter(b => b.type === 'text').pop();
    const a = block && JSON.parse(block.text);
    if (!a || CATEGORIES.indexOf(a.category) === -1 || PRIORITIES.indexOf(a.priority) === -1) return null;
    return a;
  } catch (err) {
    console.warn('Claude недоступен: ' + err);
    return null;
  }
}

const RULES = {
  spam: ['seo', 'продвижение сайта', 'раскрутк', 'казино', 'http://', 'https://'],
  support: ['не работает', 'перестал', 'сломал', 'проблем', 'жалоб', 'возврат', 'брак', 'ошибк'],
  buy: ['купить', 'заказ', 'цена', 'стоимость', 'сколько стоит', 'прайс', 'счёт', 'счет', 'оплат', 'записат'],
  urgent: ['срочно', 'сегодня', 'завтра', 'оптом', 'партия'],
};

function classifyByRules_(lead) {
  const t = (lead.message || '').toLowerCase();
  const has = words => words.some(w => t.indexOf(w) !== -1);
  let category, priority;
  if (has(RULES.spam)) { category = 'спам'; priority = 'низкий'; }
  else if (has(RULES.support)) { category = 'поддержка'; priority = 'высокий'; }
  else if (has(RULES.buy)) { category = 'покупка'; priority = has(RULES.urgent) ? 'высокий' : 'средний'; }
  else if (t.trim()) { category = 'консультация'; priority = 'средний'; }
  else { category = 'другое'; priority = 'низкий'; }
  return {
    category: category,
    priority: priority,
    summary: lead.message.slice(0, 150) || 'Заявка без текста, нужно перезвонить',
    suggested_reply: 'Здравствуйте, ' + lead.name + '! Спасибо за заявку, менеджер свяжется с вами в ближайшее время.',
  };
}

// ================= Telegram: API и текст =================

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatMessage_(lead, a, repeat, footer) {
  const lines = [PRIORITY_ICON[a.priority] + ' <b>Новая заявка</b> · ' + esc_(a.category) + ' · приоритет ' + esc_(a.priority)];
  if (repeat) lines.push('🔁 <i>Повторное обращение за ' + REPEAT_DAYS + ' дней</i>');
  lines.push('', '<b>Имя:</b> ' + esc_(lead.name));
  if (lead.phone) lines.push('<b>Телефон:</b> ' + esc_(lead.phone));
  if (lead.email) lines.push('<b>Email:</b> ' + esc_(lead.email));
  lines.push('<b>Источник:</b> ' + esc_(lead.source), '', '<b>Суть:</b> ' + esc_(a.summary), '',
    '<b>Черновик ответа:</b>\n<i>' + esc_(a.suggested_reply) + '</i>');
  if (footer) lines.push('', footer);
  return lines.join('\n');
}

/** Вызов Bot API. Возвращает result или null. */
function tg_(method, payload, token) {
  token = token || props_().getProperty('TELEGRAM_BOT_TOKEN');
  if (!token || (payload.chat_id !== undefined && !payload.chat_id)) return null;
  try {
    const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(payload),
    });
    const data = JSON.parse(res.getContentText());
    if (!data.ok) console.warn('Telegram ' + method + ': ' + data.description);
    return data.ok ? data.result : null;
  } catch (err) {
    console.warn('Telegram недоступен: ' + err);
    return null;
  }
}

function findChatId_(token) {
  const updates = tg_('getUpdates', {}, token);
  if (!updates) return null;
  for (let i = updates.length - 1; i >= 0; i--) {
    const u = updates[i];
    const msg = u.message || u.channel_post || (u.my_chat_member && { chat: u.my_chat_member.chat });
    if (msg && msg.chat && msg.chat.id) return msg.chat.id;
  }
  return null;
}
