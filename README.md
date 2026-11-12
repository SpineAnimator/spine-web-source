# Spine Animator — Public Website Source

This repository is generated from an explicit **frontend-only allowlist** maintained in the private development pipeline. It is not a mirror of 3Spine or the proprietary 2Spine animation agent.

## Boundary

Published: website HTML, CSS and user-facing JavaScript to accept PSD artwork, request a cloud animation, and download a server-generated ZIP.

Not published: Spine Editor license, Linux executables, 3Spine decompiler, private PSD tools, animation engine internals, CI secrets, servers, test fixtures or source repository history.

The browser sends PSD artwork layer pixels and motion instructions to separate Cloudflare endpoints. Users should not consider a response an artistically approved Spine project until verified in the licensed Editor.

GitHub Pages deploys from the separately generated public `SpineAnimator/SpineAnimator.github.io` repository. The publishing pipeline must never force-push a private source tree into either public repository.

## Publication

Source of truth: `SpineAnimator/spine-web-source` (this public frontend repository). A private 3Spine GitHub Actions workflow reads only the allowlisted HTML/JS and copies them into the public `SpineAnimator/SpineAnimator.github.io` Pages repository. No private source is checked out or uploaded during synchronization.

The browser sends rasterized source layers to the private Cloudflare planner and ZIP builder. This is not a published, standalone open-source animation agent; no licensed Linux converter or editor binaries are included.
