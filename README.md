# TeezOS

A desktop workbench where **Claude Code** (on your Claude subscription) and the
**Antigravity** CLI run side by side: folder workspaces, a code editor, a real
terminal, chat with approvals, and your notes vault as a reader.
Electron + React + TypeScript. Windows first, Linux from source.

> Called TeezAI until 0.3.8. Some internal names (`TEEZAI_*` variables, the data
> folder) keep the old name on purpose so existing installs keep their settings.

| View | What it does |
|---|---|
| **Code** | Pinned folders, a live file tree with git badges, a Monaco editor (tabs, save, diff against HEAD), quick open (Ctrl+P), commands (Ctrl+K), search in files, source control that commits only the files you tick, past Claude sessions of the folder |
| **Chat** | Claude or Antigravity per workspace, model, mode and effort pickers, approvals, markdown replies, `/` command autocomplete, pasted or dropped screenshots (Claude) |
| **Terminal** | Real shells (node-pty + xterm.js): PowerShell, SSH hosts, `claude`, `agy` |
| **Brain** | A markdown vault (Obsidian-style) as a reader: wikilinks, callouts, backlinks, search, a link graph, a chat bound to the vault |
| **Feed** | Drop a video or article link; a model summarises it into notes in your vault |
| **Server** *(optional)* | A Proxmox host: health, UPS (NUT), ZFS, storage, guests with power and backup, tasks |
| **Automations** *(optional)* | Scheduled Claude Code jobs on an always-on server via `runner/` |

## Requirements

- Windows 10/11 (or Linux, built from source)
- [Claude Code](https://code.claude.com) installed and logged in, for the Claude side
- Optionally the Antigravity CLI (`agy`), and a Gemini or Groq API key for Feed
- Node.js 24+ to build from source

The Server and Automations views, `runner/` and `phone/` are for people with a
Proxmox homelab. TeezOS works fully without them; turn the modules off in
Settings.

## Install

Download the installer from the [Releases](../../releases) page and run it.
Windows may show a SmartScreen warning for an unsigned app.

**Auto-update** is wired to the author's private releases. If you install from
here, download new versions manually.

## Build from source

```
npm install          # also fetches Electron's binary (scripts/ensure-electron.mjs)
npm run dev          # TEEZAI_DEBUG_PORT=9222 to drive it over DevTools
npm test             # vitest: main-process logic, reducers, the runner
npm run typecheck
npm run package      # Windows installer in release/
```

`node-pty` ships N-API prebuilds, so nothing is compiled (`npmRebuild` is off in
the electron-builder config).

## Layout

- `src/main`: the only code with system access: settings and secrets
  (`safeStorage`), the path guard every file request goes through, git,
  terminals, the Claude and Antigravity sessions, Brain's vault index, the
  Proxmox and runner clients. `src/main/ipc/*` validates every argument.
- `src/preload`: the narrow typed bridge (`window.teez`).
- `src/renderer`: React, zustand stores in `state/`, no Node access.
- `runner/`: teez-runner, a zero-dependency Node service for scheduled jobs.
  `runner/deploy/provision.sh` creates its Proxmox container (run on the host as
  root; edit the network defaults at the top first).
- `phone/`: a phone companion (PWA + server) reachable only over your Tailscale
  network. **You must set `TEEZ_PHONE_LOGIN` to your own Tailscale login**; the
  service refuses to start without it.

## Security notes

- The renderer is sandboxed (`contextIsolation`, no `nodeIntegration`, CSP);
  links open in the browser, never in the window.
- Paths from the window are resolved inside a pinned workspace or refused
  (`..`, drives, UNC, `\\?\`, NTFS streams, 8.3 names, junction escapes).
- API keys and tokens are encrypted with the OS keystore (DPAPI on Windows) and
  read only in the main process; the window is only told whether one exists.
- The Proxmox token belongs to a dedicated user with a limited role and is only
  sent over TLS pinned to the cluster CA and certificate fingerprint. The runner
  is pinned the same way to its self-signed certificate.
- Text from the web or from a feed is treated as untrusted: notes it produces
  are stamped `provenance: feed-untrusted`.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
