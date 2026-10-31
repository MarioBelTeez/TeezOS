/** How menus, the palette and the composer's popovers arrive: a quick fade and lift (off under reduced motion). */
export const POP_IN = {
	initial: { opacity: 0, scale: 0.98, y: 4 },
	animate: { opacity: 1, scale: 1, y: 0 },
	transition: { duration: 0.14 },
} as const;
