import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { motion } from "framer-motion";
import { useUi } from "../state/ui.ts";
import { placeMenu } from "./place-menu.ts";
import { POP_IN } from "./motion.ts";

/** The right-click menu, drawn at the pointer (or under a button) and kept on screen. */
export function ContextMenu(): React.JSX.Element | null {
	const menu = useUi((s) => s.menu);
	const close = useUi((s) => s.closeMenu);
	const box = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState({ left: 0, top: 0 });

	useLayoutEffect(() => {
		if (!menu || !box.current) return;
		// Measured after mount, before paint: the menu's size is only known now.
		const { width, height } = box.current.getBoundingClientRect();
		setPosition(placeMenu(menu, { width, height }, { width: window.innerWidth, height: window.innerHeight }));
	}, [menu]);

	useEffect(() => {
		if (!menu) return;
		const dismiss = (event: Event): void => {
			if (event instanceof KeyboardEvent && event.key !== "Escape") return;
			if (event instanceof MouseEvent && box.current?.contains(event.target as Node)) return;
			close();
		};
		window.addEventListener("mousedown", dismiss);
		window.addEventListener("keydown", dismiss);
		window.addEventListener("blur", close);
		return () => {
			window.removeEventListener("mousedown", dismiss);
			window.removeEventListener("keydown", dismiss);
			window.removeEventListener("blur", close);
		};
	}, [menu, close]);

	if (!menu) return null;
	// The outer box is measured and placed; the inner one animates, so its scale never skews the measurement.
	return (
		<div ref={box} role="menu" className="fixed z-50 min-w-52 shadow-2xl shadow-black/60" style={position}>
			<motion.div {...POP_IN} className="glass border border-red/20 py-1">
				{menu.items.map((item, index) =>
					"separator" in item ? (
						item.label ? (
							<div
								key={`sep-${index}`}
								className={`px-3 pt-1.5 pb-0.5 font-condensed text-[10px] font-semibold uppercase tracking-wider text-muted ${index > 0 ? "mt-1 border-t border-border" : ""}`}
							>
								{item.label}
							</div>
						) : (
							<div key={`sep-${index}`} className="my-1 h-px bg-border" />
						)
					) : (
						<button
							key={item.label}
							type="button"
							role="menuitem"
							disabled={item.disabled}
							// Keeps focus and the selection where the right-click was, so Cut/Paste act on that field.
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => {
								close();
								item.onSelect();
							}}
							className={`flex w-full items-center justify-between gap-6 px-3 py-1 text-left text-[13px] enabled:hover:bg-red/20 enabled:hover:shadow-[inset_2px_0_0_var(--color-red-hot)] disabled:opacity-40 ${
								item.danger ? "text-[#ff4d6a]" : "text-text"
							}`}
						>
							{item.label}
							{item.hint ? <span className="font-mono text-[10px] text-muted">{item.hint}</span> : null}
						</button>
					),
				)}
			</motion.div>
		</div>
	);
}

export function Toasts(): React.JSX.Element {
	const toasts = useUi((s) => s.toasts);
	const dismiss = useUi((s) => s.dismissToast);
	return (
		<div className="pointer-events-none fixed right-4 bottom-8 z-50 flex w-80 flex-col gap-2">
			{toasts.map((toast) => (
				<motion.div
					key={toast.id}
					{...POP_IN}
					className={`glass pointer-events-auto flex items-start gap-2 border px-3 py-2 text-[13px] ${
						toast.tone === "error"
							? "border-red/60"
							: toast.tone === "success"
								? "border-[#22c55e]/50"
								: "border-border"
					}`}
				>
					<span className="min-w-0 flex-1 break-words">{toast.text}</span>
					<button type="button" aria-label="Dismiss" onClick={() => dismiss(toast.id)} className="text-muted hover:text-text">
						<X size={13} />
					</button>
				</motion.div>
			))}
		</div>
	);
}
