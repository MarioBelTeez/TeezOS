import { useEffect, useRef } from "react";
import {
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from "d3-force";
import type { NoteMeta, VaultIndex } from "../../main/brain/vault.ts";
import type { LabelMode } from "../../shared/modules.ts";
import {
	approach,
	FOLDER_COLORS,
	folderColor,
	graphLabelAlpha,
	inertiaStep,
	nodeRadius,
	zoomAround,
} from "./graph-math.ts";

/**
 * The vault as a graph: notes are dots sized by how many notes link to them,
 * coloured by folder; links are lines. Hover lights up a note's neighbours,
 * click opens it, drag moves a note, wheel zooms, dragging the empty canvas
 * pans. With `focus` set, only that note and its neighbours (two steps out)
 * are drawn — the local graph beside a note.
 */

export type GraphPhysics = {
	readonly repel: number;
	readonly linkDistance: number;
	readonly gravity: number;
	readonly labels: LabelMode;
	readonly colorByFolder: boolean;
};

export type GraphProps = {
	readonly index: VaultIndex;
	readonly focus?: string | null | undefined;
	readonly current?: string | null | undefined;
	readonly onOpen: (path: string) => void;
	readonly compact?: boolean | undefined;
	readonly physics?: GraphPhysics | undefined;
};

type GraphNode = SimulationNodeDatum & {
	readonly id: string;
	readonly title: string;
	readonly radius: number;
	color: string;
};

type GraphLink = SimulationLinkDatum<GraphNode>;

const OTHER_COLOR = FOLDER_COLORS["other"] ?? "#b8a9b0";

/** Pointer travel (px) before a press becomes a drag instead of a click. */
const DRAG_SLOP = 3;

const DEFAULT_PHYSICS: GraphPhysics = {
	repel: 190,
	linkDistance: 70,
	gravity: 0.05,
	labels: "zoom",
	colorByFolder: true,
};

function neighbourhood(index: VaultIndex, focus: string, depth: number): Set<string> {
	const keep = new Set([focus]);
	let frontier = [focus];
	for (let step = 0; step < depth; step += 1) {
		const next: string[] = [];
		for (const edge of index.edges) {
			if (frontier.includes(edge.from) && !keep.has(edge.to)) next.push(edge.to);
			if (frontier.includes(edge.to) && !keep.has(edge.from)) next.push(edge.from);
		}
		for (const id of next) keep.add(id);
		frontier = next;
	}
	return keep;
}

export function Graph({
	index,
	focus = null,
	current = null,
	onOpen,
	compact = false,
	physics,
}: GraphProps): React.JSX.Element {
	const canvas = useRef<HTMLCanvasElement>(null);
	const onOpenRef = useRef(onOpen);
	onOpenRef.current = onOpen;
	// The highlighted note changes without rebuilding the layout.
	const currentRef = useRef(current);
	currentRef.current = current;
	// Survive a rebuild (the vault changed): the view stays where it was and
	// notes that still exist keep their place instead of the layout restarting.
	const viewRef = useRef<{ x: number; y: number; k: number } | null>(null);
	const positions = useRef(new Map<string, { x: number; y: number }>());
	// Physics changes re-tune the running simulation; they never rebuild it.
	const physicsRef = useRef(physics ?? DEFAULT_PHYSICS);
	physicsRef.current = physics ?? DEFAULT_PHYSICS;
	const applyPhysics = useRef<(() => void) | null>(null);

	useEffect(() => {
		const element = canvas.current;
		if (!element) return;
		const context = element.getContext("2d");
		if (!context) return;

		const keep = focus ? neighbourhood(index, focus, compact ? 1 : 2) : null;
		const metas: NoteMeta[] = index.notes.filter((n) => !keep || keep.has(n.path));
		const nodes: GraphNode[] = metas.map((n) => {
			const known = positions.current.get(n.path);
			return {
				id: n.path,
				title: n.title,
				radius: compact ? 2.5 + Math.sqrt(n.backlinks) * 1.2 : nodeRadius(n.backlinks),
				color: physicsRef.current.colorByFolder ? folderColor(n.path) : OTHER_COLOR,
				...(known ? { x: known.x, y: known.y } : {}),
			};
		});
		const warm = nodes.some((n) => n.x !== undefined);
		const ids = new Set(nodes.map((n) => n.id));
		const links: GraphLink[] = index.edges
			.filter((e) => ids.has(e.from) && ids.has(e.to))
			.map((e) => ({ source: e.from, target: e.to }));
		const neighbours = new Map<string, Set<string>>();
		for (const edge of index.edges) {
			if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
			let s1 = neighbours.get(edge.from);
			if (!s1) {
				s1 = new Set();
				neighbours.set(edge.from, s1);
			}
			s1.add(edge.to);
			let s2 = neighbours.get(edge.to);
			if (!s2) {
				s2 = new Set();
				neighbours.set(edge.to, s2);
			}
			s2.add(edge.from);
		}

		let width = element.clientWidth;
		let height = element.clientHeight;
		const view = viewRef.current ?? { x: 0, y: 0, k: compact ? 1.2 : 1 };
		viewRef.current = view;

		let targetK = view.k;
		let zoomCursor = { x: 0, y: 0 };
		let hovered: GraphNode | null = null;
		let dragging: GraphNode | null = null;
		let isPanning = false;
		let lastPointerX = 0;
		let lastPointerY = 0;
		let lastPointerTime = 0;
		let panVelocity = { x: 0, y: 0 };
		let moved = false;
		let downX = 0;
		let downY = 0;

		const nodeAlphas = new Map<string, number>();
		for (const node of nodes) {
			nodeAlphas.set(node.id, 1);
		}

		const resize = (): void => {
			const ratio = window.devicePixelRatio || 1;
			width = element.clientWidth;
			height = element.clientHeight;
			if (width <= 0 || height <= 0) return;
			element.width = Math.max(1, Math.floor(width * ratio));
			element.height = Math.max(1, Math.floor(height * ratio));
		};

		const charge = forceManyBody<GraphNode>().distanceMax(compact ? 300 : 600);
		const linkForce = forceLink<GraphNode, GraphLink>(links).id((n) => n.id).strength(compact ? 0.35 : 0.18);
		const pullX = forceX<GraphNode>(0);
		const pullY = forceY<GraphNode>(0);

		// The loop below ticks the simulation itself, so its own timer stays off.
		const simulation = forceSimulation<GraphNode>(nodes)
			.force("charge", charge)
			.force("link", linkForce)
			.force("x", pullX)
			.force("y", pullY)
			.force("collide", forceCollide<GraphNode>().radius((n) => n.radius + 2))
			.alphaTarget(0.02)
			.stop();

		const configure = (): void => {
			const p = physicsRef.current;
			charge.strength(-(compact ? Math.round(p.repel * 0.38) : p.repel));
			linkForce.distance(compact ? Math.round(p.linkDistance * 0.5) : p.linkDistance);
			pullX.strength(p.gravity);
			pullY.strength(p.gravity);
			for (const node of nodes) node.color = p.colorByFolder ? folderColor(node.id) : OTHER_COLOR;
		};
		configure();
		applyPhysics.current = () => {
			configure();
			if (!dragging) simulation.alpha(Math.max(simulation.alpha(), 0.3));
		};

		if (warm) simulation.alpha(0.25);

		const toWorld = (sx: number, sy: number): { x: number; y: number } => ({
			x: (sx - width / 2 - view.x) / view.k,
			y: (sy - height / 2 - view.y) / view.k,
		});

		const hit = (sx: number, sy: number): GraphNode | null => {
			const p = toWorld(sx, sy);
			let best: GraphNode | null = null;
			let bestDistance = Infinity;
			for (const node of nodes) {
				const dx = (node.x ?? 0) - p.x;
				const dy = (node.y ?? 0) - p.y;
				const distance = Math.hypot(dx, dy);
				if (distance < node.radius + 4 / view.k && distance < bestDistance) {
					best = node;
					bestDistance = distance;
				}
			}
			return best;
		};

		function draw(): void {
			if (!context) return;
			const ratio = context.canvas.width / Math.max(1, width);
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			context.clearRect(0, 0, width, height);

			context.save();
			context.translate(width / 2 + view.x, height / 2 + view.y);
			context.scale(view.k, view.k);

			const lit = hovered ? neighbours.get(hovered.id) : null;

			// Links
			context.lineWidth = 1 / view.k;
			context.strokeStyle = "rgba(255,255,255,0.08)";
			context.beginPath();
			for (const link of links) {
				const s = typeof link.source === "object" && link.source !== null ? link.source : null;
				const t = typeof link.target === "object" && link.target !== null ? link.target : null;
				if (!s || !t) continue;
				const active = hovered !== null && (s.id === hovered.id || t.id === hovered.id);
				if (!active) {
					context.moveTo(s.x ?? 0, s.y ?? 0);
					context.lineTo(t.x ?? 0, t.y ?? 0);
				}
			}
			context.stroke();

			if (hovered !== null) {
				context.lineWidth = 1.5 / view.k;
				context.strokeStyle = "rgba(232,0,45,0.7)";
				context.beginPath();
				for (const link of links) {
					const s = typeof link.source === "object" && link.source !== null ? link.source : null;
					const t = typeof link.target === "object" && link.target !== null ? link.target : null;
					if (!s || !t) continue;
					if (s.id === hovered.id || t.id === hovered.id) {
						context.moveTo(s.x ?? 0, s.y ?? 0);
						context.lineTo(t.x ?? 0, t.y ?? 0);
					}
				}
				context.stroke();
			}

			// Nodes
			for (const node of nodes) {
				context.globalAlpha = nodeAlphas.get(node.id) ?? 1;
				context.fillStyle = node.color;
				context.beginPath();
				context.arc(node.x ?? 0, node.y ?? 0, node.radius, 0, Math.PI * 2);
				context.fill();

				if (node.id === currentRef.current || node.id === focus) {
					context.save();
					context.globalAlpha = 1;
					context.strokeStyle = "#ff1744";
					context.shadowColor = "#ff1744";
					context.shadowBlur = 12;
					context.lineWidth = 2 / view.k;
					context.stroke();
					context.restore();
				}
			}
			context.globalAlpha = 1;

			// Labels
			context.font = `${11 / view.k}px "Barlow Condensed", sans-serif`;
			context.textAlign = "center";
			context.textBaseline = "top";

			for (const node of nodes) {
				const isHovered = node.id === hovered?.id;
				const alpha = graphLabelAlpha({
					hovered: isHovered,
					neighbour: lit?.has(node.id) ?? false,
					current: node.id === currentRef.current,
					compact,
					k: view.k,
					mode: physicsRef.current.labels,
					nodeAlpha: nodeAlphas.get(node.id) ?? 1,
				});
				if (alpha <= 0.01) continue;

				context.globalAlpha = alpha;
				context.fillStyle = isHovered ? "#ffffff" : "rgba(245,240,242,0.78)";
				context.fillText(node.title, node.x ?? 0, (node.y ?? 0) + node.radius + 2 / view.k);
			}
			context.globalAlpha = 1;

			context.restore();
		}

		let rafId: number | null = null;
		let lastTime = performance.now();
		let isVisible = true;

		const tick = (now: number): void => {
			rafId = null;
			if (!isVisible) return;

			const dtMs = Math.min(64, now - lastTime);
			const dt = dtMs / 1000;
			lastTime = now;

			// Target zoom approach easing
			if (Math.abs(view.k - targetK) > 0.0001) {
				const nextK = approach(view.k, targetK, 18, dt);
				const updated = zoomAround(view, zoomCursor, nextK);
				view.x = updated.x;
				view.y = updated.y;
				view.k = updated.k;
			} else if (view.k !== targetK) {
				const updated = zoomAround(view, zoomCursor, targetK);
				view.x = updated.x;
				view.y = updated.y;
				view.k = updated.k;
			}

			// Pan glide inertia
			if (!isPanning && (panVelocity.x !== 0 || panVelocity.y !== 0)) {
				view.x += panVelocity.x * (dtMs / 16.67);
				view.y += panVelocity.y * (dtMs / 16.67);
				panVelocity = inertiaStep(panVelocity, dtMs);
			}

			// Per-node alpha easing
			const lit = hovered ? neighbours.get(hovered.id) : null;
			for (const node of nodes) {
				const currentAlpha = nodeAlphas.get(node.id) ?? 1;
				const isLit = hovered !== null && (node.id === hovered.id || (lit?.has(node.id) ?? false));
				const targetAlpha = hovered === null ? 1 : isLit ? 1 : 0.15;
				const nextAlpha = approach(currentAlpha, targetAlpha, 14, dt);
				nodeAlphas.set(node.id, nextAlpha);
			}

			simulation.tick();
			draw();

			rafId = requestAnimationFrame(tick);
		};

		const startLoop = (): void => {
			if (rafId !== null) return;
			lastTime = performance.now();
			rafId = requestAnimationFrame(tick);
		};

		const stopLoop = (): void => {
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
		};

		const onMove = (event: PointerEvent): void => {
			const rect = element.getBoundingClientRect();
			const sx = event.clientX - rect.left;
			const sy = event.clientY - rect.top;
			if (dragging) {
				if (!moved && Math.hypot(sx - downX, sy - downY) < DRAG_SLOP) return;
				moved = true;
				const p = toWorld(sx, sy);
				dragging.fx = p.x;
				dragging.fy = p.y;
				return;
			}
			if (isPanning) {
				if (!moved && Math.hypot(sx - downX, sy - downY) < DRAG_SLOP) return;
				moved = true;
				const dx = sx - lastPointerX;
				const dy = sy - lastPointerY;
				view.x += dx;
				view.y += dy;
				const now = performance.now();
				const dt = Math.max(1, now - lastPointerTime);
				const vx = (dx / dt) * 16.67;
				const vy = (dy / dt) * 16.67;
				panVelocity = { x: vx * 0.7 + panVelocity.x * 0.3, y: vy * 0.7 + panVelocity.y * 0.3 };
				lastPointerX = sx;
				lastPointerY = sy;
				lastPointerTime = now;
				return;
			}
			const next = hit(sx, sy);
			if (next !== hovered) {
				hovered = next;
				element.style.cursor = next ? "pointer" : "grab";
			}
		};

		const onDown = (event: PointerEvent): void => {
			try {
				element.setPointerCapture(event.pointerId);
			} catch {
				// Ignore potential pointer capture errors
			}
			const rect = element.getBoundingClientRect();
			const sx = event.clientX - rect.left;
			const sy = event.clientY - rect.top;
			moved = false;
			downX = sx;
			downY = sy;
			panVelocity = { x: 0, y: 0 };
			const hitNode = hit(sx, sy);
			if (hitNode) {
				dragging = hitNode;
				simulation.alphaTarget(0.3);
			} else {
				isPanning = true;
				lastPointerX = sx;
				lastPointerY = sy;
				lastPointerTime = performance.now();
			}
		};

		const onUp = (event: PointerEvent): void => {
			if (dragging) {
				if (!moved) onOpenRef.current(dragging.id);
				dragging.fx = null;
				dragging.fy = null;
				dragging = null;
				simulation.alphaTarget(0.02);
			}
			if (isPanning) {
				isPanning = false;
				const timeSinceMove = performance.now() - lastPointerTime;
				if (timeSinceMove > 70) {
					panVelocity = { x: 0, y: 0 };
				}
			}
			// Released last: the lostpointercapture that follows finds nothing left to cancel.
			try {
				element.releasePointerCapture(event.pointerId);
			} catch {
				// Ignore potential pointer capture errors
			}
		};

		// The pointer was taken away (cancelled by the system, capture lost): let go of the note
		// or the pan without counting it as a click, and let the layout settle again.
		const onCancel = (): void => {
			if (dragging) {
				dragging.fx = null;
				dragging.fy = null;
				dragging = null;
				simulation.alphaTarget(0.02);
			}
			if (isPanning) {
				isPanning = false;
				panVelocity = { x: 0, y: 0 };
			}
		};

		const onWheel = (event: WheelEvent): void => {
			event.preventDefault();
			const rect = element.getBoundingClientRect();
			const sx = event.clientX - rect.left - width / 2;
			const sy = event.clientY - rect.top - height / 2;
			zoomCursor = { x: sx, y: sy };
			const factor = Math.exp(-event.deltaY * 0.0015);
			targetK = Math.min(6, Math.max(0.15, targetK * factor));
		};

		const onLeave = (): void => {
			if (hovered) {
				hovered = null;
			}
		};

		element.addEventListener("pointermove", onMove);
		element.addEventListener("pointerdown", onDown);
		element.addEventListener("pointerup", onUp);
		element.addEventListener("pointerleave", onLeave);
		element.addEventListener("pointercancel", onCancel);
		element.addEventListener("lostpointercapture", onCancel);
		element.addEventListener("wheel", onWheel, { passive: false });

		const resizeObserver = new ResizeObserver(resize);
		resizeObserver.observe(element);
		resize();

		const intersectionObserver = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					isVisible = true;
					startLoop();
				} else {
					isVisible = false;
					stopLoop();
				}
			}
		});
		intersectionObserver.observe(element);
		startLoop();

		return () => {
			stopLoop();
			simulation.stop();
			// Where every note ended up, kept for the rebuild that follows (read only then, so saved only now).
			for (const node of nodes) {
				if (node.x !== undefined && node.y !== undefined) positions.current.set(node.id, { x: node.x, y: node.y });
			}
			applyPhysics.current = null;
			intersectionObserver.disconnect();
			resizeObserver.disconnect();
			element.removeEventListener("pointermove", onMove);
			element.removeEventListener("pointerdown", onDown);
			element.removeEventListener("pointerup", onUp);
			element.removeEventListener("pointerleave", onLeave);
			element.removeEventListener("pointercancel", onCancel);
			element.removeEventListener("lostpointercapture", onCancel);
			element.removeEventListener("wheel", onWheel);
		};
	}, [index, focus, compact]);

	useEffect(() => {
		applyPhysics.current?.();
	}, [physics]);

	return <canvas ref={canvas} className="h-full w-full cursor-grab touch-none" />;
}
