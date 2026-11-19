// Recognizer for blue seven-segment lb:oz displays. No photo leaves the device.
const PATTERNS = ['1110111', '0010010', '1011101', '1011011', '0111010', '1101011', '1101111', '1010010', '1111111', '1111011'];
const unreadable = () => new Error('Could not read the display clearly. Try a straight-on close-up with flash off, or enter the weight manually.');

export function readScalePixels({ data, width, height }) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const [r, g, b] = data.subarray(i * 4, i * 4 + 3);
    mask[i] = b > 45 && b > r * 1.4 && g > r * 1.2 && b > g * 1.08 ? 1 : 0;
  }
  // Connected components discard dust, punctuation and the small lb:oz label
  // when locating the large digit segments. Keep punctuation for unit splitting.
  const seen = new Uint8Array(mask.length), components = [];
  const queue = new Int32Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    let head = 0, tail = 1;
    queue[0] = i; seen[i] = 1;
    const c = { x0: width, x1: 0, y0: height, y1: 0, area: 0 };
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width);
      c.x0 = Math.min(c.x0, x); c.x1 = Math.max(c.x1, x);
      c.y0 = Math.min(c.y0, y); c.y1 = Math.max(c.y1, y); c.area++;
      for (const n of [x > 0 ? p - 1 : -1, x + 1 < width ? p + 1 : -1, p - width, p + width]) {
        if (n >= 0 && n < mask.length && mask[n] && !seen[n]) { seen[n] = 1; queue[tail++] = n; }
      }
    }
    if (c.area >= 4) components.push(c);
  }
  const longest = Math.max(0, ...components.map(c => c.y1 - c.y0));
  if (longest < 15) throw unreadable();
  const segments = components.filter(c => Math.max(c.x1 - c.x0, c.y1 - c.y0) >= longest * .45 && c.area > longest * 1.5);
  if (!segments.length) throw unreadable();
  const y0 = Math.min(...segments.map(c => c.y0)), y1 = Math.max(...segments.map(c => c.y1));
  const h = y1 - y0 + 1;
  const groups = [];
  for (const c of segments.sort((a, b) => a.x0 - b.x0)) {
    const last = groups.at(-1);
    if (last && c.x0 <= last.x1 + h * .035) {
      last.x1 = Math.max(last.x1, c.x1); last.y0 = Math.min(last.y0, c.y0); last.y1 = Math.max(last.y1, c.y1);
    } else groups.push({ ...c });
  }
  if (groups.length < 3 || groups.length > 5 || groups.some(c => c.y1 - c.y0 < h * .75)) throw unreadable();
  const digits = groups.map(c => {
    const w = c.x1 - c.x0 + 1;
    const density = (xa, ya, xb, yb) => {
      let hits = 0, total = 0;
      for (let y = Math.round(y0 + h * ya); y < Math.min(height, y0 + h * yb); y++) {
        for (let x = Math.round(c.x0 + w * xa); x < Math.min(width, c.x0 + w * xb); x++) { hits += mask[y * width + x]; total++; }
      }
      return total ? hits / total : 0;
    };
    if (w < h * .18) {
      if (density(0, .15, 1, .4) > .35 && density(0, .6, 1, .85) > .35) return '1';
      throw unreadable();
    }
    if (w > h * .8) throw unreadable();
    const regions = [[.25,0,.75,.13],[0,.16,.25,.4],[.75,.16,1,.4],[.25,.43,.75,.57],[0,.6,.25,.84],[.75,.6,1,.84],[.25,.87,.75,1]];
    const values = regions.map(r => density(...r));
    // Reject uncertain segments rather than guessing the nearest digit.
    if (values.some(v => v > .15 && v < .32)) throw unreadable();
    const digit = PATTERNS.indexOf(values.map(v => v >= .32 ? '1' : '0').join(''));
    if (digit < 0) throw unreadable();
    return String(digit);
  });
  // Locate the colon between pounds and ounces (two small blue dots).
  const splits = [];
  for (let i = 1; i <= 2 && i < groups.length - 1; i++) {
    const dots = components.filter(c => c.x0 > groups[i - 1].x1 && c.x1 < groups[i].x0 && c.y1 - c.y0 < h * .15 && c.x1 - c.x0 < h * .15);
    if (dots.some(c => (c.y0 + c.y1) / 2 > y0 + h * .2 && (c.y0 + c.y1) / 2 < y0 + h * .4)
      && dots.some(c => (c.y0 + c.y1) / 2 > y0 + h * .6 && (c.y0 + c.y1) / 2 < y0 + h * .8)) splits.push(i);
  }
  if (splits.length !== 1) throw unreadable();
  const split = splits[0], ozDigits = digits.slice(split).join('');
  if (ozDigits.length < 2 || ozDigits.length > 3) throw unreadable();
  const pounds = Number(digits.slice(0, split).join('')), ounces = Number(ozDigits) / 10;
  if (ounces >= 16 || pounds + ounces / 16 <= 0 || pounds + ounces / 16 > 66) throw unreadable();
  return { pounds, ounces };
}

export async function readScalePhoto(file, preview) {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image of the scale.');
  if (file.size > 20 * 1024 * 1024) throw new Error('Choose a photo smaller than 20 MB.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url;
    try { await img.decode(); } catch { throw new Error('This image could not be opened. Try a JPEG or PNG photo.'); }
    const scale = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
    preview.width = Math.round(img.naturalWidth * scale); preview.height = Math.round(img.naturalHeight * scale);
    const ctx = preview.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, preview.width, preview.height);
    preview.hidden = false;
    return readScalePixels(ctx.getImageData(0, 0, preview.width, preview.height));
  } finally { URL.revokeObjectURL(url); }
}
