/*
 * Detrace browser checks: loads the real page in Chrome and exercises the
 * experiment workflow UI end to end. Screenshots to ./shots/.
 * Run: node tests/browser-check.mjs   (needs playwright + local chrome)
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SHOTS = path.join(ROOT, 'shots');
mkdirSync(SHOTS, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  try {
    const p = path.join(ROOT, req.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('nope');
  }
});
await new Promise((r) => server.listen(8099, r));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok' : 'NOT OK'} - ${name}${detail ? ' :: ' + detail : ''}`);
};

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await ctx.newPage();
page.on('pageerror', (e) => check('no page errors', false, String(e)));

// 1. basic load
await page.goto('http://127.0.0.1:8099/', { waitUntil: 'load' });
await page.waitForTimeout(1200);
check('page title', (await page.title()).includes('Detrace'));
check('cluster renders 5 nodes', (await page.locator('#cluster g.node-circle').count()) === 5);
const events0 = Number(await page.locator('#stat-events').textContent());
check('simulation advances', events0 > 0, `events=${events0}`);

// 2. bug scenario fires a monitor
await page.selectOption('#scenario', 'bugEarlyCommit');
await page.waitForTimeout(2500);
const badBadge = await page.locator('#invariants .badge.bad').count();
check('injected bug trips a monitor', badBadge >= 1, `bad badges=${badBadge}`);

// 3. builder: apply a custom schedule
await page.selectOption('#scenario', 'clean');
await page.locator('#builder-panel summary').click();
await page.locator('#sched-add').click();
await page.locator('#sched-add').click();
// second row -> partition with overlapping sides (invalid)
const rows = page.locator('#sched-rows .sched-row');
await rows.nth(1).locator('select').selectOption('partition');
await rows.nth(1).locator('.sched-side').first().fill('0,1,2');
await rows.nth(1).locator('.sched-side').last().fill('2,3');
await page.locator('#sched-apply').click();
const outInvalid = await page.locator('#sched-out').textContent();
check('builder rejects overlapping partition', /not applied/.test(outInvalid), outInvalid.slice(0, 80));
// fix to a valid partition
await rows.nth(1).locator('.sched-side').last().fill('3,4');
await page.locator('#sched-apply').click();
const outValid = await page.locator('#sched-out').textContent();
check('builder applies valid custom schedule', /^applied:/.test(outValid), outValid.slice(0, 60));
check('scenario dropdown marks custom', (await page.locator('#scenario').inputValue()) === '__custom');
await page.screenshot({ path: path.join(SHOTS, 'builder.png') });

// 4. share link round-trips through boot
await page.locator('#btn-share').click();
const clip = await page.evaluate(() => navigator.clipboard.readText());
check('share link copied', /\?cfg=/.test(clip), clip.slice(0, 60));
const page2 = await ctx.newPage();
await page2.goto(clip, { waitUntil: 'load' });
await page2.waitForTimeout(800);
check('share link boots custom experiment', (await page2.locator('#scenario').inputValue()) === '__custom');
const sharedOut = await page2.locator('#import-out').textContent();
check('share link boot message', /shared experiment link/.test(sharedOut));
// and the shared run reproduces the same digest as the source run at equal steps:
// restart both, pause both, then step both by the same +100 events
for (const p of [page, page2]) {
  await p.locator('#btn-play').click(); // pause first so the ticker cannot advance mid-setup
  await p.locator('#btn-restart').click();
  await p.locator('#btn-step').click(); // +100 events
}
await page.waitForTimeout(200); await page2.waitForTimeout(200);
const d1 = await page.locator('#stat-digest').textContent();
const d2 = await page2.locator('#stat-digest').textContent();
check('shared experiment reproduces digest', d1 === d2 && d1 !== '-', `${d1} vs ${d2}`);
await page2.close();

// 5. export -> import -> verified
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('#btn-export').click(),
]);
const recPath = path.join(SHOTS, 'recording.json');
await download.saveAs(recPath);
check('trace export downloads', true, await download.suggestedFilename());
const fileInput = page.locator('#import-file');
await fileInput.setInputFiles(recPath);
await page.waitForTimeout(1500);
const impOut = await page.locator('#import-out').textContent();
check('own recording verifies', /RECORDING VERIFIED/.test(impOut), impOut.slice(0, 90));

// 6. tampered/invalid import is rejected cleanly
await page.locator('#import-file').setInputFiles({
  name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"tool":"detrace","config":{}}'),
});
await page.waitForTimeout(400);
const badOut = await page.locator('#import-out').textContent();
check('invalid recording rejected with explicit state', /invalid recording/.test(badOut), badOut.slice(0, 70));

// 7. compare: clean-vs-clean identical, storm divergent
await page.selectOption('#scenario', 'clean');
await page.locator('#compare-panel summary').click();
await page.selectOption('#compare-src', 'scenario:clean');
await page.locator('#btn-compare').click();
await page.waitForTimeout(600);
const cmpSame = await page.locator('#compare-out').textContent();
check('compare identical configs', /^IDENTICAL/.test(cmpSame), cmpSame.slice(0, 70));
await page.selectOption('#compare-src', 'scenario:storm');
await page.locator('#btn-compare').click();
await page.waitForTimeout(800);
const cmpDiff = await page.locator('#compare-out').textContent();
check('compare finds divergence vs storm', /^DIVERGENT/.test(cmpDiff), cmpDiff.slice(0, 80));
check('divergence shows both sides', (await page.locator('.div-side').count()) === 2);
await page.screenshot({ path: path.join(SHOTS, 'compare.png') });

// 8. verify replay still works
await page.locator('#btn-verify').click();
await page.waitForTimeout(600);
const verOut = await page.locator('#verify-out').textContent();
check('verify replay matches', /REPLAY MATCH/.test(verOut), verOut.slice(0, 60));

// 9. full-page desktop shot + mobile shot
await page.screenshot({ path: path.join(SHOTS, 'desktop-full.png'), fullPage: true });
const mob = await browser.newContext({ viewport: { width: 390, height: 844 } });
const mp = await mob.newPage();
await mp.goto('http://127.0.0.1:8099/', { waitUntil: 'load' });
await mp.waitForTimeout(1000);
await mp.screenshot({ path: path.join(SHOTS, 'mobile.png'), fullPage: true });
check('mobile renders nodes', (await mp.locator('#cluster g.node-circle').count()) === 5);
await mob.close();

await ctx.close();
await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks pass`);
process.exit(failed.length ? 1 : 0);
