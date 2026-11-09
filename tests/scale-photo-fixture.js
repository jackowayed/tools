// A disconnected seven-segment display with colon, decimal and spare margins.
export function scaleFixture(pounds = '12', ounces = '6.2', { colon = true, color = [30, 120, 180] } = {}) {
  const width = 650, height = 300, data = new Uint8ClampedArray(width * height * 4);
  function rect(x, y, w, h) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) data.set([...color, 255], (yy * width + xx) * 4);
  }
  // Segment order: top, upper right, lower right, bottom, lower left, upper left, middle.
  const digits = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
  const boxes = [[12,0,56,12],[68,14,12,70],[68,96,12,70],[12,168,56,12],[0,96,12,70],[0,14,12,70],[12,84,56,12]];
  let x = 25;
  for (const char of `${pounds}:${ounces}`) {
    if (char === ':') { if (colon) { rect(x + 6, 100, 10, 10); rect(x + 6, 170, 10, 10); } x += 45; continue; }
    if (char === '.') { rect(x - 8, 216, 8, 8); continue; }
    for (const segment of digits[Number(char)]) { const [dx, dy, w, h] = boxes[segment.charCodeAt(0) - 97]; rect(x + dx, 50 + dy, w, h); }
    x += 100;
  }
  return { width, height, data };
}

