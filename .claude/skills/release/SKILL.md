---
name: release
description: Publish a new image of camera-recordings – either the rolling `latest` from master or a versioned `vX.Y.Z` tag – and verify that the NAS is running it. Use when asked to release, publish, tag a version, ship, or "get this onto the NAS".
disable-model-invocation: true
---

# Release

`.github/workflows/publish-image.yml` runs `npm test`, then builds
`linux/amd64` + `linux/arm64` and pushes to `ghcr.io/irelevant25/camnode`.

| Trigger | Image tags | Version shown in the UI (top right) |
| --- | --- | --- |
| push to `master` | `latest`, `sha-<short>` | `sha-<short>`, linked to the commit |
| push of a tag `v*` | `<tag>`, `sha-<short>` | the tag |

Pushing and tagging are outward-facing: **confirm with the user before
`git push` or `git tag`**, every time.

## Steps

1. `git status` clean, on `master`, `npm test` green.
2. Rolling release: `git push origin master`.
   Versioned: bump `version` in `package.json` (it is what a from-source run
   shows, as `<version>-dev`), commit, then
   `git tag vX.Y.Z && git push origin master vX.Y.Z`.
3. Watch the run: `gh run watch` (or `gh run list --workflow "Publish image" -L 3`).
   The arm64 leg runs under emulation and compiles better-sqlite3 – ten minutes
   or more is normal. A red `test` job means nothing was published.
4. On the NAS: Portainer → the stack → **Pull and redeploy** / Synology
   Container Manager → Project → *Build* (re-pulls `latest`). `/data` is a named
   volume; the database and recordings survive.
5. Verify: the badge in the top right corner of the UI must show the new tag or
   `sha-<short>` matching `git rev-parse --short HEAD`. Amber `…-dev` means it is
   not running a published image. Then check the Cameras page: every camera
   *online*, push cameras show a fresh *subscribed* time.

## Things that bite

- Schema changes ship with the image and run in `migrate()` on first start –
  there is no down-migration. Before releasing one, make sure the user has a copy
  of `/data/camera-recordings.sqlite`.
- A change to `APP_SECRET` handling or to `src/db/crypto.js` can make stored
  camera passwords unreadable. Treat as breaking; say so in the commit message.
- Sessions are bound to the password hash and signed with `APP_SECRET`; neither
  changes on redeploy, so users stay logged in.
- New environment variables must be added to **both** compose files,
  `.env.example` and the README table, or they never reach the container.
