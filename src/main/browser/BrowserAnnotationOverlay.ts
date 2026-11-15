import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import type { BrowserAnnotation } from '../../shared/contracts/browser';
import type { BrowserCdpClient } from './CdpClient';

const OVERLAY_KEY = '__fateBrowserAnnotationOverlayV1__';

export class BrowserAnnotationOverlay {
  private readonly binding = `fateAnnotation${randomUUID().replaceAll('-', '')}`;
  private readonly contexts = new Map<string, number>();
  private readonly badges = new Map<number, string>();
  private hoveredId: string | undefined;
  private highlightSequence = 0;
  private readonly onMessage = (_event: Electron.Event, method: string, params: unknown) => {
    if (method === 'Overlay.nodeHighlightRequested' && this.badges.size > 0 && params && typeof params === 'object') {
      const nodeId = (params as { nodeId?: number }).nodeId;
      if (nodeId) void this.updateInspectorHover(nodeId);
      return;
    }
    if (method !== 'Runtime.bindingCalled' || !params || typeof params !== 'object') return;
    const event = params as { name?: string; payload?: string; executionContextId?: number };
    if (event.name === this.binding && event.payload && this.contexts.get(event.payload) === event.executionContextId) {
      this.onRemove(event.payload);
    }
  };

  constructor(private readonly cdp: BrowserCdpClient, private readonly contents: WebContents, private readonly onRemove: (id: string) => void) {
    contents.debugger.on('message', this.onMessage);
  }

  dispose(): void {
    if (!this.contents.isDestroyed()) this.contents.debugger.off('message', this.onMessage);
    this.contexts.clear();
    this.badges.clear();
    this.highlightSequence += 1;
    this.hoveredId = undefined;
  }

  annotationForBadge(backendNodeId: number): string | undefined {
    return this.badges.get(backendNodeId);
  }

  private async updateInspectorHover(nodeId: number): Promise<void> {
    const sequence = ++this.highlightSequence;
    const description = await this.cdp.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { nodeId, depth: 0 }).catch(() => null);
    if (sequence !== this.highlightSequence) return;
    const id = description ? this.badges.get(description.node.backendNodeId) : undefined;
    if (id === this.hoveredId) return;
    const previous = this.hoveredId;
    this.hoveredId = id;
    await Promise.all([previous, id].flatMap((markerId) => {
      if (!markerId) return [];
      const contextId = this.contexts.get(markerId);
      if (!contextId) return [];
      return [this.cdp.send('Runtime.evaluate', {
        expression: `globalThis[${JSON.stringify(OVERLAY_KEY)}]?.setHovered(${JSON.stringify(markerId)}, ${markerId === id})`,
        contextId,
        silent: true,
        returnByValue: true,
      }).catch(() => undefined)];
    }));
  }

  async add(annotation: BrowserAnnotation, label: number): Promise<void> {
    const backendNodeId = annotation.target.backendNodeId;
    if (!backendNodeId || !this.cdp.supports('Runtime')) return;
    await this.cdp.send('DOM.getDocument', { depth: 0, pierce: true });
    const world = await this.cdp.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId: annotation.target.frameId,
      worldName: this.binding,
    });
    await this.cdp.send('Runtime.addBinding', { name: this.binding, executionContextId: world.executionContextId });
    const resolved = await this.cdp.send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId, executionContextId: world.executionContextId }).catch(() => ({ object: undefined }));
    if (!resolved.object?.objectId) return;
    const result = await this.cdp.send<{ result?: { objectId?: string } }>('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: markerFunction,
      arguments: [
        { value: OVERLAY_KEY },
        { value: annotation.id },
        { value: String(label) },
        { value: this.binding },
      ],
      silent: true,
    });
    if (!result.result?.objectId) return;
    const badge = await this.cdp.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId: result.result.objectId });
    for (const [nodeId, id] of this.badges) if (id === annotation.id) this.badges.delete(nodeId);
    this.badges.set(badge.node.backendNodeId, annotation.id);
    this.contexts.set(annotation.id, world.executionContextId);
    await Promise.all([resolved.object.objectId, result.result.objectId].map((objectId) => (
      this.cdp.send('Runtime.releaseObject', { objectId }).catch(() => undefined)
    )));
  }

  async pulse(id: string): Promise<void> {
    if (!this.cdp.supports('Runtime')) return;
    await this.cdp.send('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(OVERLAY_KEY)}]?.pulse(${JSON.stringify(id)})`,
      contextId: this.contexts.get(id),
      silent: true,
      returnByValue: true,
    }).catch(() => undefined);
  }

  async remove(id: string): Promise<void> {
    if (!this.cdp.supports('Runtime')) return;
    const contextId = this.contexts.get(id);
    this.contexts.delete(id);
    if (this.hoveredId === id) this.hoveredId = undefined;
    for (const [nodeId, annotationId] of this.badges) if (annotationId === id) this.badges.delete(nodeId);
    if (!contextId) return;
    await this.cdp.send('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(OVERLAY_KEY)}]?.remove(${JSON.stringify(id)})`,
      contextId,
      silent: true,
      returnByValue: true,
    }).catch(() => undefined);
  }

  async setLabel(id: string, label: number): Promise<void> {
    const contextId = this.contexts.get(id);
    if (!contextId) return;
    await this.cdp.send('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(OVERLAY_KEY)}]?.setLabel(${JSON.stringify(id)}, ${JSON.stringify(String(label))})`,
      contextId,
      silent: true,
      returnByValue: true,
    }).catch(() => undefined);
  }

  async clear(): Promise<void> {
    const contexts = new Set(this.contexts.values());
    this.contexts.clear();
    this.badges.clear();
    this.highlightSequence += 1;
    this.hoveredId = undefined;
    if (!this.cdp.supports('Runtime')) return;
    await Promise.all([...contexts].map((contextId) => this.cdp.send('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(OVERLAY_KEY)}]?.clear()`,
      contextId,
      silent: true,
      returnByValue: true,
    }).catch(() => undefined)));
  }
}

