/**
 * Заявки на автопилоте: форма или сайт → ИИ-разбор → эта Google Таблица → Telegram.
 *
 * Работает внутри Google Таблицы, сервер не нужен. Настройка через меню «Заявки» в таблице.
 * Адрес веб-приложения открывает форму заявки и принимает вебхуки Tilda, WordPress и других форм.
 */

const SHEET_NAME = 'Заявки';
const HEADER = ['Дата', 'Имя', 'Телефон', 'Email', 'Источник', 'Сообщение', 'Категория', 'Приоритет', 'Суть', 'Черновик ответа', 'Разобрано'];
const DEFAULT_MODEL = 'claude-haiku-5-5';

const CATEGORIES = ['покупка', 'консультация', 'поддержка', 'спам', 'другое'];
const PRIORITIES = ['высокий', 'средний', 'низкий'];
const PRIORITY_ICON = { 'высокий': '🔴', 'средний': '🟡', 'низкий': '⚪' };

// ---------- меню в таблице ----------

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Заявки')
    .addItem('1. Подключить Telegram', 'setupTelegram')
    .addItem('2. Подключить Claude (необязательно)', 'setupClaude')
    .addItem('3. Отправить тестовую заявку', 'sendTestLead')
    .addSeparator()
    .addItem('Защитить вебхук ключом', 'setupWebhookKey')
    .addItem('Показать текущие настройки', 'showSettings')
    .addToUi();
  getSheet_();
}

function setupTelegram() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Подключить Telegram',
    'Вставьте токен бота от @BotFather.\nПеред этим напишите своему боту любое сообщение, например «привет».',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const token = res.getResponseText().trim();
  if (!/^\d+:[\w-]{30,}$/.test(token)) {
    ui.alert('Это не похоже на токен бота. Он выглядит так: 123456789:AAE...');
    return;
  }
  const chatId = findChatId_(token);
  if (!chatId) {
    ui.alert('Не нашёл переписку с ботом. Напишите боту любое сообщение в Telegram и запустите этот пункт ещё раз.');
    return;
  }
  const props = PropertiesService.getScriptProperties();
  props.setProperties({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: String(chatId) });
  sendTelegram_('✅ Бот подключён. Сюда будут приходить новые заявки.');
  ui.alert('Готово! Бот подключён, в Telegram пришло проверочное сообщение.');
}

function setupClaude() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Подключить Claude',
    'Вставьте API-ключ с console.anthropic.com (начинается с sk-ant-).\nБез ключа заявки разбираются по ключевым словам.',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const key = res.getResponseText().trim();
  if (!key) {
    PropertiesService.getScriptProperties().deleteProperty('ANTHROPIC_API_KEY');
    ui.alert('Ключ удалён, заявки будут разбираться по ключевым словам.');
    return;
  }
  PropertiesService.getScriptProperties().setProperty('ANTHROPIC_API_KEY', key);
  const test = classifyWithClaude_({ name: 'Тест', message: 'Сколько стоит доставка? Нужно срочно.', source: 'проверка' });
  ui.alert(test ? 'Claude подключён и отвечает.' : 'Ключ сохранён, но Claude не ответил. Проверьте ключ и баланс на console.anthropic.com.');
}

function setupWebhookKey() {
  const ui = SpreadsheetApp.getUi();
  const key = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  PropertiesService.getScriptProperties().setProperty('WEBHOOK_KEY', key);
  ui.alert('Ключ вебхука создан.\n\nДобавляйте к адресу веб-приложения для Tilda и других сайтов:\n?key=' + key +
    '\n\nФорма по самому адресу продолжит работать без ключа.');
}

function showSettings() {
  const p = PropertiesService.getScriptProperties().getProperties();
  SpreadsheetApp.getUi().alert(
    'Telegram: ' + (p.TELEGRAM_BOT_TOKEN ? 'подключён' : 'не подключён') + '\n' +
    'Claude: ' + (p.ANTHROPIC_API_KEY ? 'подключён, модель ' + (p.CLAUDE_MODEL || DEFAULT_MODEL) : 'не подключён, разбор по ключевым словам') + '\n' +
    'Ключ вебхука: ' + (p.WEBHOOK_KEY ? '?key=' + p.WEBHOOK_KEY : 'не задан'));
}

