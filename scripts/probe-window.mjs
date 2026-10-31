/**
 * Check the running window's layout from outside it.
 *
 * Unit tests cannot catch this class of bug: the title bar was present,
 * styled, 40px tall and "visible", yet nobody could see it, because an
 * overflowing child made the document taller than the viewport and the chat's
 * autoscroll then scrolled the whole shell — leaving the header at top: -33.
 * Only a rendered window has that answer.
 *
 * Usage:
 *   TEEZAI_DEBUG_PORT=9222 npm run dev      (in one terminal)
 *   node scripts/probe-window.mjs           (in another)
 *
 * Exits non-zero when the shell is scrolled or the title bar is off screen.
 */

const PORT = process.env["TEEZAI_DEBUG_PORT"] ?? "9222";
const TIMEOUT_MS = 15_000;

const EXPRESSION = `JSON.stringify({
  header: (() => {
    const h = document.querySelector("header");
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { top: Math.round(r.top), height: Math.round(r.height), text: h.innerText.split("\\n")[0] };
  })(),
  scrollY: window.scrollY,
  innerHeight: window.innerHeight,
  docHeight: document.documentElement.scrollHeight
})`;

const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`)
	.then((response) => response.json())
	.catch(() => null);

if (!targets) {
	console.error(`No DevTools endpoint on ${PORT}. Is the app running with TEEZAI_DEBUG_PORT set?`);
	process.exit(2);
}

const page = targets.find((target) => target.type === "page");
if (!page) {
	console.error("No page target found.");
	process.exit(2);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
const timer = setTimeout(() => {
	console.error("Timed out waiting for the page to answer.");
	process.exit(2);
}, TIMEOUT_MS);

socket.onopen = () =>
	socket.send(
		JSON.stringify({
			id: 1,
			method: "Runtime.evaluate",
			params: { expression: EXPRESSION, returnByValue: true },
		}),
	);

socket.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.id !== 1) return;
	clearTimeout(timer);
	socket.close();

	const layout = JSON.parse(message.result.result.value);
	console.log(JSON.stringify(layout, null, 2));

	const problems = [];
	if (!layout.header) problems.push("no <header> in the document");
	else if (layout.header.top !== 0) problems.push(`title bar at top ${layout.header.top}, expected 0`);
	else if (layout.header.height < 1) problems.push("title bar has no height");
	if (layout.scrollY !== 0) problems.push(`the shell is scrolled (scrollY ${layout.scrollY})`);
	if (layout.docHeight > layout.innerHeight)
		problems.push(`document ${layout.docHeight}px exceeds viewport ${layout.innerHeight}px`);

	if (problems.length > 0) {
		console.error(`FAIL:\n  ${problems.join("\n  ")}`);
		process.exit(1);
	}
	console.log("OK: title bar at the top, shell not scrolled.");
	process.exit(0);
};
