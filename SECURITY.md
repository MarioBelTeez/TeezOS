# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting instead: open the **Security** tab of this
repository and choose **Report a vulnerability**. Include what you found, how to
reproduce it, and which version you tested.

This is a small personal project, so there is no formal timeline, but reports
are read and taken seriously.

## What is in scope

- The desktop app (`src/`): path handling, IPC validation, secret storage,
  anything that could reach the file system, a shell or the network from the
  renderer.
- `runner/` and `phone/`: authentication and anything that executes jobs.

## Good to know

- TeezOS runs shells and AI agents on your machine by design. Anything an agent
  does with your approval is expected behaviour, not a vulnerability.
- Never put real API keys in issues or pull requests.
