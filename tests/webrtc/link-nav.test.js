// The link browser's remote navigation (NAV in BrowserActivity.java), run in Chromium on a page laid
// out like a video site: a search box, then a grid of videos.
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const java = fs.readFileSync(path.join(__dirname, '../../receiver-android/src/com/projectorcast/receiver/BrowserActivity.java'), 'utf8');
const body = /static final String NAV = ([\s\S]*?);\n/.exec(java)[1];
const NAV = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');

const PAGE = `<body style="margin:0;font:16px sans-serif">
<input id="search" style="margin:10px;width:300px">
<div style="display:grid;grid-template-columns:repeat(3,200px);gap:20px;padding:10px">
${Array.from({ length: 12 }, (_, i) => `<a id="v${i}" href="#v${i}" style="display:block;height:120px;background:#ccc">Video ${i}</a>`).join('')}
</div><div style="height:2000px"></div><button id="hidden" style="display:none">x</button></body>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.setContent(PAGE);
  const move = (d) => page.evaluate((js) => eval(js), `${NAV}__pcNav.move('${d}')`);
  const current = () => page.evaluate(() => {
    const e = [...document.querySelectorAll('*')].find((x) => x.style.outline.includes('solid'));
    return e ? e.id : null;
  });
  const steps = [];
  for (const d of ['down', 'down', 'right', 'right', 'right', 'down', 'left', 'up', 'up']) {
    const r = await move(d);
    steps.push(`${d}:${await current()}${r === 'edge' ? '(edge)' : ''}`);
  }
  console.log('  ' + steps.join(' '));
  assert.deepStrictEqual(steps, ['down:search', 'down:v0', 'right:v1', 'right:v2', 'right:v2(edge)', 'down:v5', 'left:v4', 'up:v1', 'up:search']);
  // Rows below the screen: moving down scrolls them into view.
  for (let i = 0; i < 4; i++) await move('down');
  const scrolled = await page.evaluate(() => scrollY);
  assert(scrolled > 0 && (await current()) === 'v9', `scrolls to the lower rows: ${await current()} at ${scrolled}`);
  const clicked = await page.evaluate((js) => eval(js), `${NAV}__pcNav.click()`);
  assert(clicked === 'ok' && /#v9$/.test(page.url()), 'OK opens the highlighted link: ' + page.url());
  await browser.close();
  console.log('PASS link navigation: arrows move between links in the right direction, scroll, and OK opens');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
