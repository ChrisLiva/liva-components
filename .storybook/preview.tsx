import type { Preview } from "@storybook/react-vite";
import { useEffect } from "react";

// The repo's single stylesheet: Tailwind v4, the shadcn theme tokens, and the
// lc- accent-frame utilities. Without this import every story renders unstyled
// and the ring and bloom are invisible.
import "../styles.css";

const preview: Preview = {
	parameters: {
		controls: {
			matchers: {
				color: /(background|color)$/i,
				date: /Date$/i,
			},
		},
	},
	globalTypes: {
		theme: {
			description: "Surface the accents are measured against",
			toolbar: {
				title: "Theme",
				icon: "circlehollow",
				items: [
					{ value: "light", icon: "sun", title: "Light" },
					{ value: "dark", icon: "moon", title: "Dark" },
				],
				dynamicTitle: true,
			},
		},
	},
	initialGlobals: { theme: "light" },
	decorators: [
		(Story, context) => {
			// `.dark` goes on the documentElement rather than a wrapper, because the
			// dialog portals to document.body — a class on a wrapper inside the story
			// would never reach the popup whose ring is the thing being looked at.
			useEffect(() => {
				const dark = context.globals.theme === "dark";
				document.documentElement.classList.toggle("dark", dark);
			}, [context.globals.theme]);
			return <Story />;
		},
	],
};

export default preview;
