/**
 * jsdom doesn't implement pointer-capture APIs, scrollIntoView, or
 * ResizeObserver — all of which Radix primitives (Select, Popover,
 * Checkbox, DropdownMenu, etc.) call during open/close/layout. Install
 * no-op stubs so fireEvent drives the components through their normal
 * paths without throwing.
 *
 * Call from a beforeEach block in any test that renders a Radix
 * component with a popover surface or any hidden-input helper.
 */
export function installRadixJsdomPolyfills(): void {
  if (!("hasPointerCapture" in Element.prototype)) {
    (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture =
      () => false;
  }
  if (!("releasePointerCapture" in Element.prototype)) {
    (Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture =
      () => {};
  }
  if (!("scrollIntoView" in Element.prototype)) {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
      () => {};
  }
  if (typeof globalThis.ResizeObserver === "undefined") {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class ResizeObserverStub {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      };
  }
}