function sendTestLead() {
  const result = processLead_({ name: 'Тестовый клиент', phone: '+7 701 000 00 00',
    message: 'Здравствуйте! Сколько стоит ваша услуга? Нужно срочно, сегодня.', source: 'тест из таблицы' });
  SpreadsheetApp.getUi().alert('Тестовая заявка добавлена.\nКатегория: ' + result.category + ', приоритет: ' + result.priority +
    '\nУведомление: ' + (result.notified ? 'отправлено в Telegram' : 'не отправлено, подключите Telegram'));
}

// ---------- веб-приложение ----------

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Form')
    .setTitle('Оставить заявку')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Вызывается из формы Form.html. */
function submitForm(fields) {
  return processLead_(fields || {});
}

/** Вебхук: Tilda, WordPress (Contact Form 7, Elementor), Webflow, любые формы. */
function doPost(e) {
  const params = (e && e.parameter) || {};
  const required = PropertiesService.getScriptProperties().getProperty('WEBHOOK_KEY');
  if (required && params.key !== required) return text_('forbidden');

  let fields = {};
  const body = e && e.postData;
  if (body && /json/.test(body.type || '')) {
    try { fields = JSON.parse(body.contents) || {}; } catch (err) { fields = {}; }
  } else {
    fields = Object.assign({}, params);
  }
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

// ---------- распознавание полей ----------

const NAME_KEYS = ['name', 'имя', 'fio', 'фио', 'your-name', 'first_name', 'firstname', 'full_name', 'client_name'];
const PHONE_KEYS = ['phone', 'телефон', 'tel', 'your-phone', 'your-tel', 'phone_number', 'mobile', 'whatsapp'];
const EMAIL_KEYS = ['email', 'e-mail', 'почта', 'your-email', 'mail'];
const MESSAGE_KEYS = ['message', 'сообщение', 'comments', 'comment', 'комментарий', 'textarea', 'text', 'your-message', 'question', 'вопрос'];
const SOURCE_KEYS = ['formname', 'form_name', 'form', 'source', 'utm_source'];
const SKIP_KEYS = ['tranid', 'formid', 'cookies', 'referer', 'website', 'key', 'test', '_wpcf7', '_wpcf7_version',
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

// ---------- обработка заявки ----------

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
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('ANTHROPIC_API_KEY')) {
    analysis = classifyWithClaude_(lead);
    if (analysis) by = props.getProperty('CLAUDE_MODEL') || DEFAULT_MODEL;
  }
  if (!analysis) analysis = classifyByRules_(lead);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    getSheet_().appendRow([new Date(), lead.name, lead.phone, lead.email, lead.source, lead.message,
      analysis.category, analysis.priority, analysis.summary, analysis.suggested_reply, by]);
  } finally {
    lock.releaseLock();
  }

  const notified = analysis.category !== 'спам' && sendTelegram_(formatMessage_(lead, analysis));
  return { ok: true, category: analysis.category, priority: analysis.priority, notified: !!notified };
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADER);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADER.length).setFontWeight('bold');
  }
  return sheet;
}

// ---------- разбор ----------

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
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('ANTHROPIC_API_KEY');
  if (!key) return null;
  try {
    const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': key, 'anthropic-version': '2026-10-21' },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        model: props.getProperty('CLAUDE_MODEL') || DEFAULT_MODEL,
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

// ---------- Telegram ----------

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatMessage_(lead, a) {
  const lines = [PRIORITY_ICON[a.priority] + ' <b>Новая заявка</b> · ' + esc_(a.category) + ' · приоритет ' + esc_(a.priority), '',
    '<b>Имя:</b> ' + esc_(lead.name)];
  if (lead.phone) lines.push('<b>Телефон:</b> ' + esc_(lead.phone));
  if (lead.email) lines.push('<b>Email:</b> ' + esc_(lead.email));
  lines.push('<b>Источник:</b> ' + esc_(lead.source), '', '<b>Суть:</b> ' + esc_(a.summary), '',
    '<b>Черновик ответа:</b>\n<i>' + esc_(a.suggested_reply) + '</i>');
  return lines.join('\n');
}

function sendTelegram_(text) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TELEGRAM_BOT_TOKEN'), chatId = props.getProperty('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return false;
  try {
    const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    return res.getResponseCode() === 200;
  } catch (err) {
    console.warn('Telegram недоступен: ' + err);
    return false;
  }
}

function findChatId_(token) {
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates', { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  const updates = (JSON.parse(res.getContentText()).result || []).reverse();
  for (const u of updates) {
    const msg = u.message || u.channel_post || u.my_chat_member;
    if (msg && msg.chat && msg.chat.id) return msg.chat.id;
  }
  return null;
}
