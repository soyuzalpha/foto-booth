import { chromium } from 'playwright';

const src = process.argv[2];
const out = process.argv[3];

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 1300 }, deviceScaleFactor: 2 });
await p.goto('file://' + src, { waitUntil: 'networkidle' });
await p.waitForTimeout(900);
const el = await p.$('.wrap');
await el.screenshot({ path: out });
await b.close();
console.log('OK', out);
