/**
 * When the app window's page starts a new document (Ctrl+R, a dev reload),
 * its renderer forgets every browser tab, so the native views have to go
 * too: otherwise they stay drawn over the fresh UI and keep running unseen.
 */
export function startsNewDocument(details: { readonly isMainFrame: boolean; readonly isSameDocument: boolean }): boolean {
	return details.isMainFrame && !details.isSameDocument;
}
