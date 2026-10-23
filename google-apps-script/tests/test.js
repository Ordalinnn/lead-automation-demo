// Проверка логики Code.gs на имитации сервисов Google: node tests/test.js
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');

// Цепочка-заглушка для оформления (ширина колонок, правила, валидация)
const chain = () => new Proxy(function () {}, { get: (t, k) => k === 'build' ? () => ({}) : chain(), apply: () => chain() });

function makeSheet() {
  const data = [];
  const sheet = {
    data,
    appendRow: r => { data.push(r.slice()); },
    getLastRow: () => data.length,
    getRange(r, c, nr = 1, nc = 1) {
      if (typeof r === 'string') return chain();
      const rng = {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (data[r - 1 + i] || [])[c - 1 + j] ?? '')),
        setValues: vals => { vals.forEach((row, i) => row.forEach((v, j) => { (data[r - 1 + i] ||= [])[c - 1 + j] = v; })); return rng; },
        setValue: v => { (data[r - 1] ||= [])[c - 1] = v; return rng; },
      };
      return new Proxy(rng, { get: (t, k) => k in t ? t[k] : chain() });
    },
  };
  return new Proxy(sheet, { get: (t, k) => k in t ? t[k] : chain() });
}

function makeEnv(props = {}, handler = () => ({ ok: true, result: true })) {
  const sheet = makeSheet(), fetches = [], triggers = [];
  const sheets = { 'Заявки': sheet };
  const store = { ...props };
  const ctx = {
    console: process.env.DEBUG ? console : { log() {}, warn() {}, error() {} }, Date, Math, JSON,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = n === 'Заявки' ? sheet : makeSheet()) }),
      newDataValidation: chain, newConditionalFormatRule: chain,
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => store[k] ?? null, setProperty: (k, v) => { store[k] = v; }, setProperties: o => Object.assign(store, o),
      deleteProperty: k => { delete store[k]; }, getProperties: () => ({ ...store }) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { TEXT: 'text' }, createTextOutput: s => ({ text: s, setMimeType() { return this; } }) },
    Utilities: { getUuid: (() => { let n = 0; return () => `id${(++n).toString().padStart(6, '0')}-ef01-2345`; })() },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: f => { triggers.push(f); return chain(); }, getService: () => ({ getUrl: () => '' }) },
    UrlFetchApp: { fetch: (url, opts) => {
      const call = { url, method: url.split('/').pop(), body: opts.payload ? JSON.parse(opts.payload) : {}, opts };
      fetches.push(call);
      const out = handler(call);
      return { getResponseCode: () => out.code || 200, getContentText: () => JSON.stringify(out.body !== undefined ? out.body : out) };
    } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), ctx);
  return { ctx, rows: sheet.data, fetches, store, triggers, tgCalls: m => fetches.filter(f => f.method === m) };
}
const TG = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '42' };
const tgSend = call => call.method === 'sendMessage' ? { ok: true, result: { message_id: 777 } } : { ok: true, result: true };
const COL = { NAME: 1, PHONE: 2, SOURCE: 4, MESSAGE: 5, CATEGORY: 6, PRIORITY: 7, STATUS: 10, OWNER: 11, TAKEN: 12, REACTION: 13, REPEAT: 14, BY: 15, ID: 16, MSG: 17, REMINDED: 18 };
let checks = 0;
const check = (name, fn) => { fn(); checks++; };

check('форма Tilda: строка, статус, кнопки, сообщение', () => {
  const { ctx, rows, tgCalls } = makeEnv(TG, tgSend);
  const out = ctx.doPost({ parameter: { Name: 'Айгерим', Phone: '8 701 000 00 00', Textarea: 'Сколько стоит чистка? Нужно сегодня', Service: 'Чистка', tranid: '1:2', formname: 'Запись' }, postData: { type: 'application/x-www-form-urlencoded' } });
  assert.equal(out.text, 'ok');
  const r = rows[1];
  assert.deepEqual([r[COL.NAME], r[COL.SOURCE], r[COL.CATEGORY], r[COL.PRIORITY], r[COL.STATUS], r[COL.BY], r[COL.MSG]], ['Айгерим', 'Запись', 'покупка', 'высокий', 'Новая', 'правила', 777]);
  assert.ok(r[COL.MESSAGE].includes('Service: Чистка') && !r[COL.MESSAGE].includes('tranid'));
  const send = tgCalls('sendMessage')[0].body;
  assert.equal(send.chat_id, '42');
  assert.ok(send.text.startsWith('🔴 <b>Новая заявка</b> · покупка'));
  const kb = send.reply_markup.inline_keyboard;
  assert.equal(kb[0][0].callback_data, 'take:' + r[COL.ID]);
  assert.equal(kb[2][0].url, 'https://wa.me/77010000000');
});

