import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ArrowUpRight,
	Download,
	Eraser,
	Eye,
	FileText,
	Grid,
	Highlighter,
	Minus,
	Paperclip,
	PenTool,
	Redo2,
	Send,
	Square,
	Trash2,
	Type,
	Undo2,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { useActiveWorkspace } from "../state/settings.ts";
import { useChats } from "../state/chats.ts";
import { useUi, type CanvasDocument } from "../state/ui.ts";
import { revealPanel } from "../shell/dock-actions.ts";
import { MarkdownText } from "../chat/Cards.tsx";
import type { PastedImage } from "../chat/pasted-images.ts";
import {
	buildSandboxedSrcDoc,
	canvasKindForPath,
	extractArtifactsFromMarkdown,
} from "./canvas-utils.ts";

type Tool = "pen" | "highlighter" | "line" | "rect" | "arrow" | "text" | "eraser";

const COLORS = [
	{ name: "Ink", value: "#111827" },
	{ name: "BelTeez Red", value: "#E8002D" },
	{ name: "Steam Blue", value: "#1A9FFF" },
	{ name: "Emerald", value: "#16A34A" },
	{ name: "Amber", value: "#D97706" },
	{ name: "Violet", value: "#7C3AED" },
] as const;

const SIZES = [
	{ label: "S", value: 2.5 },
	{ label: "M", value: 5 },
	{ label: "L", value: 11 },
] as const;

const CANVAS_W = 1280;
const CANVAS_H = 800;

function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, width: number): void {
	const headLen = Math.max(12, width * 3.2);
	const angle = Math.atan2(y2 - y1, x2 - x1);
	ctx.beginPath();
	ctx.moveTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.stroke();
	ctx.beginPath();
	ctx.moveTo(x2, y2);
	ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
	ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
	ctx.closePath();
	ctx.fillStyle = ctx.strokeStyle as string;
	ctx.fill();
}

export function CanvasView(): React.JSX.Element {
	const tab = useUi((s) => s.canvasTab);
	const setTab = useUi((s) => s.setCanvasTab);
	const canvasDoc = useUi((s) => s.canvasDoc);

	return (
		<section className="flex h-full min-h-0 flex-col bg-bg text-text">
			<header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface/80 px-4 py-2">
				<div className="flex items-center gap-3">
					<span className="font-display text-xl tracking-wider text-text">CANVAS</span>
					<div className="flex items-center border border-border bg-bg p-0.5">
						<button
							type="button"
							onClick={() => setTab("sketchpad")}
							className={`flex items-center gap-1.5 px-2.5 py-1 font-condensed text-[11px] font-bold uppercase tracking-wider transition-colors ${
								tab === "sketchpad" ? "bg-red text-on-red" : "text-muted hover:text-text"
							}`}
						>
							<PenTool size={12} />
							Sketchpad
						</button>
						<button
							type="button"
							onClick={() => setTab("viewer")}
							className={`flex items-center gap-1.5 px-2.5 py-1 font-condensed text-[11px] font-bold uppercase tracking-wider transition-colors ${
								tab === "viewer" ? "bg-red text-on-red" : "text-muted hover:text-text"
							}`}
						>
							<Eye size={12} />
							Viewer{canvasDoc ? " •" : ""}
						</button>
					</div>
				</div>
				<span className="hidden font-mono text-[10px] uppercase tracking-widest text-muted sm:inline">
					{tab === "sketchpad" ? "Draw UI wireframes → Send straight to Chat" : "Inspect Agent SVGs, HTML & Docs"}
				</span>
			</header>

			<div className="min-h-0 flex-1 overflow-hidden">
				<div className={tab === "sketchpad" ? "flex h-full flex-col" : "hidden"}>
					<SketchpadPane />
				</div>
				<div className={tab === "viewer" ? "flex h-full flex-col" : "hidden"}>
					<ViewerPane />
				</div>
			</div>
		</section>
	);
}

