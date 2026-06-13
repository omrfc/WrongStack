import { chromium } from '@playwright/test';

const URL = 'http://127.0.0.1:5199/__verify__/index.html';
const consoleErrors = [];
const pageErrors = [];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => pageErrors.push(String(e?.stack || e)));

await page.goto(URL, { waitUntil: 'load', timeout: 30_000 });

// Wait for the harness to seed + ChatView to mount at least one bubble.
await page
  .waitForFunction(() => {
    const v = window.__verify;
    return v && typeof v.mountedBubbles === 'function' && v.mountedBubbles() > 0;
  }, { timeout: 30_000 })
  .catch(() => {});

await page.waitForTimeout(800); // let virtua settle measurements

const total = await page.evaluate(() => window.__verify?.total ?? -1);
const mountedTop = await page.evaluate(() => window.__verify?.mountedBubbles?.() ?? -1);
const domTotalNodes = await page.evaluate(() => document.querySelectorAll('*').length);
const vlistPresent = await page.evaluate(
  () => !!document.querySelector('[data-message-id]') && document.querySelectorAll('[data-message-id]').length > 0,
);

await page.screenshot({ path: '__verify__/shot-top.png', fullPage: false });

// Scroll the virtua viewport down and confirm the mounted set is still bounded
// AND that different messages are now in the DOM (true windowing, not "render all").
const idsTop = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-message-id]')).map((e) => e.getAttribute('data-message-id')),
);
await page.evaluate(() => {
  // virtua's VList is the scroll container; find the scrollable element.
  const scrollers = Array.from(document.querySelectorAll('*')).filter((el) => {
    const s = getComputedStyle(el);
    return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50;
  });
  // pick the tallest scroller (the message list)
  scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight);
  const sc = scrollers[0];
  if (sc) sc.scrollTop = Math.floor(sc.scrollHeight * 0.5);
});
await page.waitForTimeout(600);
const mountedMid = await page.evaluate(() => window.__verify?.mountedBubbles?.() ?? -1);
const idsMid = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-message-id]')).map((e) => e.getAttribute('data-message-id')),
);
await page.screenshot({ path: '__verify__/shot-mid.png', fullPage: false });

const overlap = idsTop.filter((id) => idsMid.includes(id)).length;

console.log(JSON.stringify({
  total,
  mountedTop,
  mountedMid,
  domTotalNodes,
  vlistPresent,
  windowMovedAfterScroll: overlap < idsTop.length, // some top bubbles unmounted after scroll
  topSetSize: idsTop.length,
  midSetSize: idsMid.length,
  overlapBetweenTopAndMid: overlap,
  pageErrors,
  consoleErrors: consoleErrors.slice(0, 20),
}, null, 2));

await browser.close();
