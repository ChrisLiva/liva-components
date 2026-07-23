// jsdom stubs the antd skin's primitives need and jsdom does not implement.
// The base-ui skin needs none of this; it is here only because antd's Modal and
// Segmented reach for these browser APIs on mount and would throw in jsdom
// without them. Add a stub only when a test proves antd demands it.

// antd's responsive tokens read matchMedia; jsdom has no media engine.
if (typeof window.matchMedia !== "function") {
	window.matchMedia = (query: string): MediaQueryList =>
		({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		}) as unknown as MediaQueryList;
}

// rc-resize-observer, behind antd's Segmented and Modal, constructs a
// ResizeObserver on mount; jsdom ships none.
if (typeof globalThis.ResizeObserver === "undefined") {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
}
