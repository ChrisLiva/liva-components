import { readFileSync } from "node:fs";
import postcss, { type Container } from "postcss";
import { describe, expect, it } from "vitest";

// styles.css (the dev app's stylesheet) and registry.json's feedback-base-ui
// `css` field carry the same `lc-` accent block — one applied here, one shipped
// on `shadcn add`. Nothing else makes the two agree, so this parses the block
// out of the CSS and holds it against the JSON. Both files stay hand-authored;
// a drift in either — a renamed utility, a changed value, a dropped fallback —
// fails here with a diff naming the key that moved.

/** The nested-object shape registry.json's `css` field uses. */
type CssObject = { [key: string]: string | CssObject };

/**
 * Collapse the cosmetic whitespace that a multiline CSS value carries and its
 * one-line JSON twin does not, so the two compare on meaning rather than
 * formatting. Applied to both sides, so a real value change still fails.
 */
function normalizeValue(value: string): string {
	return value
		.replace(/\s+/g, " ")
		.replace(/\(\s+/g, "(")
		.replace(/\s+\)/g, ")")
		.replace(/\s*,\s*/g, ", ")
		.trim();
}

/** Recursively normalize every leaf value of a css object. */
function normalizeTree(node: CssObject): CssObject {
	const out: CssObject = {};
	for (const [key, value] of Object.entries(node)) {
		out[key] =
			typeof value === "string" ? normalizeValue(value) : normalizeTree(value);
	}
	return out;
}

/** Turn a postcss container into the nested-object shape, leaf values still raw. */
function toObject(container: Container): CssObject {
	const obj: CssObject = {};
	container.each((child) => {
		if (child.type === "decl") obj[child.prop] = child.value;
		else if (child.type === "rule") obj[child.selector] = toObject(child);
		else if (child.type === "atrule")
			obj[`@${child.name} ${child.params}`.trim()] = toObject(child);
	});
	return obj;
}

/** Extract just the `lc-` accent block from the full stylesheet. */
function lcBlockFromCss(css: string): CssObject {
	const root = postcss.parse(css);
	const block: CssObject = {};
	root.each((node) => {
		if (
			node.type === "atrule" &&
			node.name === "property" &&
			node.params.startsWith("--lc-")
		) {
			block[`@property ${node.params}`] = toObject(node);
		} else if (
			node.type === "atrule" &&
			node.name === "utility" &&
			node.params.startsWith("lc-")
		) {
			block[`@utility ${node.params}`] = toObject(node);
		} else if (
			node.type === "rule" &&
			node.selector === ":root" &&
			node.nodes.some(
				(decl) => decl.type === "decl" && decl.prop.startsWith("--lc-"),
			)
		) {
			block[":root"] = toObject(node);
		}
	});
	return block;
}

type RegistryItem = { name: string; css?: CssObject };

const registryCss = (() => {
	const registry = JSON.parse(readFileSync("registry.json", "utf8")) as {
		items: RegistryItem[];
	};
	const item = registry.items.find((i) => i.name === "feedback-base-ui");
	if (item?.css === undefined)
		throw new Error("feedback-base-ui has no css field in registry.json");
	return item.css;
})();

const stylesCss = lcBlockFromCss(readFileSync("styles.css", "utf8"));

describe("lc- accent block", () => {
	it("is the same in styles.css as in the registry css field", () => {
		expect(normalizeTree(stylesCss)).toEqual(normalizeTree(registryCss));
	});
});
