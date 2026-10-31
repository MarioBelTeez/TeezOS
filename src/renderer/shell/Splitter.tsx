import { useRef } from "react";

/**
 * A drag handle between two panels. It reports the new size of the panel it
 * belongs to; `invert` is for panels whose edge is on their left or top (the
 * chat on the right, the terminal at the bottom), where dragging toward the
 * panel makes it bigger.
 */
export function Splitter({
	axis,
	size,
	min,
	max,
	invert = false,
	onResize,
}: {
	readonly axis: "x" | "y";
	readonly size: number;
	readonly min: number;
	readonly max: number;
	readonly invert?: boolean;
	readonly onResize: (size: number) => void;
}): React.JSX.Element {
	const start = useRef<{ pos: number; size: number } | null>(null);

	return (
		<div
			role="separator"
			aria-orientation={axis === "x" ? "vertical" : "horizontal"}
			onPointerDown={(event) => {
				event.currentTarget.setPointerCapture(event.pointerId);
				start.current = { pos: axis === "x" ? event.clientX : event.clientY, size };
				document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
				document.body.style.userSelect = "none";
			}}
			onPointerMove={(event) => {
				const from = start.current;
				if (!from) return;
				const pos = axis === "x" ? event.clientX : event.clientY;
				const delta = (pos - from.pos) * (invert ? -1 : 1);
				onResize(Math.min(max, Math.max(min, from.size + delta)));
			}}
			onPointerUp={(event) => {
				event.currentTarget.releasePointerCapture(event.pointerId);
				start.current = null;
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
			}}
			className={`group relative z-10 shrink-0 ${
				axis === "x" ? "-mx-[3px] w-[7px] cursor-col-resize" : "-my-[3px] h-[7px] cursor-row-resize"
			}`}
		>
			<div
				className={`absolute bg-border transition-colors group-hover:bg-red/70 group-active:bg-red ${
					axis === "x" ? "inset-y-0 left-[3px] w-px" : "inset-x-0 top-[3px] h-px"
				}`}
			/>
		</div>
	);
}
