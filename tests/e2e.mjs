// DSH Green Pack - E2E smoke test via Playwright
// 启动 dsh web (默认 http://127.0.0.1:3080) 后由 CI 调用, 截图并做基础断言。
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.DSH_URL || 'http://127.0.0.1:3080';
const OUT = process.env.SHOT || 'shot.png';

console.log('[e2e] target URL =', URL);
console.log('[e2e] screenshot out =', OUT);

mkdirSync('screenshots', { recursive: true });

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  // 给 SPA / 异步内容一点时间渲染
  await page.waitForTimeout(3000);

  const title = await page.title();
  const bodyText = await page.locator('body').innerText();
  const bodyLen = bodyText.length;
  console.log('[e2e] PAGE TITLE =', JSON.stringify(title));
  console.log('[e2e] BODY TEXT LENGTH =', bodyLen);

  // 首屏截图
  await page.screenshot({ path: OUT });
  console.log('[e2e] saved', OUT);

  // 再等一会儿截第二张, 捕获延迟加载内容
  await page.waitForTimeout(2000);
  const OUT2 = OUT.replace(/(\.[^.]+)$/, '-2$1');
  await page.screenshot({ path: OUT2 });
  console.log('[e2e] saved', OUT2);

  if (consoleErrors.length) {
    console.log('[e2e] CONSOLE ERRORS:', consoleErrors.slice(0, 10));
  }

  // dsh (>=0.1.2-rc.1) 强制 token: 裸 URL 会渲染认证提示页, 必须视为失败
  if (/authentication required/i.test(bodyText)) {
    console.error('[e2e] FAIL: dsh web shows authentication page (token missing or invalid)');
    process.exit(1);
  }

  if (bodyLen < 5) {
    console.error('[e2e] FAIL: page body too empty');
    process.exit(1);
  }
  console.log('[e2e] PASS');
} finally {
  await browser.close();
}