function SketchpadPane(): React.JSX.Element {
	const workspace = useActiveWorkspace();
	const activeChatId = useChats((s) => (workspace ? s.activeByWorkspace[workspace.id] : undefined));
	const activeChat = useChats((s) => (activeChatId ? s.chats[activeChatId] : undefined));
	const sketchBackground = useUi((s) => s.sketchBackground);

	const canvasRef = useRef<HTMLCanvasElement>(null);
	const drawing = useRef(false);
	const startPt = useRef<{ x: number; y: number } | null>(null);
	const snapshotBeforeShape = useRef<ImageData | null>(null);
	const history = useRef<ImageData[]>([]);
	const historyIndex = useRef(-1);

	const [tool, setTool] = useState<Tool>("pen");
	const [color, setColor] = useState<string>(COLORS[0].value);
	const [size, setSize] = useState<number>(SIZES[1].value);
	const [showGrid, setShowGrid] = useState(true);
	const [darkCanvas, setDarkCanvas] = useState(false);
	const [caption, setCaption] = useState("");
	const [canUndo, setCanUndo] = useState(false);
	const [canRedo, setCanRedo] = useState(false);
	const [textPrompt, setTextPrompt] = useState<{ x: number; y: number; value: string } | null>(null);

	const syncUndoState = useCallback(() => {
		setCanUndo(historyIndex.current > 0);
		setCanRedo(historyIndex.current >= 0 && historyIndex.current < history.current.length - 1);
	}, []);

	const pushHistory = useCallback(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d", { willReadFrequently: true });
		if (!canvas || !ctx) return;
		const snap = ctx.getImageData(0, 0, canvas.width, canvas.height);
		history.current = history.current.slice(0, historyIndex.current + 1);
		history.current.push(snap);
		if (history.current.length > 40) history.current.shift();
		historyIndex.current = history.current.length - 1;
		syncUndoState();
	}, [syncUndoState]);

	const fillBackground = useCallback(
		(dark: boolean) => {
			const canvas = canvasRef.current;
			const ctx = canvas?.getContext("2d", { willReadFrequently: true });
			if (!canvas || !ctx) return;
			ctx.save();
			ctx.fillStyle = dark ? "#0D0B10" : "#FFFFFF";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.restore();
		},
		[],
	);

	// Initialize crisp white canvas on mount
	useEffect(() => {
		fillBackground(false);
		pushHistory();
	}, [fillBackground, pushHistory]);

	// Stamp an image from the Viewer when the user clicks "Annotate in Sketchpad"
	useEffect(() => {
		if (!sketchBackground) return;
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d", { willReadFrequently: true });
		if (!canvas || !ctx) return;
		const img = new Image();
		img.onload = () => {
			fillBackground(darkCanvas);
			const scale = Math.min((canvas.width - 40) / img.width, (canvas.height - 40) / img.height, 1);
			const w = img.width * scale;
			const h = img.height * scale;
			ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
			pushHistory();
			useUi.getState().consumeSketchBackground();
		};
		img.src = sketchBackground.dataUrl;
	}, [sketchBackground, darkCanvas, fillBackground, pushHistory]);

	const undo = useCallback(() => {
		if (historyIndex.current <= 0) return;
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d", { willReadFrequently: true });
		if (!canvas || !ctx) return;
		historyIndex.current -= 1;
		const snap = history.current[historyIndex.current];
		if (snap) ctx.putImageData(snap, 0, 0);
		syncUndoState();
	}, [syncUndoState]);

	const redo = useCallback(() => {
		if (historyIndex.current >= history.current.length - 1) return;
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d", { willReadFrequently: true });
		if (!canvas || !ctx) return;
		historyIndex.current += 1;
		const snap = history.current[historyIndex.current];
		if (snap) ctx.putImageData(snap, 0, 0);
		syncUndoState();
	}, [syncUndoState]);

	const clearCanvas = useCallback(() => {
		fillBackground(darkCanvas);
		pushHistory();
		setTextPrompt(null);
	}, [darkCanvas, fillBackground, pushHistory]);

	const toggleCanvasTheme = (): void => {
		const next = !darkCanvas;
		setDarkCanvas(next);
		fillBackground(next);
		if (next && color === "#111827") setColor("#FFFFFF");
		if (!next && color === "#FFFFFF") setColor("#111827");
		pushHistory();
	};

	const getPoint = (event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
		const canvas = canvasRef.current!;
		const rect = canvas.getBoundingClientRect();
		return {
			x: ((event.clientX - rect.left) / rect.width) * canvas.width,
			y: ((event.clientY - rect.top) / rect.height) * canvas.height,
		};
	};

	const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d", { willReadFrequently: true });
		if (!canvas || !ctx) return;

		const pt = getPoint(event);
		if (tool === "text") {
			setTextPrompt({ x: pt.x, y: pt.y, value: "" });
			return;
		}

		canvas.setPointerCapture(event.pointerId);
		drawing.current = true;
		startPt.current = pt;

		if (tool === "line" || tool === "rect" || tool === "arrow") {
			snapshotBeforeShape.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
			return;
		}

		ctx.save();
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		ctx.strokeStyle = tool === "eraser" ? (darkCanvas ? "#0D0B10" : "#FFFFFF") : color;
		ctx.lineWidth = tool === "eraser" ? size * 3.5 : tool === "highlighter" ? size * 3 : size;
		ctx.globalAlpha = tool === "highlighter" ? 0.32 : 1;
		ctx.beginPath();
		ctx.moveTo(pt.x, pt.y);
		ctx.lineTo(pt.x + 0.1, pt.y + 0.1);
		ctx.stroke();
		ctx.restore();
	};

	const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
		if (!drawing.current || !startPt.current) return;
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d", { willReadFrequently: true });
		if (!canvas || !ctx) return;
		const pt = getPoint(event);

		if (tool === "line" || tool === "rect" || tool === "arrow") {
			if (snapshotBeforeShape.current) ctx.putImageData(snapshotBeforeShape.current, 0, 0);
			ctx.save();
			ctx.strokeStyle = color;
			ctx.lineWidth = size;
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
			if (tool === "line") {
				ctx.beginPath();
				ctx.moveTo(startPt.current.x, startPt.current.y);
				ctx.lineTo(pt.x, pt.y);
				ctx.stroke();
			} else if (tool === "rect") {
				ctx.strokeRect(
					startPt.current.x,
					startPt.current.y,
					pt.x - startPt.current.x,
					pt.y - startPt.current.y,
				);
			} else if (tool === "arrow") {
				drawArrow(ctx, startPt.current.x, startPt.current.y, pt.x, pt.y, size);
			}
			ctx.restore();
			return;
		}

		ctx.save();
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		ctx.strokeStyle = tool === "eraser" ? (darkCanvas ? "#0D0B10" : "#FFFFFF") : color;
		ctx.lineWidth = tool === "eraser" ? size * 3.5 : tool === "highlighter" ? size * 3 : size;
		ctx.globalAlpha = tool === "highlighter" ? 0.32 : 1;
		ctx.beginPath();
		ctx.moveTo(startPt.current.x, startPt.current.y);
		ctx.lineTo(pt.x, pt.y);
		ctx.stroke();
		ctx.restore();
		startPt.current = pt;
	};

	const finishStroke = (): void => {
		if (!drawing.current) return;
		drawing.current = false;
		startPt.current = null;
		snapshotBeforeShape.current = null;
		pushHistory();
	};

	const commitText = (): void => {
		if (!textPrompt || !textPrompt.value.trim()) {
			setTextPrompt(null);
			return;
		}
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d", { willReadFrequently: true });
		if (canvas && ctx) {
			ctx.save();
			ctx.fillStyle = color;
			ctx.font = `700 ${Math.round(18 + size * 2.2)}px "Segoe UI", sans-serif`;
			ctx.fillText(textPrompt.value.trim(), textPrompt.x, textPrompt.y);
			ctx.restore();
			pushHistory();
		}
		setTextPrompt(null);
	};

	const exportPastedImage = (): PastedImage | null => {
		const canvas = canvasRef.current;
		if (!canvas) return null;
		const url = canvas.toDataURL("image/png");
		const thumbCanvas = document.createElement("canvas");
		thumbCanvas.width = 320;
		thumbCanvas.height = 200;
		const tctx = thumbCanvas.getContext("2d");
		if (tctx) tctx.drawImage(canvas, 0, 0, 320, 200);
		return { url, thumb: thumbCanvas.toDataURL("image/webp", 0.85) };
	};

	const handleAttachToChat = (): void => {
		const img = exportPastedImage();
		if (!img) return;
		useUi.getState().insertImageIntoComposer(img, caption.trim() || undefined);
		revealPanel("chat");
		useUi.getState().toast("Sketch attached to Chat composer.", "success");
	};

	const handleSendToChat = async (): Promise<void> => {
		if (!workspace) {
			useUi.getState().toast("Open a workspace first to send a sketch to Chat.", "error");
			return;
		}
		const img = exportPastedImage();
		if (!img) return;
		const chatId = activeChat?.chatId ?? (await useChats.getState().ensureChat(workspace.id));
		if (!chatId) {
			useUi.getState().toast("Could not open an active chat for this workspace.", "error");
			return;
		}
		const chat = useChats.getState().chats[chatId];
		if (chat?.agent === "codex") {
			useUi.getState().toast("Codex takes text only — switch your chat to Claude or Antigravity.", "error");
			return;
		}
		const text = caption.trim() || "Here is my sketch — build/adjust the layout based on this.";
		useChats.getState().send(chatId, text, [img]);
		setCaption("");
		revealPanel("chat");
		useUi.getState().requestChatScrollToBottom(chatId);
		useUi.getState().toast("Sketch sent to active chat!", "success");
	};

	const handleDownload = (): void => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const a = document.createElement("a");
		a.href = canvas.toDataURL("image/png");
		a.download = `teezos-sketch-${Date.now()}.png`;
		a.click();
	};

	const tools: Array<{ id: Tool; label: string; icon: typeof PenTool }> = [
		{ id: "pen", label: "Pen", icon: PenTool },
		{ id: "highlighter", label: "Highlight", icon: Highlighter },
		{ id: "line", label: "Line", icon: Minus },
		{ id: "rect", label: "Box", icon: Square },
		{ id: "arrow", label: "Arrow", icon: ArrowUpRight },
		{ id: "text", label: "Text", icon: Type },
		{ id: "eraser", label: "Eraser", icon: Eraser },
	];

	return (
		<div
			tabIndex={-1}
			onKeyDown={(e) => {
				if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
					e.preventDefault();
					if (e.shiftKey) redo();
					else undo();
				} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
					e.preventDefault();
					redo();
				}
			}}
			className="flex h-full min-h-0 flex-col outline-none"
		>
			{/* Drawing Toolbar */}
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface/60 px-3 py-1.5">
				<div className="flex flex-wrap items-center gap-1">
					{tools.map((t) => {
						const Icon = t.icon;
						return (
							<button
								key={t.id}
								type="button"
								title={t.label}
								onClick={() => setTool(t.id)}
								className={`flex items-center gap-1 px-2 py-1 font-condensed text-[11px] font-semibold uppercase tracking-wider transition-colors ${
									tool === t.id ? "bg-red text-on-red" : "text-muted hover:bg-white/5 hover:text-text"
								}`}
							>
								<Icon size={13} />
								<span className="hidden lg:inline">{t.label}</span>
							</button>
						);
					})}

					<span className="mx-1 h-4 w-px bg-border" />

					{/* Swatches */}
					<div className="flex items-center gap-1">
						{COLORS.map((c) => {
							const swatchColor = darkCanvas && c.value === "#111827" ? "#FFFFFF" : c.value;
							return (
								<button
									key={c.name}
									type="button"
									title={c.name}
									onClick={() => {
										setColor(swatchColor);
										if (tool === "eraser") setTool("pen");
									}}
									style={{ backgroundColor: swatchColor }}
									className={`h-5 w-5 rounded-full border-2 transition-transform ${
										color === swatchColor ? "scale-110 border-white ring-1 ring-red" : "border-border"
									}`}
								/>
							);
						})}
					</div>

					<span className="mx-1 h-4 w-px bg-border" />

					{/* Stroke Sizes */}
					{SIZES.map((s) => (
						<button
							key={s.label}
							type="button"
							onClick={() => setSize(s.value)}
							className={`px-1.5 py-0.5 font-mono text-[10px] font-bold ${
								size === s.value ? "bg-white/15 text-text" : "text-muted hover:text-text"
							}`}
						>
							{s.label}
						</button>
					))}
				</div>

				{/* Right Controls */}
				<div className="flex items-center gap-1">
					<button
						type="button"
						title="Toggle dot grid"
						onClick={() => setShowGrid((g) => !g)}
						className={`p-1.5 ${showGrid ? "text-red-hot" : "text-muted hover:text-text"}`}
					>
						<Grid size={14} />
					</button>
					<button
						type="button"
						title="Switch white / dark paper"
						onClick={toggleCanvasTheme}
						className="border border-border px-2 py-0.5 font-mono text-[10px] uppercase text-muted hover:text-text"
					>
						{darkCanvas ? "Dark" : "White"}
					</button>
					<button type="button" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo} className="p-1.5 text-muted hover:text-text disabled:opacity-30">
						<Undo2 size={14} />
					</button>
					<button type="button" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={redo} className="p-1.5 text-muted hover:text-text disabled:opacity-30">
						<Redo2 size={14} />
					</button>
					<button type="button" title="Download PNG" onClick={handleDownload} className="p-1.5 text-muted hover:text-text">
						<Download size={14} />
					</button>
					<button
						type="button"
						onClick={clearCanvas}
						className="ml-1 flex items-center gap-1 border border-border px-2 py-1 font-condensed text-[11px] font-bold uppercase tracking-wider text-muted hover:border-red hover:text-red-hot"
					>
						<Trash2 size={12} />
						Clear
					</button>
				</div>
			</div>

			{/* Canvas Stage */}
			<div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[#060508] p-4">
				<div className="relative aspect-[16/10] max-h-full w-full max-w-[1120px] shadow-[0_18px_50px_rgba(0,0,0,0.65)] ring-1 ring-border">
					<canvas
						ref={canvasRef}
						width={CANVAS_W}
						height={CANVAS_H}
						onPointerDown={onPointerDown}
						onPointerMove={onPointerMove}
						onPointerUp={finishStroke}
						onPointerCancel={finishStroke}
						className="h-full w-full cursor-crosshair touch-none block"
					/>
					{showGrid ? (
						<div
							className="pointer-events-none absolute inset-0"
							style={{
								backgroundImage: darkCanvas
									? "radial-gradient(rgba(255,255,255,0.14) 1px, transparent 1px)"
									: "radial-gradient(rgba(15,23,42,0.14) 1px, transparent 1px)",
								backgroundSize: "24px 24px",
							}}
						/>
					) : null}
					{textPrompt ? (
						<form
							onSubmit={(e) => {
								e.preventDefault();
								commitText();
							}}
							style={{
								left: `${(textPrompt.x / CANVAS_W) * 100}%`,
								top: `${(textPrompt.y / CANVAS_H) * 100}%`,
							}}
							className="absolute z-10 -translate-y-1/2"
						>
							<input
								autoFocus
								value={textPrompt.value}
								onChange={(e) => setTextPrompt({ ...textPrompt, value: e.target.value })}
								onBlur={commitText}
								placeholder="Type label..."
								className="border border-red bg-surface px-2 py-1 font-mono text-xs text-text shadow-lg outline-none"
							/>
						</form>
					) : null}
				</div>
			</div>

			{/* Bottom Send-to-Chat Action Bar */}
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-surface/90 px-3 py-2">
				<input
					type="text"
					value={caption}
					onChange={(e) => setCaption(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
							e.preventDefault();
							void handleSendToChat();
						}
					}}
					placeholder="Optional note for the agent (e.g. 'Make the hero layout look like this')..."
					className="min-w-[200px] flex-1 border border-border bg-bg px-3 py-1.5 font-mono text-xs text-text placeholder:text-muted/70 focus:border-red focus:outline-none"
				/>
				<button
					type="button"
					onClick={handleAttachToChat}
					className="flex items-center gap-1.5 border border-border bg-bg px-3 py-1.5 font-condensed text-xs font-bold uppercase tracking-wider text-text hover:border-red"
				>
					<Paperclip size={13} />
					Attach
				</button>
				<button
					type="button"
					onClick={() => void handleSendToChat()}
					className="cut-corner flex items-center gap-1.5 bg-red px-4 py-1.5 font-condensed text-xs font-bold uppercase tracking-wider text-on-red hover:bg-red-hot"
				>
					<Send size={13} />
					Send to Chat
				</button>
			</div>
		</div>
	);
}

