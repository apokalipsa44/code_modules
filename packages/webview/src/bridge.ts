import type {
  FromExtensionToWebview,
  FromWebviewToExtension,
} from '@nodecode/core';

/** Typed bridge to the extension host (acquireVsCodeApi is available in webviews). */
export interface VsCodeApi {
  postMessage(msg: FromWebviewToExtension): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

let cached: VsCodeApi | null = null;

export function getVsCodeApi(): VsCodeApi {
  if (!cached) {
    cached = (globalThis as unknown as { acquireVsCodeApi(): VsCodeApi }).acquireVsCodeApi();
  }
  return cached;
}

export type Listener = (msg: FromExtensionToWebview) => void;

const listeners = new Set<Listener>();

export function onMessage(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('message', (ev: MessageEvent<FromExtensionToWebview>) => {
    for (const l of listeners) l(ev.data);
  });
}

export function send(intent: FromWebviewToExtension): void {
  getVsCodeApi().postMessage(intent);
}
