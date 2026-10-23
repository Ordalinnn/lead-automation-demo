const fs = require('fs'), vm = require('vm'), assert = require('assert');

function makeEnv(props = {}, fetchImpl) {
  const rows = [], fetches = [];
  const sheet = { rows, appendRow: r => rows.push(r), getLastRow: () => rows.length, setFrozenRows() {}, getRange: () => ({ setFontWeight() {} }) };
  const store = { ...props };
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => store[k] ?? null, setProperty: (k, v) => { store[k] = v; }, setProperties: o => Object.assign(store, o),
      deleteProperty: k => { delete store[k]; }, getProperties: () => ({ ...store }) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { TEXT: 'text' }, createTextOutput: s => ({ text: s, setMimeType() { return this; } }) },
    Utilities: { getUuid: () => 'abcd-ef01-2345-6789-abcdef012345' },
    UrlFetchApp: { fetch: (url, opts) => { fetches.push({ url, opts }); return fetchImpl(url, opts); } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'Code.gs'), 'utf8'), ctx);
  return { ctx, rows, fetches, store };
}
const resp = (code, body) => ({ getResponseCode: () => code, getContentText: () => typeof body === 'string' ? body : JSON.stringify(body) });
const tgOk = () => resp(200, { ok: true });
const TG = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '42' };

// 1. Форма Tilda: строка в таблице и сообщение в Telegram
{
  const { ctx, rows, fetches } = makeEnv(TG, tgOk);
  const out = ctx.doPost({ parameter: { Name: 'Айгерим', Phone: '+7 701 000 00 00', Textarea: 'Сколько стоит чистка? Нужно сегодня', Service: 'Чистка', tranid: '1:2', formname: 'Запись' }, postData: { type: 'application/x-www-form-urlencoded', contents: '' } });
  assert.equal(out.text, 'ok');
  assert.equal(rows.length, 2);
  const r = rows[1];
  assert.deepEqual([r[1], r[2], r[4], r[6], r[7], r[10]], ['Айгерим', '+7 701 000 00 00', 'Запись', 'покупка', 'высокий', 'правила']);
  assert.ok(r[5].includes('Service: Чистка') && !r[5].includes('tranid'));
  assert.equal(fetches.length, 1);
  assert.ok(fetches[0].url.endsWith('/bot123:abc/sendMessage'));
  const p = JSON.parse(fetches[0].opts.payload);
  assert.equal(p.chat_id, '42'); assert.ok(p.text.startsWith('🔴 <b>Новая заявка</b> · покупка'));
}
// 2. Проверка Tilda test=test
{
  const { ctx, rows } = makeEnv(TG, tgOk);
  assert.equal(ctx.doPost({ parameter: { test: 'test' }, postData: { type: 'application/x-www-form-urlencoded' } }).text, 'ok');
  assert.equal(rows.length, 0);
}
// 3. Ключ вебхука
{
  const { ctx, rows } = makeEnv({ ...TG, WEBHOOK_KEY: 'k1' }, tgOk);
  assert.equal(ctx.doPost({ parameter: { phone: '1', key: 'bad' } }).text, 'forbidden');
  assert.equal(ctx.doPost({ parameter: { phone: '87010000000', key: 'k1' } }).text, 'ok');
  assert.equal(rows[1][1], 'Без имени');
}
// 4. JSON от WordPress
{
  const { ctx, rows } = makeEnv(TG, tgOk);
  ctx.doPost({ parameter: { source: 'wordpress' }, postData: { type: 'application/json', contents: JSON.stringify({ 'your-name': 'Ерлан', 'your-email': 'e@x.kz', 'your-message': 'Нужна консультация' }) } });
  assert.deepEqual([rows[1][1], rows[1][3], rows[1][4]], ['Ерлан', 'e@x.kz', 'wordpress']);
}
// 5. Claude отвечает: используется его разбор
{
  const { ctx, rows, fetches } = makeEnv({ ...TG, ANTHROPIC_API_KEY: 'sk-ant-x' }, (url) => url.includes('anthropic')
    ? resp(200, { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify({ category: 'поддержка', priority: 'высокий', summary: 'Сломался кран', suggested_reply: 'Приедем сегодня' }) }] })
    : tgOk());
  ctx.submitForm({ name: 'Иван', phone: '+7', message: 'Течёт кран', source: 'форма' });
  assert.deepEqual([rows[1][6], rows[1][8], rows[1][10]], ['поддержка', 'Сломался кран', 'claude-haiku-5-5']);
  const req = JSON.parse(fetches[0].opts.payload);
  assert.equal(fetches[0].opts.headers['anthropic-version'], '2026-10-21');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.model, 'claude-haiku-5-5');
}
// 6. Claude ошибка: разбор по правилам, заявка не теряется
{
  const { ctx, rows } = makeEnv({ ...TG, ANTHROPIC_API_KEY: 'sk-ant-x' }, (url) => url.includes('anthropic') ? resp(401, 'bad key') : tgOk());
  const res = ctx.submitForm({ name: 'Иван', phone: '+7', message: 'Хочу купить', source: 'форма' });
  assert.equal(rows[1][10], 'правила'); assert.equal(res.notified, true);
}
// 7. Спам не уведомляет, ловушка не сохраняет
{
  const { ctx, rows, fetches } = makeEnv(TG, tgOk);
  ctx.submitForm({ name: 'SEO', email: 's@s', message: 'Продвижение сайта https://x' });
  assert.equal(rows[1][6], 'спам'); assert.equal(fetches.length, 0);
  ctx.submitForm({ name: 'bot', phone: '1', website: 'x' });
  assert.equal(rows.length, 2);
}
// 8. Без контактов: ошибка для формы
{
  const { ctx } = makeEnv(TG, tgOk);
  assert.throws(() => ctx.submitForm({ name: 'X' }), /телефон или email/);
}
// 9. Поиск chat id
{
  const { ctx } = makeEnv({}, () => resp(200, { ok: true, result: [{ message: { chat: { id: 111 } } }, { message: { chat: { id: 222 } } }] }));
  assert.equal(ctx.findChatId_('123:abc'), 222);
}
// 10. Без Telegram: заявка сохраняется
{
  const { ctx, rows } = makeEnv({}, tgOk);
  assert.equal(ctx.submitForm({ name: 'A', phone: '1', message: 'Вопрос' }).notified, false);
  assert.equal(rows.length, 2);
}
console.log('all 10 checks passed');
