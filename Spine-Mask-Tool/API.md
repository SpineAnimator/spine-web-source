# Spine Mask Tool — Full project Linux API v2

The site and agents share one ephemeral, privately processed queue in
`vladleopold/3Spine-core`. Ubuntu GitHub Actions installs licensed Spine Editor
**4.3.26** in Xvfb, imports the original project, re-exports native Spine,
validates the single clipping attachment and existing animation, and returns
a checked ZIP. The existing v1 native PNG preview route is unchanged.

## Site user flow

- **From Spine** reads the open document through the installed native Chrome Bridge.
- **Make all** creates the full local ZIP immediately, then **explicitly uploads a
  copy of the selected project** to private Ubuntu CI. Do not use this feature
  for data you are not authorized to transmit. The original local project is
  never overwritten, and the locally downloaded ZIP remains available if CI fails.
- After the server is ready, the site validates the returned ZIP's complete
  SHA-256 before offering it for download.
- **Agents** mode retains all legacy controls and exposes
  `window.SpineMaskAgentControl.verifyLinuxCI()` and
  `window.SpineMaskAgentControl.getLinuxStatus()`.

## API for authorized service agents

Gateway: `https://spine-mask-native-gateway.vladyslavchaplygin.workers.dev`

1. `POST /v2/sessions`: from the site's permitted Origin, or a bearer GitHub
   access token authorized to access the private `vladleopold/3Spine-core` repo.
   Returns `id`, `uploadToken`, `resultToken`, `partBytes`, `maxBytes`.
2. `PUT /v2/sessions/{id}/input/{zeroBasedPart}` with
   `Authorization: Bearer {uploadToken}`, `X-Chunk-SHA256`, binary body.
   Each part ≤ 4 MiB, first part begins with ZIP signature.
3. `POST /v2/sessions/{id}/commit` with upload token and JSON
   `{ "parts":N, "size":BYTES, "sha256":FULL_ZIP_SHA256, "filename":"project.zip" }`.
4. `GET /v2/sessions/{id}/status` with the read token. When ready, fetch
   `GET /v2/sessions/{id}/result/{part}` with the same read token.
   Validate total size and full result ZIP SHA-256; optionally
   `DELETE /v2/sessions/{id}` after successful receipt.

Private GitHub Actions uses `GET /v2/private/queue`,
`GET /v2/private/{id}/manifest`, `GET /v2/private/{id}/input/{part}`,
`PUT /v2/private/{id}/result/{part}`, and
`POST /v2/private/{id}/complete` with a short-lived repository Actions token.
**Never** expose this token in browser JavaScript or in uploaded projects.

Limits: 64 MiB ZIP, 16 × 4 MiB parts, 1-hour TTL. Files are held in
Cloudflare KV while pending; R2 is unavailable for the connected account.
The authorized Linux runner checks file paths against traversal and symlinks,
enforces one `.json` or `.spine` skeleton, preserves supplied unattached
images, and fails closed on broken native import or mask geometry.

CI: [full project Ubuntu workflow](https://github.com/vladleopold/3Spine-core/actions/workflows/spine-mask-full-project-ubuntu.yml)
and [Linux bridge host](https://github.com/SpineAnimator/Spine-Resize).
Synthetic CI proof is **not** a mobile FPS benchmark or artistic approval
of a real user's project.
