# Agent instructions — Spine Mask Tool

Read [AI_AGENT_MOBILE_CLIPPING.md](./AI_AGENT_MOBILE_CLIPPING.md)
before changing clipping geometry, export, Chrome Native Messaging, runtime
performance or any test for this tool. Those constraints take precedence over
generic code-generation shortcuts.

- One actual Spine clipping attachment on the **original** targeted region,
  not an extra image or overlay. Do not reintroduce the previously rejected
  `mask-overlay.png` workaround.
- Preserve original project, animations, draw order, image paths, unbound
  animator assets (`hotspot.png`), and NDA confidentiality. Keep the
  exported local project distinct from the source file.
- Keep the highlight checkbox as an agent-controllable mode. No sliders.
- Use a **project-defined** 240-vertex ceiling for 30 concurrently visible
  skeletons as a *candidate budget*, not as an Esoteric Software limit or
  proof of mobile FPS. Prefer lower complexity only when the geometry and
  actual clipped triangles/convex partitioning are more efficient.
- For the selected bright text, retain letters, inner holes, and noncrossing
  invisible bridges. Dark coverage up to 3% can be considered only if measured
  and if it gives material performance savings. Document the tradeoff.
- Benchmarks must distinguish Editor PNG export, native Spine import/export,
  desktop CPU tests and actual 30-skeleton mobile **runtime** tests.
- Never claim visual approval or mobile FPS performance without the matching
  evidence. Fail closed on missing or ambiguous evidence.
- Run the official offline clipping audit at
  `tools/mobile-spine-runtime-audit.mjs` with
  `@esotericsoftware/spine-core@4.3.13`. Measure convex-part counts,
  real `SkeletonClipping.clipTriangles` results for a representative region,
  and a 30-instance desktop JavaScript CPU probe; explicitly mark it as
  **not** a mobile benchmark. Keep all input geometry and files local.
  The CI regression in `.github/workflows/verify-mask-mobile-runtime.yml`
  uses synthetic polygons exclusively.
