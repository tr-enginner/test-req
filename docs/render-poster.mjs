import { chromium } from 'playwright';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

const htmlPath = resolve('C:/Users/12333/projects/matrix/matrix-embedded-agent/docs/poster.html');
const outPath = resolve('C:/Users/12333/projects/matrix/matrix-embedded-agent/docs/matrix-poster.png');

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--force-device-scale-factor=1'],
});

const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// Debug: check actual body dimensions
const dims = await page.evaluate(() => {
  const b = document.body;
  return {
    bodyWidth: b.offsetWidth,
    bodyHeight: b.offsetHeight,
    scrollWidth: b.scrollWidth,
    innerWidth: window.innerWidth,
    dpr: window.devicePixelRatio,
  };
});
console.log('Page dimensions:', dims);

await page.screenshot({ path: outPath, type: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080 } });
await browser.close();
console.log('Poster saved to:', outPath);
