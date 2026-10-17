export const MAX_BACKGROUND_PIXELS = 960 * 960;
/** Quantization steps per RGB channel in color mode: 4^3 = 64 retro colors. */
export const COLOR_DITHER_LEVELS = 4;

/**
 * `mono` is a theme-inked alpha mask; every other effect paints its own colors.
 * Dark source areas become transparent gaps so the effects sit on any theme.
 */
export const BACKGROUND_EFFECTS = ['mono', 'color', 'halftone', 'diamond', 'ascii', 'scanlines', 'original'] as const;
export type BackgroundEffect = typeof BACKGROUND_EFFECTS[number];
export const isBackgroundEffect = (value: unknown): value is BackgroundEffect => BACKGROUND_EFFECTS.includes(value as BackgroundEffect);

const bayer = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];

function assertBudget(source: Uint8ClampedArray, width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_BACKGROUND_PIXELS || source.length !== width * height * 4) {
    throw new Error('Background dimensions are outside the supported pixel budget.');
  }
}

/** Alpha-weighted perceptual luminance, 0-1. */
function luma(source: Uint8ClampedArray, offset: number): number {
  return (54 * source[offset]! + 183 * source[offset + 1]! + 19 * source[offset + 2]!) / (256 * 255) * source[offset + 3]! / 255;
}

/** Monochrome alpha mask; the theme supplies the ink color. */
export function ditherMask(source: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  assertBudget(source, width, height);
  const output = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const threshold = (bayer[(y % 8) * 8 + x % 8]! + 0.5) / 64;
      output[offset] = 255;
      output[offset + 1] = 255;
      output[offset + 2] = 255;
      output[offset + 3] = luma(source, offset) > threshold ? 255 : 0;
    }
  }
  return output;
}

/** Ordered per-channel dither to a fixed RGB palette; pure black becomes transparent. */
export function ditherColor(source: Uint8ClampedArray, width: number, height: number, levels = COLOR_DITHER_LEVELS): Uint8ClampedArray {
  assertBudget(source, width, height);
  if (!Number.isInteger(levels) || levels < 2 || levels > 256) throw new Error('Color dither levels must be 2-256.');
  const steps = levels - 1;
  const scale = 255 / steps;
  const output = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const threshold = (bayer[(y % 8) * 8 + x % 8]! + 0.5) / 64;
      const alpha = source[offset + 3]! / 255;
      let lit = false;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = source[offset + channel]! * alpha / 255 * steps;
        const base = Math.floor(value);
        const level = Math.min(steps, base + (value - base > threshold ? 1 : 0));
        if (level > 0) lit = true;
        output[offset + channel] = Math.round(level * scale);
      }
      output[offset + 3] = lit ? 255 : 0;
    }
  }
  return output;
}

/**
 * Cell screen shared by halftone and diamond: one dot per cell, sized by the
 * cell-center luminance and colored with that pixel. `distance` picks the dot
 * shape (Euclidean = round, Manhattan = diamond).
 */
function cellScreen(source: Uint8ClampedArray, width: number, height: number, cell: number, maxRadius: number,
  distance: (dx: number, dy: number) => number): Uint8ClampedArray {
  assertBudget(source, width, height);
  const output = new Uint8ClampedArray(source.length);
  const center = (cell - 1) / 2;
  for (let cy = 0; cy < height; cy += cell) {
    for (let cx = 0; cx < width; cx += cell) {
      const sample = (Math.min(height - 1, cy + Math.floor(cell / 2)) * width + Math.min(width - 1, cx + Math.floor(cell / 2))) * 4;
      const level = luma(source, sample);
      if (level <= 0.02) continue;
      const radius = maxRadius * Math.sqrt(level);
      // Hue at full strength: the dot size already carries brightness.
      const peak = Math.max(1, source[sample]!, source[sample + 1]!, source[sample + 2]!);
      const gain = 255 / peak;
      for (let dy = 0; dy < cell && cy + dy < height; dy += 1) {
        for (let dx = 0; dx < cell && cx + dx < width; dx += 1) {
          const coverage = Math.min(1, Math.max(0, radius + 0.5 - distance(dx - center, dy - center)));
          if (coverage <= 0) continue;
          const offset = ((cy + dy) * width + cx + dx) * 4;
          output[offset] = source[sample]! * gain;
          output[offset + 1] = source[sample + 1]! * gain;
          output[offset + 2] = source[sample + 2]! * gain;
          output[offset + 3] = coverage * 255;
        }
      }
    }
  }
  return output;
}

export const halftone = (source: Uint8ClampedArray, width: number, height: number) =>
  cellScreen(source, width, height, 6, 3.2, (dx, dy) => Math.hypot(dx, dy));

/** Rhombus screen: full brightness tiles into a seamless diamond lattice. */
export const diamond = (source: Uint8ClampedArray, width: number, height: number) =>
  cellScreen(source, width, height, 8, 4, (dx, dy) => Math.abs(dx) + Math.abs(dy));

// 5x7 bitmap glyphs by density: space . : - = + * # % @ (from Zeron).
const GLYPHS = [
  [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 4, 0], [0, 4, 0, 0, 4, 0, 0], [0, 0, 0, 14, 0, 0, 0], [0, 0, 14, 0, 14, 0, 0],
  [0, 4, 4, 31, 4, 4, 0], [0, 21, 14, 31, 14, 21, 0], [10, 10, 31, 10, 31, 10, 10], [17, 2, 4, 4, 8, 16, 17], [14, 17, 23, 21, 23, 16, 14],
] as const;

/** Glyph field: 6x8 cells, glyph density from luminance, ink from the cell color. */
export function ascii(source: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  assertBudget(source, width, height);
  const output = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x % 6 === 5 || y % 8 === 7) continue;
      const sample = (Math.min(height - 1, y - y % 8 + 4) * width + Math.min(width - 1, x - x % 6 + 3)) * 4;
      const glyph = GLYPHS[Math.min(9, Math.floor(Math.sqrt(luma(source, sample)) * 10))]!;
      if (!(glyph[y % 8]! & (1 << (4 - x % 6)))) continue;
      const offset = (y * width + x) * 4;
      const peak = Math.max(1, source[sample]!, source[sample + 1]!, source[sample + 2]!);
      output[offset] = source[sample]! * 255 / peak;
      output[offset + 1] = source[sample + 1]! * 255 / peak;
      output[offset + 2] = source[sample + 2]! * 255 / peak;
      output[offset + 3] = 255;
    }
  }
  return output;
}

/** CRT rows: every third line drops to half strength. */
export function scanlines(source: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  assertBudget(source, width, height);
  const output = new Uint8ClampedArray(source);
  for (let y = 0; y < height; y += 3) {
    for (let offset = y * width * 4; offset < (y + 1) * width * 4; offset += 4) output[offset + 3] = output[offset + 3]! * 0.4;
  }
  return output;
}

export function applyBackgroundEffect(effect: BackgroundEffect, source: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  switch (effect) {
    case 'mono': return ditherMask(source, width, height);
    case 'color': return ditherColor(source, width, height);
    case 'halftone': return halftone(source, width, height);
    case 'diamond': return diamond(source, width, height);
    case 'ascii': return ascii(source, width, height);
    case 'scanlines': return scanlines(source, width, height);
    case 'original': assertBudget(source, width, height); return new Uint8ClampedArray(source);
  }
}
