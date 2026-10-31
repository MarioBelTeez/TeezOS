/** Vite's side-effect stylesheet import and raw-text imports, without pulling in vite/client globally. */
declare module "*.css";

declare module "*?raw" {
	const text: string;
	export default text;
}
