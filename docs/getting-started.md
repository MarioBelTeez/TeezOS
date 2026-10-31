# Getting started with TeezOS

If you've only used the Claude app or ChatGPT, here's the main difference: **TeezOS works on folders on your own computer.** You pick a project folder, and the AI can read the files in it, edit them and run commands there. It asks first, and you approve. Around that you get a code editor, a terminal, and a reader for your own notes (the **Brain**).

This guide has two parts:

- **Part 1, everyone (about 15 minutes):** install, connect Claude, open your first project, set up the Brain and the Feed.
- **Part 2, homelab only:** connect a Proxmox server, scheduled jobs and the phone app. Skip it if you don't run a home server.

---

## Part 1: the basics

### 1. Install TeezOS

1. Download `TeezOS-Setup-<version>.exe` from the [Releases page](../../../releases).
2. Run it. Windows will say **"Windows protected your PC"**, because the installer isn't code-signed. Click **More info → Run anyway**.
3. TeezOS opens. There are no automatic updates yet: check the Releases page now and then.

### 2. Connect Claude (Claude Code)

TeezOS doesn't have its own AI. It drives **Claude Code**, Anthropic's command-line version of Claude, and it uses **your Claude subscription** (Pro or Max), so there's no extra bill.

1. Install Claude Code by following [code.claude.com](https://code.claude.com). On Windows that's one command in PowerShell.
2. Open a terminal, type `claude` and log in with your Claude account when it asks. Close it again afterwards.
3. Restart TeezOS. It finds Claude Code on its own. If the chat says *Claude Code is not installed where TeezOS looks*, open the terminal in TeezOS and run `claude` once.

> **Using ChatGPT instead?** Codex (ChatGPT's coding agent) isn't supported yet. It's being worked on. For now TeezOS runs **Claude** and, optionally, Google's **Antigravity** (see step 6).

### 3. Open your first project

1. Click **Pin a folder** and choose a folder: a project, a school assignment, anything with files in it.
2. It appears as a tab at the top. Its files are on the left, and the editor is in the middle.
3. Open the **Chat** and ask something about the folder, for example *"what's in this project?"* or *"make me a README"*.

**Approvals:** before Claude edits a file or runs a command, TeezOS shows you exactly what it wants to do and waits for you to click **Approve** or **Deny**. That's the main habit to learn coming from the Claude app. Read what it asks before you click.

Useful shortcuts:

| Keys | What it does |
|---|---|
| Ctrl+P | Open a file by name |
| Ctrl+K | All commands |
| Ctrl+` | Show or hide the terminal |
| Ctrl+B | Show or hide the file tree |
| Ctrl+J | Show or hide the chat |

### 4. Set up the Brain (your notes)

The **Brain** is a reader for a folder of notes in Markdown (`.md` files). It shows links between notes, backlinks and a graph, and has a chat that answers from your notes. It works great with [Obsidian](https://obsidian.md) (free) for writing the notes, but Obsidian isn't required.

> **Important (for now):** TeezOS finds your notes folder **by its name**. It has to be called **`TeezMind`**. A folder picker is planned.

1. Create a folder called `TeezMind` in your user folder: `C:\Users\<your name>\TeezMind`.
2. Put at least one note in it, for example `Home.md` containing `# Home`. To link notes, write `[[Note name]]`.
3. **Restart TeezOS.** It looks for the folder when it starts.
4. Open the **Brain** view. Your notes, their links and the graph are there.

If you already have an Obsidian vault, you can rename its folder to `TeezMind` or pin it as a workspace with that name.

### 5. The Feed (optional)

The **Feed** turns a link (a YouTube video, an article) into notes in your Brain. You paste the link, a model summarises it, and TeezOS writes the notes into your `TeezMind` folder.

It needs **one free API key**, either:

- **Gemini**: get one at [aistudio.google.com](https://aistudio.google.com) → *Get API key*, or
- **Groq**: get one at [console.groq.com](https://console.groq.com) → *API Keys*. Groq can also transcribe videos that have no subtitles.

Paste the key in **Settings → Feed**. It's stored encrypted on your PC and never shown again.

Free tiers have limits. If you send several links at once and some fail with "rate limit", retry them one at a time.

### 6. Antigravity (optional)

If you have Google's **Antigravity** CLI (`agy`) installed and logged in, you can pick it as the agent in the chat instead of Claude. Settings → Chat chooses the default agent and the model for each.

### 7. Turn off what you don't use

**Settings → Modules** switches off the parts you don't need, such as Server and Automations if you have no home server. The app gets simpler without them.

---

## Part 2: homelab (advanced)

This part is for people running a **[Proxmox](https://www.proxmox.com)** server at home. You'll need to be comfortable with SSH and a Linux shell.

### Connect the server

The **Server** view shows your Proxmox host: health, storage, ZFS, the UPS, backups, and your containers and VMs with power buttons.

1. **Set up an SSH key to the Proxmox host** so that `ssh <alias>` logs in as root without a password. Add an entry to `C:\Users\<you>\.ssh\config`, for example:

   ```
   Host pve
     HostName 192.168.1.2
     User root
     IdentityFile ~/.ssh/id_ed25519
   ```

2. Check it works: `ssh pve hostname` should print the host's name.
3. In TeezOS open **Server**, type your alias (`pve`) and press **Connect**.

TeezOS logs in once over SSH and creates a **separate, limited user** (`teezai@pve`) and an API token. That user can read status, power guests on and off, take backups and reboot the host. It **cannot** create or delete machines, change their settings or manage users. The token is encrypted on your PC, and every connection is pinned to your server's own certificate. Pressing Connect again replaces the token.

### Scheduled jobs (Automations)

The **runner** is a small service in its own container on your server that runs Claude Code jobs on a schedule, for example a daily summary of your notes.

1. Copy this repo to the Proxmox host.
2. Edit the network defaults at the top of `runner/deploy/provision.sh`, then run it as root:
   `bash runner/deploy/provision.sh <vmid> <ip/cidr> <gateway> <storage>`
3. In TeezOS open **Automations → Connect the runner** and follow the steps there. Claude jobs need a long-lived Claude token: Automations shows how to make one.

### The phone app

A phone web app (add it to your home screen) for chats with your notes, the Feed, server status and runs. **It's only reachable over your private [Tailscale](https://tailscale.com) network, never the open internet.** It needs the runner from the step above.

1. On the PC: `npm run build:phone`, then copy the repo, including `phone/dist`, to the Proxmox host.
2. Edit `phone/deploy/teez-phone.service`. **Set `TEEZ_PHONE_LOGIN` to your own Tailscale login** (for example `yourname@github`); the service refuses to start without it. Set `TEEZ_PHONE_PUBLIC_URL` to the address the phone will use.
3. Run `bash phone/deploy/provision.sh <vmid>` as root. The first run prints a vault deploy key and a Tailscale login link. Do both, then run it again.
4. On the phone, with Tailscale on, open the address it printed, then **Share → Add to Home Screen**.
5. In TeezOS on the PC: **Settings → Feed → Send keys to the phone server**, so the phone's Feed can use your Gemini or Groq key.
6. Optional: the iPhone Share Sheet shortcut in [`phone/shortcut/README.md`](../phone/shortcut/README.md).

---

## Help

- Something broken? Open an issue, and **never paste API keys or tokens into it**.
- A security problem? Use the **Security** tab of the repository to report it privately. See [SECURITY.md](../SECURITY.md).
