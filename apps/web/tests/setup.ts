import { Window } from "happy-dom";
import "fake-indexeddb/auto";

const win = new Window({ url: "http://localhost/" });
const browserGlobals = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "HTMLElement",
  "Element",
  "Node",
  "SVGElement",
  "DocumentFragment",
  "customElements",
  "MutationObserver",
  "CSSStyleDeclaration",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "IntersectionObserver",
  "IntersectionObserverEntry",
  "ResizeObserver",
  "MediaQueryList",
  "localStorage",
  "sessionStorage",
] as const;

for (const key of browserGlobals) {
  (globalThis as Record<string, unknown>)[key] = (win as unknown as Record<string, unknown>)[key];
}

(globalThis as Record<string, unknown>).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: FrameRequestCallback): number =>
  setTimeout(() => callback(Date.now()), 0) as unknown as number;
(globalThis as Record<string, unknown>).cancelAnimationFrame = (handle: number): void => clearTimeout(handle);

const vue = await import("vue");
Object.assign(globalThis, vue);
