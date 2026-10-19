# Security policy

Legal Timers has no server, no accounts and makes no network requests: all
data stays in the user's browser. The security that matters is therefore:

- the Content Security Policy (in `public/_headers` and `public/index.html`)
  that blocks network access and injected scripts;
- safe handling of user input (dossier names, descriptions, imported backup
  files) so it can never run as script;
- not losing or corrupting the data stored in localStorage.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Report it
privately through GitHub instead: on the repository page, go to
**Security -> Report a vulnerability**. Include the steps to reproduce and,
if you can, a proof of concept (with made-up data, never real client data).

You can expect a first reply within a week. Fixes are deployed from `main`,
so a fix is live as soon as it is merged.

## Supported versions

Only the current `main` branch (the live site) is supported. If you
self-host, update to the latest `main`.