function ViewerPane(): React.JSX.Element {
	const workspace = useActiveWorkspace();
	const activeChatId = useChats((s) => (workspace ? s.activeByWorkspace[workspace.id] : undefined));
	const activeChat = useChats((s) => (activeChatId ? s.chats[activeChatId] : undefined));
	const canvasDoc = useUi((s) => s.canvasDoc);
	const openInCanvasViewer = useUi((s) => s.openInCanvasViewer);

	const [zoom, setZoom] = useState(100);
	const [filePathInput, setFilePathInput] = useState("");
	const [pasteOpen, setPasteOpen] = useState(false);
	const [pasteKind, setPasteKind] = useState<"svg" | "html" | "markdown">("svg");
	const [pasteText, setPasteText] = useState("");
	const [loadError, setLoadError] = useState<string | null>(null);

	// Scan active chat's assistant messages for SVG/HTML blocks so Mario can open them in 1 click
	const chatArtifacts = useMemo(() => {
		if (!activeChat) return [];
		const out = [];
		for (const card of activeChat.cards) {
			if (card.kind !== "assistant") continue;
			out.push(...extractArtifactsFromMarkdown(card.text, card.id));
		}
		return out.slice(-6).reverse();
	}, [activeChat]);

	const activeDoc: CanvasDocument | null =
		canvasDoc ?? (chatArtifacts[0] ? { ...chatArtifacts[0], nonce: 0 } : null);

	const loadWorkspaceFile = async (e: React.FormEvent): Promise<void> => {
		e.preventDefault();
		if (!workspace || !filePathInput.trim()) return;
		const rel = filePathInput.trim().replace(/\\/g, "/");
		const kind = canvasKindForPath(rel);
		if (!kind) {
			setLoadError("Supported viewer files: .svg, .html, .md, .txt");
			return;
		}
		try {
			const res = await window.teez.files.read(workspace.id, rel);
			if (!("content" in res)) {
				setLoadError("reason" in res && typeof res.reason === "string" ? res.reason : "Could not read file");
				return;
			}
			setLoadError(null);
			openInCanvasViewer({
				title: rel.split("/").pop() || rel,
				kind,
				content: res.content,
				sourcePath: rel,
			});
		} catch (err) {
			setLoadError(err instanceof Error ? err.message : "Could not read file");
		}
	};

	const annotateCurrent = (): void => {
		if (!activeDoc) return;
		if (activeDoc.kind === "image") {
			useUi.getState().annotateInSketchpad(activeDoc.content);
			return;
		}
		if (activeDoc.kind === "svg") {
			const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(activeDoc.content)}`;
			useUi.getState().annotateInSketchpad(encoded);
			return;
		}
		useUi.getState().toast("Annotate supports SVG and Image documents.", "info");
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* Top Viewer Controls */}
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface/60 px-3 py-1.5">
				<form onSubmit={(e) => void loadWorkspaceFile(e)} className="flex min-w-[200px] flex-1 items-center gap-1.5">
					<FileText size={13} className="shrink-0 text-muted" />
					<input
						type="text"
						value={filePathInput}
						onChange={(e) => setFilePathInput(e.target.value)}
						placeholder="Open workspace file (.svg, .html, .md)..."
						className="min-w-0 flex-1 border border-border bg-bg px-2 py-1 font-mono text-[11px] text-text placeholder:text-muted/70 focus:border-red focus:outline-none"
					/>
					<button
						type="submit"
						className="border border-border bg-bg px-2.5 py-1 font-condensed text-[11px] font-bold uppercase tracking-wider text-text hover:border-red"
					>
						Open
					</button>
				</form>

				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={() => setPasteOpen((v) => !v)}
						className="border border-border px-2 py-1 font-condensed text-[11px] font-bold uppercase tracking-wider text-muted hover:text-text"
					>
						{pasteOpen ? "Close Paste" : "Paste Code"}
					</button>
					<button type="button" title="Zoom out" onClick={() => setZoom((z) => Math.max(50, z - 25))} className="p-1 text-muted hover:text-text">
						<ZoomOut size={14} />
					</button>
					<span className="w-10 text-center font-mono text-[10px] text-muted">{zoom}%</span>
					<button type="button" title="Zoom in" onClick={() => setZoom((z) => Math.min(200, z + 25))} className="p-1 text-muted hover:text-text">
						<ZoomIn size={14} />
					</button>
					{activeDoc && (activeDoc.kind === "svg" || activeDoc.kind === "image") ? (
						<button
							type="button"
							onClick={annotateCurrent}
							className="ml-1 flex items-center gap-1 bg-red px-2.5 py-1 font-condensed text-[11px] font-bold uppercase tracking-wider text-white hover:bg-red-hot"
						>
							<PenTool size={11} />
							Annotate
						</button>
					) : null}
				</div>
			</div>

			{/* Detected Chat Visual Artifacts Strip */}
			{chatArtifacts.length > 0 ? (
				<div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-bg/70 px-3 py-1.5">
					<span className="font-mono text-[10px] uppercase tracking-wider text-muted">From Chat:</span>
					{chatArtifacts.map((art) => (
						<button
							key={art.id}
							type="button"
							onClick={() => openInCanvasViewer(art)}
							className={`border px-2 py-0.5 font-mono text-[10px] transition-colors ${
								activeDoc?.title === art.title
									? "border-red bg-red/15 text-text"
									: "border-border bg-surface text-muted hover:border-red/60 hover:text-text"
							}`}
						>
							{art.title}
						</button>
					))}
				</div>
			) : null}

			{loadError ? (
				<div className="border-b border-red/40 bg-red/10 px-3 py-1.5 font-mono text-[11px] text-red-hot">{loadError}</div>
			) : null}

			{pasteOpen ? (
				<div className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface p-3">
					<div className="flex items-center gap-2">
						{(["svg", "html", "markdown"] as const).map((k) => (
							<button
								key={k}
								type="button"
								onClick={() => setPasteKind(k)}
								className={`px-2 py-0.5 font-mono text-[10px] uppercase ${pasteKind === k ? "bg-red text-on-red" : "border border-border text-muted"}`}
							>
								{k}
							</button>
						))}
						<button
							type="button"
							onClick={() => {
								if (!pasteText.trim()) return;
								openInCanvasViewer({ title: `Pasted ${pasteKind.toUpperCase()}`, kind: pasteKind, content: pasteText });
								setPasteOpen(false);
							}}
							className="ml-auto bg-red px-3 py-1 font-condensed text-[11px] font-bold uppercase tracking-wider text-on-red"
						>
							Render
						</button>
					</div>
					<textarea
						rows={4}
						value={pasteText}
						onChange={(e) => setPasteText(e.target.value)}
						placeholder="Paste <svg>...</svg>, HTML mockup, or Markdown..."
						className="w-full border border-border bg-bg p-2 font-mono text-xs text-text focus:border-red focus:outline-none"
					/>
				</div>
			) : null}

			{/* Main Viewer Canvas */}
			<div className="min-h-0 flex-1 overflow-auto bg-[#060508] p-4">
				{!activeDoc ? (
					<div className="flex h-full flex-col items-center justify-center gap-2 text-center">
						<Eye size={28} className="text-muted/50" />
						<p className="font-display text-2xl tracking-wider text-muted/70">NO DOCUMENT LOADED</p>
						<p className="max-w-sm font-mono text-xs text-muted">
							Ask the agent to output an SVG diagram or HTML mockup in Chat, open a workspace `.svg`/`.html`/`.md` file above, or paste code to preview.
						</p>
					</div>
				) : activeDoc.kind === "markdown" ? (
					<div
						style={{ transform: `scale(${zoom / 100})`, transformOrigin: "top center" }}
						className="mx-auto max-w-3xl border border-border bg-surface p-6"
					>
						<div className="mb-3 border-b border-border pb-2 font-mono text-[11px] uppercase tracking-wider text-muted">
							{activeDoc.title}
						</div>
						<MarkdownText text={activeDoc.content} />
					</div>
				) : activeDoc.kind === "image" ? (
					<div className="flex h-full items-center justify-center">
						<img
							src={activeDoc.content}
							alt={activeDoc.title}
							style={{ transform: `scale(${zoom / 100})` }}
							className="max-h-full max-w-full object-contain shadow-xl ring-1 ring-border"
						/>
					</div>
				) : (
					<div className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden border border-border bg-white">
						<div className="flex items-center justify-between border-b border-border bg-surface px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-muted">
							<span>{activeDoc.title}</span>
							<span>Sandboxed Preview</span>
						</div>
						<iframe
							title={activeDoc.title}
							sandbox=""
							srcDoc={buildSandboxedSrcDoc(activeDoc.kind, activeDoc.content)}
							style={{ transform: `scale(${zoom / 100})`, transformOrigin: "top left", width: `${10000 / zoom}%`, height: `${10000 / zoom}%` }}
							className="flex-1 border-0 bg-white"
						/>
					</div>
				)}
			</div>
		</div>
	);
}
