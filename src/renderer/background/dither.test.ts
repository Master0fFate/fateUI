import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyBackgroundEffect, BACKGROUND_EFFECTS, ditherColor, ditherMask, MAX_BACKGROUND_PIXELS, prepareBackground } from './dither';

const pixels = (red: number, alpha = 255) => new Uint8ClampedArray(Array.from({ length: 64 }, () => [red, red, red, alpha]).flat());
afterEach(() => vi.unstubAllGlobals());

describe('source-driven ordered image dithering', () => {
  it('preserves black gaps and white detail instead of adding an unrelated overlay', () => {
    expect(ditherMask(pixels(0), 8, 8).filter((_value, index) => index % 4 === 3).every((value) => value === 0)).toBe(true);
    expect(ditherMask(pixels(255), 8, 8).every((value) => value === 255)).toBe(true);
    expect(ditherMask(pixels(255, 0), 8, 8).filter((_value, index) => index % 4 === 3).every((value) => value === 0)).toBe(true);
  });
  it('turns middle gray into deterministic binary coverage without mutating the source', () => {
    const source = pixels(128);
    const result = ditherMask(source, 8, 8);
    expect(result).toEqual(ditherMask(source, 8, 8));
    expect(new Set(result)).toEqual(new Set([0, 255]));
    expect(result.filter((_value, index) => index % 4 === 3 && result[index] === 255)).toHaveLength(32);
    expect(source).toEqual(pixels(128));
  });
  it('bounds allocation and rejects malformed dimensions', () => {
    expect(() => ditherMask(new Uint8ClampedArray(), 0, 1)).toThrow();
    expect(() => ditherMask(pixels(128), 8, 7)).toThrow();
    expect(() => ditherMask(new Uint8ClampedArray(), MAX_BACKGROUND_PIXELS + 1, 1)).toThrow();
  });
  it('keeps hues in color mode and drops black to transparent gaps', () => {
    const red = new Uint8ClampedArray(Array.from({ length: 64 }, () => [255, 0, 0, 255]).flat());
    const result = ditherColor(red, 8, 8);
    for (let index = 0; index < result.length; index += 4) expect([...result.subarray(index, index + 4)]).toEqual([255, 0, 0, 255]);
    expect(ditherColor(pixels(0), 8, 8).filter((_value, index) => index % 4 === 3).every((value) => value === 0)).toBe(true);
    const mid = ditherColor(new Uint8ClampedArray(Array.from({ length: 64 }, () => [40, 120, 200, 255]).flat()), 8, 8);
    expect(mid).toEqual(ditherColor(new Uint8ClampedArray(Array.from({ length: 64 }, () => [40, 120, 200, 255]).flat()), 8, 8));
    expect(mid.filter((_value, index) => index % 4 !== 3).every((value) => [0, 85, 170, 255].includes(value))).toBe(true);
    expect(new Set(mid.filter((_value, index) => index % 4 === 2)).size).toBeGreaterThan(1);
  });
  it.each(BACKGROUND_EFFECTS)('%s keeps black transparent, lights bright input, and is deterministic', (effect) => {
    const size = 24;
    const fill = (value: number) => new Uint8ClampedArray(Array.from({ length: size * size }, () => [value, value * 0.6, value * 0.2, 255]).flat());
    const dark = applyBackgroundEffect(effect, fill(0), size, size);
    if (effect !== 'original' && effect !== 'scanlines') expect(dark.filter((_value, index) => index % 4 === 3).every((value) => value === 0)).toBe(true);
    const bright = applyBackgroundEffect(effect, fill(255), size, size);
    expect(bright.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
    expect(bright).toEqual(applyBackgroundEffect(effect, fill(255), size, size));
  });
  it('diamond grows rhombus dots with brightness', () => {
    const fill = (value: number) => new Uint8ClampedArray(Array.from({ length: 64 }, () => [value, value, value, 255]).flat());
    const lit = (value: number) => applyBackgroundEffect('diamond', fill(value), 8, 8).filter((alpha, index) => index % 4 === 3 && alpha > 0).length;
    expect(lit(60)).toBeLessThan(lit(160));
    expect(lit(160)).toBeLessThan(lit(255));
    // Corners of a rhombus cell stay empty below full brightness.
    expect(applyBackgroundEffect('diamond', fill(120), 8, 8)[3]).toBe(0);
  });
  it('rejects non-raster uploads and accepts 4K+ images by downscaling, not refusing', async () => {
    await expect(prepareBackground(new File(['<svg/>'], 'unsafe.svg', { type: 'image/svg+xml' }), 'color')).rejects.toThrow('PNG, JPEG, or WebP');
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 10_000, height: 10_000, close })));
    const drawImage = vi.fn();
    const context = { drawImage, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: vi.fn() };
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => tag === 'canvas'
      ? Object.assign(createElement('canvas'), { getContext: () => context, toBlob: (done: (blob: Blob) => void) => done(new Blob(['x'], { type: 'image/png' })) })
      : createElement(tag)) as typeof document.createElement);
    const result = await prepareBackground(new File(['png'], 'large.png', { type: 'image/png' }), 'diamond');
    expect(result.image.type).toBe('image/png');
    expect(result.source.type).toBe('image/png');
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 960, 960);
    expect(close).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
});
