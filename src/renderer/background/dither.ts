import { applyBackgroundEffect, type BackgroundEffect } from '../../shared/dither';
export { applyBackgroundEffect, BACKGROUND_EFFECTS, ditherColor, ditherMask, isBackgroundEffect, MAX_BACKGROUND_PIXELS, type BackgroundEffect } from '../../shared/dither';
/** Generous guard against pathological files only; 4K/8K PNGs routinely exceed 12 MB. */
export const MAX_BACKGROUND_FILE_BYTES = 128 * 1024 * 1024;
const MAX_SIDE = 960;

export interface PreparedBackground {
  /** 960px-max copy kept so effects can switch without re-picking the file. */
  source: Blob;
  /** Rendered effect. */
  image: Blob;
}

function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The background could not be encoded.')), 'image/png'));
}

async function decode(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob).catch(() => { throw new Error('This image could not be decoded. Try a PNG, JPEG, or WebP file.'); });
}

/** Draws the bitmap downscaled to 960px; no megapixel cap because no per-pixel work happens before this. */
function draw(bitmap: ImageBitmap) {
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Image processing is unavailable in this environment.');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  return { canvas, context, width, height };
}

async function render(frame: ReturnType<typeof draw>, effect: BackgroundEffect): Promise<Blob> {
  const pixels = frame.context.getImageData(0, 0, frame.width, frame.height);
  pixels.data.set(applyBackgroundEffect(effect, pixels.data, frame.width, frame.height));
  frame.context.putImageData(pixels, 0, 0);
  return encode(frame.canvas);
}

export async function prepareBackground(file: File, effect: BackgroundEffect): Promise<PreparedBackground> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size === 0 || file.size > MAX_BACKGROUND_FILE_BYTES) {
    throw new Error('Choose a PNG, JPEG, or WebP image up to 128 MB.');
  }
  const bitmap = await decode(file);
  try {
    const frame = draw(bitmap);
    const source = await encode(frame.canvas);
    return { source, image: await render(frame, effect) };
  } finally {
    bitmap.close();
  }
}

/** Re-renders a stored 960px source with another effect. */
export async function renderBackgroundEffect(source: Blob, effect: BackgroundEffect): Promise<Blob> {
  const bitmap = await decode(source);
  try { return await render(draw(bitmap), effect); }
  finally { bitmap.close(); }
}
