import type { Health, Job, Permission } from "./types.ts";

/**
 * Antigravity (`agy`) jobs. Headless agy cannot ask for permission, and its
 * flags offer no per-run tool list, so each permission level becomes allow /
 * deny rules in agy's settings file (`~/.gemini/antigravity-cli/settings.json`
 * of the job user), written before every run. Verified on the runner with agy
 * 1.3.6 in print mode: deny rules block writes, page fetches and commands;
 * allow rules let page fetches through; files outside the job's folder (agy's
 * own login included) are refused without any rule.
 *
 * Not covered by any rule: agy's web *search*. It only sends queries to
 * Google, so it is not a way to post what a job read to someone else's server.
 */

export type AgyRules = { readonly allow: readonly string[]; readonly deny: readonly string[] };

const NO_COMMANDS = ["command(*)", "mcp(*)", "execute_url(*)"];

const RULES: Readonly<Record<Permission, AgyRules>> = {
	"read-only": { allow: [], deny: ["write_file(*)", "read_url(*)", ...NO_COMMANDS] },
	research: { allow: ["read_url(*)"], deny: ["write_file(*)", ...NO_COMMANDS] },
	edit: { allow: [], deny: ["read_url(*)", ...NO_COMMANDS] },
	// The run skips permissions altogether.
	full: { allow: [], deny: [] },
};

export function agyRules(permission: Permission): AgyRules {
	return RULES[permission];
}

export function agyArgs(job: Pick<Job, "prompt" | "model" | "permission">): string[] {
	return [
		"--output-format",
		"stream-json",
		...(job.model ? [`--model=${job.model}`] : []),
		...(job.permission === "full" ? ["--dangerously-skip-permissions"] : []),
		// Attached with "=", the prompt is one value even when it starts with "-".
		`-p=${job.prompt}`,
	];
}

const MODEL_ID = /^[\w.-]+$/;

/** `agy models` prints one "id<TAB>label" per line after a progress line. */
export function parseAgyModels(output: string): { id: string; label: string }[] {
	const models: { id: string; label: string }[] = [];
	for (const line of output.split(/\r?\n/)) {
		const [id, label] = line.split("\t");
		if (!id || label === undefined || !MODEL_ID.test(id.trim())) continue;
		models.push({ id: id.trim(), label: label.trim() || id.trim() });
	}
	return models;
}

/**
 * The tools agy 1.3.6 offered when the rules above were checked. Browser tools
 * are listed but unavailable headless (checked on the runner); writes inside
 * `.git` are refused even at "edit" (also checked). A tool that is not here
 * came with an update and has not been checked against the rules.
 */
const CHECKED_TOOLS = new Set([
	"ask_custom_permission", "ask_permission", "ask_question", "browser_click_element", "browser_drag_pixel_to_pixel", "browser_get_dom",
	"browser_get_network_request", "browser_input", "browser_list_network_requests", "browser_mouse_down", "browser_mouse_up", "browser_move_mouse",
	"browser_press_key", "browser_refresh_page", "browser_resize_window", "browser_scroll", "browser_scroll_dom", "browser_select_option",
	"browser_subagent", "call_mcp_tool", "capture_browser_console_logs", "capture_browser_screenshot", "click_browser_pixel", "command_status",
	"define_subagent", "delete_knowledge", "execute_browser_javascript", "find_by_name", "finish", "generate_image", "grep_search",
	"invoke_subagent", "list_browser_pages", "list_dir", "list_permissions", "list_plugin_accounts", "list_resources", "manage_inbox",
	"manage_subagents", "manage_task", "multi_replace_file_content", "notebook_edit", "notebook_execution", "open_browser_url",
	"read_browser_page", "read_resource", "read_url_content", "replace_file_content", "run_command", "run_workflow", "schedule",
	"search_marketplace", "search_web", "sed_file", "send_command_input", "send_message", "view_file", "wait", "wait_5_seconds", "write_to_file",
]);

export function uncheckedTools(tools: readonly unknown[]): string[] {
	return tools.filter((tool): tool is string => typeof tool === "string" && !CHECKED_TOOLS.has(tool));
}

export type AgyStatus = Health["antigravity"] & { readonly path: string | null };

/** One failed probe (a slow login shell) must not make agy look uninstalled: keep the last path. */
export function keepKnownPath(previous: AgyStatus, next: AgyStatus): AgyStatus {
	return next.path || !previous.path ? next : { ...next, path: previous.path, installed: true };
}

/** Runs a command as the job user: `ok` and its stdout. */
export type RunAsJobUser = (file: string, args: readonly string[]) => Promise<{ ok: boolean; stdout: string }>;

/**
 * Where agy is for the job user (its installer puts it in ~/.local/bin, which
 * only a login shell has on the PATH), its version, and — through
 * `agy models`, which needs a working login — whether it is logged in.
 */
export async function probeAgy(run: RunAsJobUser, override?: string, retryDelayMs = 5000): Promise<AgyStatus> {
	let path = override || null;
	if (!path) {
		const found = await run("bash", ["-lc", "command -v agy"]);
		path = found.ok ? found.stdout.trim().split("\n").pop()?.trim() || null : null;
	}
	if (!path) return { path: null, installed: false, version: "", loggedIn: false, models: [] };
	// One agy at a time, and one retry: two agy processes refreshing the
	// Google login at the same moment was seen to fail one of them.
	const version = await run(path, ["--version"]);
	let models = await run(path, ["models"]);
	if (!models.ok) {
		await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
		models = await run(path, ["models"]);
	}
	const list = models.ok ? parseAgyModels(models.stdout) : [];
	return { path, installed: true, version: version.ok ? version.stdout.trim() : "", loggedIn: list.length > 0, models: list };
}

/**
 * Run by the job user (it owns the settings file) as `node -e SCRIPT <rules>`:
 * replaces only `permissions` in agy's settings, keeping every other
 * setting; a missing or broken file starts fresh. Written through a temp
 * file and a rename. Plain JS on purpose: it runs outside this module.
 */
export const WRITE_RULES_SCRIPT = `
const fs = require("fs"), path = require("path"), os = require("os");
const file = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
const rules = JSON.parse(process.argv[1]);
let settings = {};
try {
	const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed;
} catch {}
settings.permissions = { allow: rules.allow, deny: rules.deny };
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
const temp = file + ".teez-tmp";
fs.writeFileSync(temp, JSON.stringify(settings, null, 2) + "\\n", { mode: 0o600 });
fs.renameSync(temp, file);
`;
