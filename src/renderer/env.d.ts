/// <reference types="vite/client" />

/**
 * `import "./index.css"` is a side-effect import with no runtime export, so
 * TypeScript wants a declaration for it (TS2882). Vite's own client types
 * cover the asset imports; this keeps the bare stylesheet import legal too.
 */
declare module "*.css";

declare module "*.png" {
	const src: string;
	export default src;
}
