# Spine Mask Tool — mobile clipping contract for AI agents

**Applicability:** Spine Editor 4.3.26; the matching Spine Runtime version in the
game; up to **30 simultaneously visible skeletons**. This is a project acceptance
contract, not an Esoteric Software certification or a device-independent
performance guarantee.

## Authoritative technical references

- Esoteric Software, Clipping attachments / Performance:
  https://esotericsoftware.com/spine-clipping#Performance
- Esoteric Software, Metrics view / Clipping polygons / Clipped triangles:
  https://esotericsoftware.com/spine-metrics
- Esoteric Software forum (Nate), Editor performance questions:
  https://esotericsoftware.com/forum/d/28365-editor-performance-questions
- Esoteric Software, Clipping / Draw order and Self-intersection:
  https://esotericsoftware.com/spine-clipping#Draw-order

Official guidance: CPU clipping cost is affected by clipping polygon complexity
**and by geometry of the attachments being clipped**; concave masks are
decomposed into convex parts. A polygon must not self-intersect. A clipping
range is inclusive of its `end` slot. Clip only what is necessary. The official
documentation **does not specify a universal fixed vertex limit** for 30 mobile
skeletons.

## Required automated behavior

1. **Keep the original project intact.** Preserve the original .spine / JSON,
   bones, animations, attachment data, original image, original draw order,
   and all local texture files, including unbound `images/hotspot.png`.
   The latter must stay byte-for-byte identical, but must **not** be uploaded
   to cloud jobs or included in a public release. Return a new project.
2. Produce **one genuine Spine clipping attachment**, positioned before the
   specifically selected original region. Its `end` targets the original
   region, unless a real animation deliberately changes the affected range.
   No extra overlay slot, no synthetic replacement PNG, no alternate texture
   passed off as a clipping mask.
3. Automatically detect the illuminated text faces and ignore black and dark
   brown shadows. Preserve every letter and its real counter/opening
   (e.g., D, A, O). Route disconnected pieces into **one non-self-intersecting
   polygon**. A connector that reveals opaque artwork is unacceptable.
4. **Engineering goal, not vendor limit:** with 30 skeletons, aim for the
   *lowest verified* mask complexity. Project soft ceiling is **240 vertices
   per clipping polygon** (5x lower than ~1200). Prefer materially fewer
   when visual quality and runtime clipping cost improve. A number below 240
   is not automatically better: convex decomposition and the number of
   clipped attachment vertices/triangles matter.
5. The AI agent may trade a **small proportion of dark pixels**, initially
   at most **3% of all opaque dark-source pixels**, for substantial runtime
   savings. Measure this on the selected source image, not by counting all
   background pixels. Preserve inner holes, reject self-intersections, and
   measure lost bright-face pixels independently. This 3% tolerance is an
   **internal artistic acceptance policy**, not an Esoteric recommendation.
6. Run quality-constrained shape reduction on the generation side only, not
   every animation frame. Try progressively simpler candidates, retain
   Pareto-optimal choices, and reject candidates that break any mandatory
   quality rule. Do not add manual threshold, tolerance or simplify sliders.
   The highlight checkbox remains an **AI-agent-controlled mode switch**.
7. The clipped rendering range should cover the **fewest attachments**.
   A single region typically contributes two attachment triangles; meshes
   can contribute many. Measure actual `Clipping polygons` and
   `Clipped triangles` in Spine's Metrics view or matching runtime
   instrumentation, not merely source vertex count.
8. Validate Spine Editor 4.3.26 import and re-export with no mesh or
   compatibility warnings; verify the original visual artwork, draw order,
   holes and dark-region exclusions. Visually test frames with animation,
   not just structure and a static screenshot.
9. Performance acceptance requires a **runtime test with 30 active skeletons
   on target mobile hardware**, including comparison with clipping disabled,
   capturing CPU frame time p50/p95, FPS, clipped polygons, clipped triangles,
   draw calls and fill-rate context. **Never claim a mobile FPS improvement
   from vertex reduction alone.** Static Editor PNG export is insufficient.

## Required output telemetry

- Source mask vertices, result mask vertices, ratio.
- Total active mask vertices for the selected concurrent skeleton count
  (e.g., 30 × 240 = 7200), explicitly labelled as a **count**, not runtime
  milliseconds or number of CPU operations.
- Source and optimized convex clipping polygon counts measured by matching
  runtime when available; number of clipped triangles.
- Bright pixels omitted %, dark opaque source pixels included %, original
  counters preserved, self-intersections=0, connector visibility=0.
- Original project hash unchanged and `hotspot.png` SHA-256 preserved.
- Native Editor import/export verdict and visual acceptance evidence.
- Target-platform 30-skeleton runtime benchmark verdict: verified, failed,
  or **not tested** (never infer one from CPU/browser/Editor measurements).

## Fail-closed conditions

If one simple clipping polygon cannot achieve the chosen mobile budget while
preserving required image regions and topology, return a truthful quality or
performance blocker. Do **not** silently substitute a fake overlay texture,
remove unused animation assets, omit holes, mutate the original project,
pretend a simulator is a real-device benchmark, or report the result as
artistically accepted.

The exact vertex budget and tolerance can later be re-derived from *actual*
game engine profiling. They are project policies and should never be presented
as fixed limits imposed by Esoteric Software.
