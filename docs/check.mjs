import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 1300 } });
await p.goto('file:///home/cosmic/app/slrbooth-clone/docs/architecture.html', { waitUntil: 'networkidle' });
await p.waitForTimeout(600);

const res = await p.evaluate(() => {
  const svg = document.querySelector('svg');
  const texts = [...svg.querySelectorAll('text')];
  // component boxes = rects with stroke, width between 150 and 300
  const boxes = [...svg.querySelectorAll('rect')].filter(r => {
    const w = +r.getAttribute('width'), h = +r.getAttribute('height');
    return w >= 150 && w <= 300 && h >= 60 && h <= 150;
  }).map(r => ({
    x: +r.getAttribute('x'), y: +r.getAttribute('y'),
    w: +r.getAttribute('width'), h: +r.getAttribute('height')
  }));
  const issues = [];
  for (const t of texts) {
    const bb = t.getBBox();
    const cx = bb.x + bb.width/2, cy = bb.y + bb.height/2;
    // find containing box
    const box = boxes.find(b => cx >= b.x && cx <= b.x+b.w && cy >= b.y && cy <= b.y+b.h);
    if (!box) continue;
    if (bb.x < box.x - 2 || bb.x + bb.width > box.x + box.w + 2) {
      issues.push({ text: t.textContent, bbW: +bb.width.toFixed(1), boxW: box.w,
                    overL: +(box.x - bb.x).toFixed(1), overR: +((bb.x+bb.width)-(box.x+box.w)).toFixed(1) });
    }
    if (bb.y < box.y - 2 || bb.y + bb.height > box.y + box.h + 2) {
      issues.push({ text: t.textContent, VERT: true, bbY: +bb.y.toFixed(1), bbH: +bb.height.toFixed(1) });
    }
  }
  // SVG bounds check
  const vb = svg.viewBox.baseVal;
  let outOfCanvas = [];
  for (const t of texts) {
    const bb = t.getBBox();
    if (bb.x < 0 || bb.y < 0 || bb.x+bb.width > vb.width || bb.y+bb.height > vb.height)
      outOfCanvas.push({ text: t.textContent, x:+bb.x.toFixed(1), y:+bb.y.toFixed(1),
                         r:+(bb.x+bb.width).toFixed(1), b:+(bb.y+bb.height).toFixed(1) });
  }
  return { issues, outOfCanvas, viewBox: [vb.width, vb.height], nTexts: texts.length, nBoxes: boxes.length };
});
console.log(JSON.stringify(res, null, 1));
await b.close();