check('проверочный запрос Tilda и ключ вебхука', () => {
  const { ctx, rows } = makeEnv({ ...TG, WEBHOOK_KEY: 'k1' }, tgSend);
  assert.equal(ctx.doPost({ parameter: { test: 'test', key: 'k1' } }).text, 'ok');
  assert.equal(ctx.doPost({ parameter: { phone: '1', key: 'bad' } }).text, 'forbidden');
  assert.equal(rows.length, 0);
  assert.equal(ctx.doPost({ parameter: { phone: '87010000000', key: 'k1' } }).text, 'ok');
  assert.equal(rows[1][COL.NAME], 'Без имени');
});

check('JSON от WordPress', () => {
  const { ctx, rows } = makeEnv(TG, tgSend);
  ctx.doPost({ parameter: { source: 'wordpress' }, postData: { type: 'application/json', contents: JSON.stringify({ 'your-name': 'Ерлан', 'your-email': 'e@x.kz', 'your-message': 'Нужна консультация' }) } });
  assert.deepEqual([rows[1][COL.NAME], rows[1][3], rows[1][COL.SOURCE]], ['Ерлан', 'e@x.kz', 'wordpress']);
});

check('повторное обращение по телефону', () => {
  const { ctx, rows, tgCalls } = makeEnv(TG, tgSend);
  ctx.submitForm({ name: 'А', phone: '+7 701 111 22 33', message: 'Вопрос' });
  ctx.submitForm({ name: 'А', phone: '87011112233', message: 'Ещё вопрос' });
  assert.equal(rows[1][COL.REPEAT], ''); assert.equal(rows[2][COL.REPEAT], 'да');
  assert.ok(tgCalls('sendMessage')[1].body.text.includes('🔁'));
});

check('Claude: разбор и формат запроса', () => {
  const { ctx, rows, fetches } = makeEnv({ ...TG, ANTHROPIC_API_KEY: 'sk-ant-x' }, call => call.url.includes('anthropic')
    ? { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify({ category: 'поддержка', priority: 'высокий', summary: 'Течёт кран', suggested_reply: 'Приедем сегодня' }) }] }
    : tgSend(call));
  ctx.submitForm({ name: 'Иван', phone: '+77010000000', message: 'Течёт кран' });
  assert.deepEqual([rows[1][COL.CATEGORY], rows[1][8], rows[1][COL.BY]], ['поддержка', 'Течёт кран', 'claude-haiku-5-5']);
  const req = fetches[0];
  assert.equal(req.opts.headers['anthropic-version'], '2026-10-21');
  assert.equal(req.body.output_config.format.type, 'json_schema');
});

check('Claude недоступен: разбор по правилам', () => {
  const { ctx, rows } = makeEnv({ ...TG, ANTHROPIC_API_KEY: 'sk-ant-x' }, call => call.url.includes('anthropic') ? { code: 401, body: { error: 'bad key' } } : tgSend(call));
  assert.equal(ctx.submitForm({ name: 'Иван', phone: '+7', message: 'Хочу купить' }).notified, true);
  assert.equal(rows[1][COL.BY], 'правила');
});

check('спам и ловушка для ботов', () => {
  const { ctx, rows, fetches } = makeEnv(TG, tgSend);
  ctx.submitForm({ name: 'SEO', email: 's@s', message: 'Продвижение сайта https://x' });
  assert.equal(rows[1][COL.STATUS], 'Спам'); assert.equal(fetches.length, 0);
  ctx.submitForm({ name: 'bot', phone: '1', website: 'x' });
  assert.equal(rows.length, 2);
  assert.throws(() => ctx.submitForm({ name: 'X' }), /телефон или email/);
});

