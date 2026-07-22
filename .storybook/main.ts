import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";

const config: StorybookConfig = {
	stories: ["../registry/**/*.stories.@(ts|tsx)"],
	addons: ["@storybook/addon-docs"],
	framework: "@storybook/react-vite",
	// Storybook builds its own Vite config rather than reading vite.config.ts, so
	// the two things the registry sources need are restated here: the Tailwind v4
	// plugin (styles.css is `@import "tailwindcss"`, which only compiles through
	// that plugin) and the `@/` → registry mappings, which are the same tsconfig
	// paths vitest.config.ts resolves.
	viteFinal: (viteConfig) => ({
		...viteConfig,
		resolve: { ...viteConfig.resolve, tsconfigPaths: true },
		plugins: [...(viteConfig.plugins ?? []), tailwindcss()],
	}),
};

export default config;