const markerFunction = `function(key, id, label, binding) {
  const target = this;
  let state = globalThis[key];
  if (!state) {
    const root = document.createElement('div');
    root.dataset.piBrowserOverlay = 'annotations';
    Object.assign(root.style, {
      position: 'fixed', inset: '0', zIndex: '2147483646', pointerEvents: 'none',
      contain: 'layout style paint', overflow: 'visible'
    });
    (document.documentElement || document.body).appendChild(root);
    const markers = new Map();
    let frame = 0;
    const update = () => {
      frame = 0;
      for (const marker of markers.values()) {
        if (!marker.target.isConnected) {
          marker.outline.style.display = 'none';
          continue;
        }
        const rect = marker.target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) {
          marker.outline.style.display = 'none';
          continue;
        }
        marker.outline.style.display = 'block';
        marker.outline.style.transform = 'translate(' + rect.left + 'px,' + rect.top + 'px)';
        marker.outline.style.width = rect.width + 'px';
        marker.outline.style.height = rect.height + 'px';
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    addEventListener('scroll', schedule, true);
    addEventListener('resize', schedule, true);
    state = {
      add(targetNode, markerId, markerLabel) {
        this.remove(markerId);
        const outline = document.createElement('div');
        outline.dataset.piBrowserOverlay = 'annotation';
        Object.assign(outline.style, {
          position: 'absolute', left: '0', top: '0', boxSizing: 'border-box',
          border: '2px solid rgb(124,108,255)', borderRadius: '4px',
          background: 'rgba(124,108,255,.10)', boxShadow: '0 0 0 1px rgba(9,11,18,.55)',
          transition: 'opacity 120ms ease-out'
        });
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.setAttribute('aria-label', 'Remove annotation ' + markerLabel);
        badge.title = 'Remove annotation';
        badge.textContent = markerLabel;
        Object.assign(badge.style, {
          position: 'absolute', right: '-8px', top: '-10px', minWidth: '20px', height: '20px',
          padding: '0 5px', boxSizing: 'border-box', display: 'grid', placeItems: 'center',
          borderRadius: '10px', color: '#fff', background: 'rgb(124,108,255)',
          boxShadow: '0 2px 8px rgba(9,11,18,.42)', font: '600 11px/20px ui-sans-serif,system-ui,sans-serif',
          pointerEvents: 'auto', cursor: 'pointer', border: '0', margin: '0', appearance: 'none', textTransform: 'none'
        });
        for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) {
          badge.addEventListener(type, (event) => event.stopPropagation());
        }
        badge.addEventListener('focus', () => { badge.textContent = '×'; });
        badge.addEventListener('blur', () => { badge.textContent = markers.get(markerId)?.label || markerLabel; });
        badge.addEventListener('pointerenter', () => { badge.textContent = '×'; });
        badge.addEventListener('pointerleave', () => { badge.textContent = markers.get(markerId)?.label || markerLabel; });
        badge.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (event.isTrusted) globalThis[binding](markerId);
        });
        outline.appendChild(badge);
        root.appendChild(outline);
        markers.set(markerId, { target: targetNode, outline, badge, label: markerLabel });
        schedule();
        return badge;
      },
      setHovered(markerId, hovered) {
        const marker = markers.get(markerId);
        if (marker) marker.badge.textContent = hovered ? '×' : marker.label;
      },
      setLabel(markerId, markerLabel) {
        const marker = markers.get(markerId);
        if (!marker) return;
        marker.label = markerLabel;
        marker.badge.setAttribute('aria-label', 'Remove annotation ' + markerLabel);
        if (!marker.badge.matches(':hover')) marker.badge.textContent = markerLabel;
      },
      remove(markerId) {
        const marker = markers.get(markerId);
        if (!marker) return;
        marker.outline.remove();
        markers.delete(markerId);
      },
      pulse(markerId) {
        const marker = markers.get(markerId);
        if (!marker) return;
        marker.target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        marker.outline.animate(
          [{ opacity: 1, filter: 'brightness(1)' }, { opacity: .45, filter: 'brightness(1.8)' }, { opacity: 1, filter: 'brightness(1)' }],
          { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)' }
        );
        schedule();
      },
      clear() {
        for (const marker of markers.values()) marker.outline.remove();
        markers.clear();
        root.remove();
        removeEventListener('scroll', schedule, true);
        removeEventListener('resize', schedule, true);
        delete globalThis[key];
      }
    };
    globalThis[key] = state;
  }
  return state.add(target, id, label);
}`;