check('кнопка «Беру»: статус, ответственный, реакция, правка сообщения', () => {
  const env = makeEnv({ ...TG, TG_HOOK_SECRET: 's' }, tgSend);
  env.ctx.submitForm({ name: 'Анна', phone: '+77010000000', message: 'Хочу заказать' });
  const id = env.rows[1][COL.ID];
  env.rows[1][0] = new Date(Date.now() - 4 * 60000); // заявка пришла 4 минуты назад
  const upd = (uid, data, who) => ({ parameter: { tg: 's' }, postData: { type: 'application/json', contents: JSON.stringify({
    update_id: uid, callback_query: { id: 'cq' + uid, data, from: { first_name: who }, message: { message_id: 777, chat: { id: 42 } } } }) } });
  assert.equal(env.ctx.doPost(upd(10, 'take:' + id, 'Айдар')).text, 'ok');
  assert.deepEqual([env.rows[1][COL.STATUS], env.rows[1][COL.OWNER], env.rows[1][COL.REACTION]], ['В работе', 'Айдар', 4]);
  const edit = env.tgCalls('editMessageText')[0].body;
  assert.ok(edit.text.includes('👤 В работе: Айдар · реакция 4 мин'));
  assert.ok(!JSON.stringify(edit.reply_markup).includes('take:'));
  // второй менеджер не может перехватить
  env.ctx.doPost(upd(11, 'take:' + id, 'Бекзат'));
  assert.equal(env.tgCalls('answerCallbackQuery').pop().body.text, 'Заявку уже взял Айдар');
  // повтор того же события от Telegram игнорируется
  const before = env.fetches.length;
  env.ctx.doPost(upd(11, 'deal:' + id, 'Айдар'));
  assert.equal(env.fetches.length, before);
  // сделка
  env.ctx.doPost(upd(12, 'deal:' + id, 'Айдар'));
  assert.equal(env.rows[1][COL.STATUS], 'Сделка');
  assert.equal(env.rows[1][COL.OWNER], 'Айдар');
  // чужой секрет
  assert.equal(env.ctx.doPost({ parameter: { tg: 'x' }, postData: { type: 'application/json', contents: '{"update_id":99}' } }).text, 'forbidden');
});

check('напоминание о невзятой заявке, один раз', () => {
  const env = makeEnv(TG, tgSend);
  env.ctx.submitForm({ name: 'Ждёт', phone: '+77010000000', message: 'Вопрос' });
  env.ctx.submitForm({ name: 'Свежая', phone: '+77010000001', message: 'Вопрос' });
  env.rows[1][0] = new Date(Date.now() - 20 * 60000);
  env.ctx.checkReminders();
  const rem = env.tgCalls('sendMessage').filter(c => c.body.text.startsWith('⏰'));
  assert.equal(rem.length, 1);
  assert.ok(rem[0].body.text.includes('Ждёт') && rem[0].body.text.includes('20 мин'));
  assert.equal(rem[0].body.reply_parameters.message_id, 777);
  env.ctx.checkReminders();
  assert.equal(env.tgCalls('sendMessage').filter(c => c.body.text.startsWith('⏰')).length, 1);
});

check('ежедневный отчёт за вчера', () => {
  const env = makeEnv(TG, tgSend);
  ['А', 'Б', 'В'].forEach((n, i) => env.ctx.submitForm({ name: n, phone: '+7701000000' + i, message: i ? 'Хочу купить срочно' : 'Вопрос', source: i === 2 ? 'tilda' : 'форма' }));
  env.ctx.submitForm({ name: 'SEO', email: 's@s', message: 'seo продвижение' });
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(12);
  env.rows.slice(1).forEach(r => { r[0] = yesterday; });
  Object.assign(env.rows[1], { [COL.STATUS]: 'Сделка', [COL.OWNER]: 'Айдар', [COL.REACTION]: 6 });
  Object.assign(env.rows[2], { [COL.STATUS]: 'В работе', [COL.OWNER]: 'Айдар', [COL.REACTION]: 10 });
  env.ctx.sendDailyReport();
  const text = env.tgCalls('sendMessage').pop().body.text;
  for (const s of ['Всего: <b>3</b>', '1 спам', 'Срочных: 2', 'Сделок: 1', 'реакции: 8 мин', 'Ждут ответа: <b>1</b>', 'форма — 2', 'Айдар — 2']) assert.ok(text.includes(s), s + '\n' + text);
});

check('подключение: поиск чата, вебхук кнопок, расписание', () => {
  const env = makeEnv({}, call => call.method === 'getUpdates'
    ? { ok: true, result: [{ message: { chat: { id: 111 } } }, { message: { chat: { id: -222 } } }] } : tgSend(call));
  assert.equal(env.ctx.findChatId_('123:abc'), -222);
  Object.assign(env.store, TG, { WEBAPP_URL: 'https://script.google.com/macros/s/X/exec' });
  assert.equal(env.ctx.setTelegramWebhook_(), true);
  const hook = env.tgCalls('setWebhook')[0].body;
  assert.ok(hook.url.startsWith('https://script.google.com/macros/s/X/exec?tg='));
  assert.deepEqual(hook.allowed_updates, ['callback_query']);
});

check('форматирование времени', () => {
  const { ctx } = makeEnv();
  assert.equal(ctx.formatMinutes_(5), '5 мин'); assert.equal(ctx.formatMinutes_(60), '1 ч'); assert.equal(ctx.formatMinutes_(135), '2 ч 15 мин');
});

console.log(`all ${checks} checks passed`);
