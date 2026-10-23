const fs = require('fs'), { spawn } = require('child_process');
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const V = process.env.VERTICAL === '1';
const FPS = +(process.env.FPS || 60), DSF = +(process.env.DSF || (V ? 2.5 : 3));
const W = V ? 432 : 1280, H = V ? 768 : 720;
const OUT = process.env.OUT, LIMIT = +(process.env.LIMIT || 0);

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DSF })).newPage();
  page.on('pageerror', e => console.log('PAGE ERROR', e.message)); page.on('console', m => m.type() === 'error' && console.log('CONSOLE', m.text()));
  await page.goto(process.env.PAGE || 'file://' + require('path').resolve(__dirname, '../demo.html'));
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: fs.readFileSync(__dirname + '/stage.css', 'utf8') + (V ? fs.readFileSync(__dirname + '/vertical.css', 'utf8') : '') });
  await page.evaluate(([v, outro, card]) => {
    window.VERTICAL = v; window.OUTRO = outro;
    window.processLead = process; // функция страницы, добавляет строку и сообщение
    document.documentElement.insertAdjacentHTML('beforeend', card);
  }, [V, fs.readFileSync(__dirname + '/outro.html', 'utf8'), fs.readFileSync(__dirname + '/overlay.html', 'utf8')]);
  await page.evaluate(() => document.fonts.ready);
  await page.addScriptTag({ content: fs.readFileSync(__dirname + '/stage.js', 'utf8') });
  const dur = await page.evaluate(() => window.DURATION);
  const total = LIMIT || Math.ceil(dur * FPS);
  console.log(`duration ${dur.toFixed(2)}s, frames ${total}, ${W * DSF}x${H * DSF}@${FPS}`);

  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', process.env.PRESET || 'slow', '-crf', process.env.CRF || '14', '-tune', 'animation',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    await page.evaluate(t => window.renderAt(t), i / FPS);
    const png = await page.screenshot({ type: 'png', animations: 'allow', caret: 'hide' });
    if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 300 === 0) console.log(`frame ${i}/${total} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  console.log('done', ((Date.now() - t0) / 1000).toFixed(0), 's');
  await browser.close();
})();
