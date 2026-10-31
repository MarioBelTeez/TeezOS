/**
 * Decide whether this build may update itself, and with what credential.
 *
 * TeezAI's repository is private, so reading its releases needs a GitHub
 * token — and that token must never ship inside the app. An installer's asar
 * unpacks with one command, so a bundled secret is a published secret. It is
 * supplied at runtime instead: an environment variable, a token saved in
 * Settings (encrypted with the OS keystore), or a file the user writes once
 * into the app's own data folder.
 *
 * With no token the updater simply stays off. The app is fully usable; it just
 * will not notice new versions, and the user re-runs an installer instead.
 */

/** Written by the user into the app's userData folder; never committed. */
export const TOKEN_FILE_NAME = "update-token";

export type UpdateEnvironment = {
	/** False while running from source: a dev tree has nothing to replace. */
	readonly isPackaged: boolean;
	readonly env: Record<string, string | undefined>;
	/** Contents of the token file, or null when it does not exist. */
	readonly readTokenFile: () => string | null;
	/** The token saved in Settings, decrypted, or null. */
	readonly readStoredToken?: () => string | null;
};

export type UpdateConfig =
	| { readonly enabled: true; readonly token: string }
	| { readonly enabled: false; readonly reason: string };

function firstToken(environment: UpdateEnvironment): string | null {
	// The app's own variable, then what was saved in Settings, before a general
	// GH_TOKEN — often a developer's broad token that should not be used here.
	const candidates = [
		environment.env["TEEZAI_UPDATE_TOKEN"],
		environment.readStoredToken?.() ?? null,
		environment.env["GH_TOKEN"],
		environment.readTokenFile(),
	];

	for (const candidate of candidates) {
		const trimmed = candidate?.trim();
		if (trimmed) return trimmed;
	}
	return null;
}

export function resolveUpdateConfig(environment: UpdateEnvironment): UpdateConfig {
	if (!environment.isPackaged) {
		return {
			enabled: false,
			reason: "Updates apply to an installed build; this one runs from source.",
		};
	}

	const token = firstToken(environment);
	if (!token) {
		return {
			enabled: false,
			reason:
				"Automatic updates are off. To turn them on, save a GitHub token with " +
				"read-only access to the TeezAI repository in Settings → Updates, put it " +
				`in a file named "${TOKEN_FILE_NAME}" in this app's data folder, or set ` +
				"TEEZAI_UPDATE_TOKEN in the environment.",
		};
	}

	return { enabled: true, token };
}

/** Classic (ghp_…), fine-grained (github_pat_…) and OAuth (gho_…) tokens: one line of [A-Za-z0-9_]. */
export function isGithubToken(value: string): boolean {
	return /^[A-Za-z0-9_]{20,255}$/.test(value);
}

export type AccessCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };

const RELEASES_URL = "https://api.github.com/repos/MarioBelTeez/TeezAI/releases?per_page=1";

/**
 * Ask GitHub whether this token can read TeezAI's releases, before it is
 * saved — a token that cannot would only fail later, quietly, every six hours.
 */
export async function checkReleaseAccess(
	token: string,
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<AccessCheck> {
	try {
		const response = await fetchImpl(RELEASES_URL, {
			headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "TeezOS" },
			signal: AbortSignal.timeout(15_000),
		});
		// Classic tokens report their scopes; reading a private repository needs
		// "repo", which also allows writing to every repository of the account.
		const scopes = response.headers.get("x-oauth-scopes");
		if (response.ok && scopes !== null && /(^|,)\s*repo\s*(,|$)/.test(scopes)) {
			return { ok: false, message: "A classic token with the repo scope can also write to your repositories. Create a fine-grained token: only TeezAI, Contents read-only." };
		}
		if (response.ok) return { ok: true };
		if (response.status === 401) return { ok: false, message: "GitHub refused this token (expired, revoked or mistyped)." };
		if (response.status === 404 || response.status === 403) {
			return { ok: false, message: "This token cannot read the TeezAI repository. Give it Contents: read-only on MarioBelTeez/TeezAI." };
		}
		return { ok: false, message: `GitHub answered ${response.status}.` };
	} catch (error) {
		return { ok: false, message: `GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}` };
	}
}
