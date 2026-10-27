import { desktopCapturer, screen, type Display, type NativeImage } from 'electron';

const MAX_WIDTH = 1280;
const MAX_HEIGHT = 800;
const MAX_ZOOM = 4;

export interface ScreenTarget {
  readonly display: Display;
  readonly number: number;
  readonly width: number;
  readonly height: number;
}

export interface EncodedImage {
  readonly data: string;
  readonly mimeType: string;
}

export function orderedDisplays(): Display[] {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays()
    .filter((display) => display.id !== primary.id)
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  return [primary, ...others];
}

export function screenTarget(display: Display, number: number): ScreenTarget {
  const scale = Math.min(1, MAX_WIDTH / display.bounds.width, MAX_HEIGHT / display.bounds.height);
  return { display, number, width: Math.round(display.bounds.width * scale), height: Math.round(display.bounds.height * scale) };
}

export function toScreenPoint(target: ScreenTarget, [x, y]: readonly [number, number]): { x: number; y: number } {
  if (x < 0 || y < 0 || x > target.width || y > target.height) {
    throw new Error(`(${x}, ${y}) is outside the ${target.width}×${target.height} screenshot of display ${target.number}.`);
  }
  const { bounds } = target.display;
  return { x: bounds.x + (x * bounds.width) / target.width, y: bounds.y + (y * bounds.height) / target.height };
}

export function fromScreenPoint(target: ScreenTarget, point: { x: number; y: number }): [number, number] {
  const { bounds } = target.display;
  return [
    Math.round(((point.x - bounds.x) * target.width) / bounds.width),
    Math.round(((point.y - bounds.y) * target.height) / bounds.height),
  ];
}

export async function captureScreen(target: ScreenTarget): Promise<EncodedImage> {
  const image = await captureDisplay(target.display, { width: target.width, height: target.height });
  const size = image.getSize();
  const exact = size.width === target.width && size.height === target.height ? image : image.resize({ width: target.width, height: target.height, quality: 'best' });
  return encode(exact);
}

export async function captureRegion(target: ScreenTarget, [x1, y1, x2, y2]: readonly [number, number, number, number]): Promise<EncodedImage> {
  if (x2 <= x1 || y2 <= y1) throw new Error('A zoom region needs x1 < x2 and y1 < y2.');
  const topLeft = toScreenPoint(target, [x1, y1]);
  const bottomRight = toScreenPoint(target, [x2, y2]);
  const { bounds, scaleFactor } = target.display;
  const full = await captureDisplay(target.display, { width: Math.round(bounds.width * scaleFactor), height: Math.round(bounds.height * scaleFactor) });
  const fullSize = full.getSize();
  const pixels = fullSize.width / bounds.width;
  const x = Math.min(fullSize.width - 1, Math.round((topLeft.x - bounds.x) * pixels));
  const y = Math.min(fullSize.height - 1, Math.round((topLeft.y - bounds.y) * pixels));
  const crop = {
    x,
    y,
    width: Math.max(1, Math.min(fullSize.width - x, Math.round((bottomRight.x - topLeft.x) * pixels))),
    height: Math.max(1, Math.min(fullSize.height - y, Math.round((bottomRight.y - topLeft.y) * pixels))),
  };
  const scale = Math.min(MAX_ZOOM, MAX_WIDTH / crop.width, MAX_HEIGHT / crop.height);
  return encode(full.crop(crop).resize({ width: Math.round(crop.width * scale), height: Math.round(crop.height * scale), quality: 'best' }));
}

async function captureDisplay(display: Display, size: { width: number; height: number }): Promise<NativeImage> {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size, fetchWindowIcons: false });
  const displays = screen.getAllDisplays();
  const source = sources.find((candidate) => candidate.display_id === String(display.id))
    ?? (sources.length === displays.length ? sources[displays.findIndex((candidate) => candidate.id === display.id)] : undefined)
    ?? (sources.length === 1 ? sources[0] : undefined);
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error(process.platform === 'darwin'
      ? 'macOS blocked the screenshot. Allow Fate UI in System Settings › Privacy & Security › Screen Recording, then restart Fate UI.'
      : 'The screen could not be captured. Unlock the screen and try again.');
  }
  return source.thumbnail;
}

function encode(image: NativeImage): EncodedImage {
  return { data: image.toJPEG(82).toString('base64'), mimeType: 'image/jpeg' };
}
