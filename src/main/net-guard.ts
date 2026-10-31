/**
 * A file:// URL that names a host — "file://host/share" or "file:////host/share" —
 * is a Windows network path. Loading one makes Windows try SMB and hand the
 * user's NTLM hash to that host. The app only ever loads its own local files
 * ("file:///C:/…"), so every other file:// request is refused.
 */
export function isNetworkFileUrl(url: string): boolean {
	return /^file:/i.test(url) && !/^file:\/\/\/(?![\\/])/i.test(url);
}
