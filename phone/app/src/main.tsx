import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("no #root element");
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

// Push and notification taps only (sw.ts): registered on every launch, it never caches anything.
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.register("/sw.js").catch((error: unknown) => console.error("TeezOS: service worker not registered", error));
}
