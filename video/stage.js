// Покадровый движок: всё состояние сцены — функция времени t (секунды).
(() => {
  const V = window.VERTICAL;
  const $ = s => document.querySelector(s);
  const ease = p => p < .5 ? 4*p*p*p : 1 - Math.pow(-2*p + 2, 3) / 2;
  const easeOut = p => 1 - Math.pow(1 - p, 3);
  const lerp = (a, b, e) => Array.isArray(a) ? a.map((v, i) => v + (b[i] - v) * e) : a + (b - a) * e;

  // ---- твины ----
  const tweens = {};
  const valueOf = (key, t) => {
    const w = tweens[key]; if (!w) return undefined;
    const p = Math.min(1, Math.max(0, (t - w.t0) / w.dur));
    return lerp(w.from, w.to, (w.ease || ease)(p));
  };
  function tween(key, t0, to, dur, apply, opts = {}) {
    let from = opts.from !== undefined ? opts.from : valueOf(key, t0);
    if (from === undefined) from = to;
    tweens[key] = { t0, from, to, dur: Math.max(dur, 1e-6), apply, ease: opts.ease };
  }

  // ---- таймлайн ----
  const events = []; let now = 0;
  const at = fn => events.push({ t: now, fn });
  const wait = s => { now += s; };
  let ei = 0;

  // ---- камера: [x, y, s], тело страницы трансформируется ----
  const body = document.body;
  let camTarget = [0, 0, 1];
  const applyCam = v => { body.style.transform = `translate(${v[0]}px, ${v[1]}px) scale(${v[2]})`; };
  const chat = $('#chat');
  let chatTarget = 0;
  function layoutRect(el) {
    const prevT = body.style.transform, prevS = chat.scrollTop;
    body.style.transform = 'none'; chat.scrollTop = chatTarget;
    const r = el.getBoundingClientRect();
    body.style.transform = prevT; chat.scrollTop = prevS;
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  const W = innerWidth, H = innerHeight, CAP = V ? 150 : 150;
  function camFor(sel, o = {}) {
    const r = layoutRect($(sel));
    let s = o.scale;
    if (!s) {
      const mx = V ? 20 : 80;
      s = Math.min((W - mx) / r.w, (H - (o.full ? (V ? 50 : 60) : CAP)) / r.h);
      if (o.max) s = Math.min(s, o.max);
    }
    const x = W / 2 - (r.x + r.w / 2) * s;
    const cy = o.full ? H / 2 : (H - (CAP - (V ? 40 : 50))) / 2;
    const y = cy - (r.y + r.h / 2) * s;
    return [x, y, s];
  }
  const cam = (sel, o = {}, dur = .85) => at(t => { camTarget = camFor(sel, o); tween('cam', t, camTarget, o.instant ? 1e-6 : dur, applyCam); });

  // ---- курсор в координатах страницы, на экран переводится через текущую камеру ----
  const cur = $('#cur'), ripple = $('#ripple');
  let curL = [0, 0];
  tweens.cur = { t0: 0, from: [0, 0], to: [0, 0], dur: 1e-6, apply: v => { curL = v; } };
  const placeCursor = (t) => {
    const c = valueOf('cam', t) || camTarget;
    cur.style.transform = `translate(${c[0] + curL[0] * c[2]}px, ${c[1] + curL[1] * c[2]}px)`;
    const rp = tweens.ripple;
    if (rp) {
      const p = Math.min(1, Math.max(0, (t - rp.t0) / .5));
      ripple.style.left = (c[0] + rp.at[0] * c[2]) + 'px'; ripple.style.top = (c[1] + rp.at[1] * c[2]) + 'px';
      ripple.style.opacity = p >= 1 ? 0 : 1 - p; ripple.style.transform = `scale(${.2 + 1.3 * easeOut(p)})`;
    }
  };
  function pointOf(sel, dx = .5, dy = .5) { const r = layoutRect($(sel)); return [r.x + r.w * dx, r.y + r.h * dy]; }
  const move = (sel, dx, dy, dur = .55) => { at(t => tween('cur', t, pointOf(sel, dx, dy), dur, v => { curL = v; })); wait(dur); };
  const click = (sel, after) => {
    move(sel); wait(.05);
    at(t => { tweens.ripple = { t0: t, at: [...curL] }; const el = $(sel); if (el.focus) el.focus({ preventScroll: true }); after && after(t); });
    wait(.18);
  };
  // детерминированный «случайный» ритм печати
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const type = (sel, text) => {
    click(sel, () => { $(sel).value = ''; });
    for (let i = 1; i <= text.length; i++) {
      const part = text.slice(0, i);
      at(() => { $(sel).value = part; });
      wait(.012 + rnd() * .024 + (text[i - 1] === ' ' ? .018 : 0));
    }
    wait(.1);
  };

  // ---- субтитры ----
  const cap = $('#cap');
  const capApply = v => { cap.style.opacity = v; cap.style.transform = `translateX(-50%) translateY(${(1 - v) * 16}px)`; };
  tweens.cap = { t0: 0, from: 0, to: 0, dur: 1e-6, apply: capApply };
  const caption = (step, text) => {
    at(t => tween('cap', t, 0, .2, capApply));
    if (!text) { wait(.25); return; }
    wait(.22);
    at(t => { cap.querySelector('b').textContent = step; cap.querySelector('span').textContent = text; tween('cap', t, 1, .35, capApply, { ease: easeOut }); });
    wait(.04);
  };

  // ---- подсветка ----
  const hl = (sel, on) => at(t => {
    const el = typeof sel === 'string' ? $(sel) : sel();
    tween('hl:' + (el.id || sel), t, on ? 1 : 0, .3, a => {
      el.style.boxShadow = a > 0.001 ? `0 0 0 ${3}px rgba(240,165,64,${a}), 0 12px 40px rgba(240,165,64,${.35 * a})` : '';
    });
  });

  // ---- отправка заявки ----
  const send = $('#send');
  const submit = (lead) => {
    click('#send', () => { send.textContent = 'Разбираем заявку…'; send.style.opacity = .6; });
    wait(.7);
    at(t => {
      send.textContent = 'Отправить заявку'; send.style.opacity = '';
      const prev = chat.scrollTop;
      window.processLead(lead, stamp(new Date(BASE + 60000 * submitCount++)), false);
      chatTarget = chat.scrollHeight - chat.clientHeight; chat.scrollTop = prev;
      tween('chat', t, chatTarget, .45, v => { chat.scrollTop = v; }, { from: prev });
      const row = $('#rows tr');
      tween('row' + t, t, 0, 2.2, a => row.querySelectorAll('td').forEach(td => td.style.background = a > .001 ? `rgba(255,232,140,${a * .75})` : ''), { from: 1, ease: p => p });
      const m = chat.lastElementChild;
      tween('pop' + t, t, 1, .4, v => { m.style.opacity = .3 + .7 * v; m.style.transform = `translateY(${(1 - v) * 10}px)`; }, { from: 0, ease: easeOut });
    });
  };
  let submitCount = 0; const BASE = Date.now();
  const fill = s => at(() => ['name', 'phone', 'email', 'message'].forEach(k => $('#' + k).value = s[k]));
  const lastOf = (sel, id) => at(() => { [...document.querySelectorAll(sel)].pop().id = id; });

  // ---- карточки (заставка/финал) ----
  const card = $('#card');
  const cardIn = (t) => [...card.querySelectorAll('.in')].forEach((el, i) => {
    const d = parseFloat(el.dataset.d || 0);
    tween('in' + i + t, t + d, 1, .55, v => { el.style.opacity = v; el.style.transform = `translateY(${(1 - v) * 14}px)`; }, { from: 0, ease: easeOut });
    el.style.opacity = 0;
  });
  const cardFade = (to, dur) => at(t => tween('card', t, to, dur, v => { card.style.opacity = v; card.style.visibility = v < .001 ? 'hidden' : 'visible'; }));

  // ======== СЦЕНАРИЙ ========
  const S = SAMPLES; // глобальная константа страницы
  at(t => { cardIn(t); tween('card', t, 1, 1e-6, v => { card.style.opacity = v; }); });
  cam('.flow', { full: true, instant: true });
  at(t => tween('cur', t, pointOf('#f', .7, .1), 1e-6, v => { curL = v; }));
  wait(2.6);
  cardFade(0, .5); wait(.45);

  caption('1/5', 'Клиент оставляет заявку на сайте');
  cam('section[aria-label="Форма на сайте"]', { max: V ? 1.1 : 1.3 }); wait(.6);
  type('#name', 'Анна');
  type('#phone', '+7 905 123-45-67');
  click('#email', () => { $('#email').value = ''; });
  type('#message', 'Сколько стоит доставка 20 коробок? Нужно срочно.');
  submit({ name: 'Анна', phone: '+7 905 123-45-67', email: '', message: 'Сколько стоит доставка 20 коробок? Нужно срочно.' });
  caption('2/5', 'ИИ разбирает заявку за секунды'); wait(.35);

  lastOf('.msg', 'm1');
  caption('2/5', 'Менеджеру сразу приходит уведомление в Telegram');
  cam('#m1', V ? { max: 1.15 } : { scale: 1.45 }); wait(.85);
  hl('#m1', true);
  move('#m1', .25, .1); wait(1.0);
  caption('2/5', 'Срочность и черновик ответа уже готовы');
  move('#m1', .45, .62); wait(1.3);
  caption('2/5', 'Менеджер берёт заявку одной кнопкой');
  move('#m1 .tg-btns button', .5, .5); wait(.1);
  at(t => { tweens.ripple = { t0: t, at: [...curL] }; $('#m1 .tg-btns button').click(); });
  wait(1.4);
  hl('#m1', false);

  caption('3/5', 'В таблице видно статус и ответственного');
  cam('.sheet', {}); wait(.85);
  move('#rows tr', V ? .5 : .62, .5);
  hl('.sheet', true); wait(1.8); hl('.sheet', false);

  caption('4/5', 'Жалоба получает высокий приоритет');
  cam('section[aria-label="Форма на сайте"]', { max: V ? 1.1 : 1.3 }); wait(.85);
  click('.chip:nth-child(2)', () => {}); fill(S[1]); wait(.25);
  submit(S[1]);
  lastOf('.msg', 'm2');
  cam('#m2', V ? { max: 1.15 } : { scale: 1.4 }); wait(.85);
  hl('#m2', true); move('#m2', .3, .5); wait(1.6); hl('#m2', false);

  caption('5/5', 'Спам отсеивается, менеджер не отвлекается');
  cam('section[aria-label="Форма на сайте"]', { max: V ? 1.1 : 1.3 }); wait(.85);
  click('.chip:nth-child(4)', () => {}); fill(S[3]); wait(.25);
  submit(S[3]);
  lastOf('.skip', 's1');
  cam('#m2', V ? { max: 1.0 } : { scale: 1.25 }); wait(.85);
  hl('#s1', true); move('#s1', .5, .5); wait(1.6); hl('#s1', false);

  caption('', '');
  cam(V ? '.sheet' : '.flow', V ? {} : { full: true }); at(t => tween('curA', t, 0, .3, v => { cur.style.opacity = v; }, { from: 1 })); wait(1.6);

  at(t => {
    card.innerHTML = window.OUTRO;
    cardIn(t);
  });
  cardFade(1, .5); wait(3.6);

  window.DURATION = now;
  window.renderAt = t => {
    while (ei < events.length && events[ei].t <= t + 1e-9) events[ei++].fn(events[ei - 1].t);
    for (const k in tweens) { const w = tweens[k]; if (w.apply) w.apply(valueOf(k, t)); }
    placeCursor(t);
  };
})();
