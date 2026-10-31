import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { POP_IN } from "../shell/motion.ts";
import { placeAbove } from "../shell/place-menu.ts";
import { useSettings } from "../state/settings.ts";

/**
 * The frame of the composer's popovers (the `/` menu, /btw, /context): drawn
 * at the window's root so no panel clips it, just above the composer and as
 * wide as it allows. A click outside both closes it; Esc inside either too.
 */

const MAX_WIDTH = 560;

export function ComposerPopover({
	anchor,
	onClose,
	label,
	children,
}: {
	readonly anchor: React.RefObject<HTMLElement | null>;
	readonly onClose: () => void;
	readonly label: string;
	readonly children: React.ReactNode;
}): React.JSX.Element {
	const box = useRef<HTMLDivElement>(null);
	// Drawn outside the chat panel, so it carries the chat's text size itself.
	const textSize = useSettings((s) => s.settings?.modules.chat.textSize ?? "m");
	const [style, setStyle] = useState<React.CSSProperties>({ left: 0, top: 0, visibility: "hidden" });

	useLayoutEffect(() => {
		const place = (): void => {
			const target = anchor.current;
			const element = box.current;
			if (!target || !element) return;
			const rect = target.getBoundingClientRect();
			const width = Math.max(240, Math.min(MAX_WIDTH, rect.width - 24));
			const height = element.getBoundingClientRect().height;
			const { left, top } = placeAbove({ left: rect.left + 12, top: rect.top }, { width, height }, { width: window.innerWidth, height: window.innerHeight });
			setStyle({ left, top, width });
		};
		place();
		// Content that grows (a streaming answer) or a resized window moves it.
		const observer = new ResizeObserver(place);
		if (box.current) observer.observe(box.current);
		if (anchor.current) observer.observe(anchor.current);
		window.addEventListener("resize", place);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", place);
		};
	}, [anchor]);

	useEffect(() => {
		const onMouseDown = (event: MouseEvent): void => {
			const target = event.target as Node;
			if (box.current?.contains(target) || anchor.current?.contains(target)) return;
			onClose();
		};
		// Only Esc pressed in the popover or the composer: Esc in the editor or
		// the terminal belongs to them.
		const onKey = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			const target = event.target as Node;
			if (box.current?.contains(target) || anchor.current?.contains(target)) onClose();
		};
		window.addEventListener("mousedown", onMouseDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onMouseDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [anchor, onClose]);

	return createPortal(
		<div
			ref={box}
			role="dialog"
			data-chat-size={textSize}
			aria-label={label}
			className="fixed z-40 shadow-2xl shadow-black/60"
			style={style}
		>
			{/* Placed by the outer box, animated by this one: the scale never skews the measurement. */}
			<motion.div {...POP_IN} className="glass border border-red/20">
				{children}
			</motion.div>
		</div>,
		document.body,
	);
}
