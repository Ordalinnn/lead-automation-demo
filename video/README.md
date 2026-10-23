# Рендер демо-видео

Покадровый рендер: время в браузере управляется сценарием (`stage.js`), каждый кадр снимается без спешки и отправляется в ffmpeg. Поэтому разрешение и частота кадров не зависят от скорости компьютера.

Нужны Node.js, Playwright с Chromium и ffmpeg.

```bash
# Горизонтальное 4K, 60 кадров/с
OUT=zayavki-4k60.mp4 node video/render.js

# Вертикальное 1080×1920 для Reels, Shorts, TikTok
VERTICAL=1 OUT=zayavki-vertical.mp4 node video/render.js

# Быстрый черновик для проверки сценария
DSF=1 FPS=10 PRESET=ultrafast OUT=draft.mp4 node video/render.js
```

Страница по умолчанию — `demo.html`; другую можно указать в `PAGE` (например, `file:///путь/к/index.html`).

Сценарий (тексты субтитров, порядок сцен, паузы) находится в конце `stage.js`, финальная карточка — в `outro.html`.
