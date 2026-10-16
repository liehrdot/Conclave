# Security

## Reporting a problem

Please don't open a public issue for a security problem. Use GitHub's private
[security advisory form](https://github.com/liehrdot/Conclave/security/advisories/new) instead.

## How the code is checked

- **Every pull request** gets an AI security review (the required `claude` check). Any finding blocks the merge.
- **CodeQL** scans the Python and JavaScript code on every pull request, on `master` and once a week. The CodeQL
  badge in the README shows the latest result on `master`.
- **Tests** run on every pull request and must pass before a merge.

## Full review, 2026-10-16

The whole project was reviewed once by hand: the desktop backend and web GUI, the sync server and phone app, the
Windows shell and its updater, the build and release workflows, and the hosted sync service.

What was fixed:

- **Sync paths and deck names.** A file name or deck name sent by another paired device or by the sync server could
  point outside the data folder on Windows (backslashes, drive letters, `../` in a deck's name). Sync now only
  accepts plain names, every path is checked to stay inside its folder, and a deck's name always comes from its
  file name.
- **Print selections.** A synced image choice could point at any image file on the PC. Only files inside the
  proxies folder are used now.
- **Updates.** The update address check now refuses `../` and encoded tricks, and preview builds can only be
  installed with "Vorschau-Versionen anzeigen" switched on.
- **Build pipeline.** The steps that hold the update signing key now use pinned versions of every third-party
  action and tool, and they run in the protected `release` environment. The sync server image is only published
  from the real `master` branch, never from a tag of the same name. Every workflow states the smallest permissions
  it needs.
- **Smaller things.** The access token is no longer written to the desktop log, and the app window no longer has
  permissions it never uses.

What was checked and found sound: the local web GUI's protection against other websites (host and origin checks,
token cookie), the phone app's escaping and its strict content security policy, backup restore (no zip tricks),
pairing codes and device tokens (stored only as hashes), how the updater checks signatures, and that pull requests
from forks never see any secret.
