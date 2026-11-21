# SpineAnimator — фундаментальная архитектура специализированного AGI-агента

## 1. Назначение

SpineAnimator — специализированная мультимодальная агентная система, которая превращает предоставленный пользователем PSD-макет (файл или разрешённую публичную ссылку) в проверяемый Spine-проект и производственные артефакты. Главный сайт — единый conversational workspace. Производственная логика, секреты, планировщик и нативный Spine Editor не размещаются в публичном frontend.

AGI здесь — целевой уровень автономности в специализированной области, а не утверждение, что универсальный AGI уже создан. До появления измеримых benchmark-результатов корректное название — специализированный автономный Spine Animation Agent.

Система разделяется на четыре контура:
1. Experience — чат, проекты, загрузка источников, прогресс, превью и выдача файлов.
2. Intelligence — восприятие, понимание задачи, планирование, принятие решений, оценка качества и восстановление.
3. Execution — Tool Registry, DAG-оркестратор, изолированные workers и Ubuntu CI с лицензированным Spine Professional Editor.
4. Knowledge — библиотека Spine-проектов, эталонных анимаций, ассетов, rig-паттернов и проверенных workflow.

## 2. Фундаментальные принципы

- Source fidelity first: исходные пиксели, видимость, draw order, координаты и иерархия PSD сохраняются; преобразования явно записываются и проверяются.
- Plan before tools: сначала анализ и исполняемый план, затем запуск.
- Smallest sufficient workflow: минимальный набор операций, достаточный для результата.
- Composable tools: новые workflow строятся из типизированных инструментов, даже если нет одной готовой команды на всю задачу.
- Native truth: JSON/ZIP или браузерный preview не эквивалентны нативному Spine Editor roundtrip.
- Fail closed: неоднозначные цели, неизвестный формат, потеря слоёв или неподтверждённый результат останавливают этап, а не маскируются успешным статусом.
- Evidence-bound status: каждый PASS связан с source hash, версией инструмента, workflow run и артефактом.
- No fake completion: технический fallback, mock и preview не выдаются за художественно завершённую или нативно проверенную анимацию.
- Human approval is explicit: подтверждение требуется только для действительно неоднозначных художественных или рискованных решений.

## 3. Главный интерфейс

Главная страница строится вокруг чата:
- боковая панель: новый проект, история проектов, библиотека, Tools & Services;
- composer: кнопка «+», загрузка PSD, URL-поле, описание задачи и отправка;
- лента сообщений: запросы пользователя, план, статусы, предупреждения и результаты агента;
- rich artifacts: интерактивный Spine preview, video player, image gallery и ссылки скачивания;
- project inspector: размеры исходника, слои, skeleton, clips и статусы проверок;
- Tools menu: Spine-Resize, Spine-Mask-Tool, 2Spine, 3Spine, Spine Renderer, Atelier Library, Animation Library и инженерные сервисы.

Текущая UI-ветка добавляет оболочку чата и каталог сервисов к существующему frontend. Она не означает, что backend уже отдаёт все виды preview/video или что все подсистемы подключены к production orchestrator.

## 4. PSD ingestion и безопасность

- Разрешённые источники: локальная загрузка и allowlisted публичные URL-провайдеры.
- Проверки: MIME, расширение, PSD signature, полный размер, SHA-256, размеры canvas и decompression limits.
- SSRF-защита: блокировать localhost, private/link-local IP, нестандартные порты, credentials, redirects и произвольные схемы.
- URL resolver — allowlist, а не универсальный proxy.
- Оригинал неизменяем; производные артефакты связаны с source hash.
- PSD parsing изолирован по памяти и времени.
- Smart Objects, text, adjustment layers, blend modes и effects получают явный статус: сохранены, rasterized, unsupported или needs_input.

## 5. Computer Vision и Scene IR

CV извлекает PSD tree, groups, visibility, opacity, blend modes, masks, bounds, composite image и независимые raster layers. Далее определяются семантические объекты, части персонажа, joints, occlusion/depth order, deformation regions, mesh candidates и pivots.

Каждая гипотеза сопровождается evidence: layer ID, bounding box, contour/mask, confidence и provenance. Имя слоя само по себе не является доказательством семантического типа.

Результат — промежуточное представление Scene IR, независимое от Spine JSON/SKEL:
- source assets с неизменяемыми ID;
- объекты, transforms, parent-child relationships;
- draw order, skins, slots, attachments;
- pivot/joint candidates, mesh topology;
- constraints, IK targets и path candidates;
- clipping requirements;
- исходная setup pose и координатные системы.

Scene IR отделяет понимание сцены от конкретного экспортера и позволяет менять backend tools без потери смысла проекта.

## 6. Animation Planner и DAG

Planner получает Scene IR, prompt, ограничения, библиотечные примеры и capability registry. На выходе создаётся Animation Plan:
- цели, клипы, длительность, FPS, loop semantics;
- rig hierarchy, bones, slots, attachments, skins;
- mesh/weights, IK/transform/path/physics constraints;
- key poses, timing, curves, anticipation, overlap, follow-through;
- draw-order changes, events и masks;
- quality gates, ожидаемые артефакты и rollback checkpoints.

План компилируется в DAG. Узел имеет id, tool, inputs, outputs, dependsOn, preconditions, timeout, retryPolicy, evidence и acceptanceChecks. Независимые узлы могут идти параллельно; конфликтующие операции сериализуются. Retry разрешён только для временных ошибок и идемпотентных операций.

### Условные способности

- mask.generate включается только при requirements.clippingMask === true.
- При включённой маске обязательны однозначные maskTargets с slot/attachment/skin/path. Неоднозначность возвращает needs_selection; агент не угадывает.
- spine.resize вызывается только при обнаруженной необходимости преобразования скелета или геометрии.
- Decompile/convert tools включаются при несовместимом или бинарном входном формате, а не автоматически всегда.
- Renderer запускается после получения валидного Spine runtime artifact и по требуемым форматам.
- 3Spine Native Editor workflow обязателен для production-native acceptance, а не для каждого промежуточного preview.

## 7. Tool Registry

Каждый инструмент описывается машинно-читаемым manifest:
- toolId, version, description, capabilities;
- inputSchema, outputSchema;
- поддерживаемые Spine versions и file formats;
- execution environment: browser, Node, Rust/WASM, Ubuntu Editor;
- resource limits, security class, side effects, idempotency;
- timeout/retry policy, required secrets и license constraints;
- validation rules, provenance и artifact contract.

Tool adapters не смешивают UI, planning и execution. Входы/выходы каждого узла — версионируемые артефакты. Planner строит последовательности по семантике и схемам capabilities, а не только по заранее написанным сценариям.

### Подсистемы

- 2Spine — технологические решения, AI tools и интеграционные адаптеры.
- Spine-Resize — геометрия, bones, constraints/IK и связанные данные.
- Spine-Mask-Tool — маски и clipping workflow; optional capability.
- 3Spine-core — конвертация, декомпиляция, упаковка, парсинг и native Spine Editor CI.
- vladleopold/spine — рендеринг Spine в video/image sequences и форматы.
- spine-atelier-library — ассеты, шаблоны и структурированные эталоны.
- spine-animation-library — архив реальных Spine-проектов и анимаций.
- spine-web-source — исходник публичного frontend.
- spine-animator-private — приватное ядро, движок, планирование и runtime-интеграции.

Указанные владельцем количества инструментов (45/10/105+/25 и т. п.) — ориентир инвентаризации. Production registry должен получать точные capabilities из manifests, а не полагаться на числа из описаний.

## 8. Knowledge archive ~2000 Spine projects

Архив не должен просто подаваться модели как набор ZIP. Каждый проект проходит ingest:
1. источник, права/лицензия, hash, формат и версия Spine;
2. декомпиляция/конвертация через 3Spine, если требуется;
3. извлечение skeleton, bones, slots, skins, attachments, meshes, constraints и animations;
4. разбор atlas, texture regions, draw order и timeline;
5. render preview и извлечение frame samples;
6. структурированное описание и quality metadata;
7. дедупликация и версионирование.

Индекс содержит несколько представлений:
- semantic search по описанию движения и композиции;
- structural retrieval по bone graph, constraints, slots и mesh topology;
- visual retrieval по кадрам и ассетам;
- animation retrieval по timeline signatures, фазам и кривым;
- reusable rig/asset packs и шаблоны.

Эталоны используются как retrieval/reference и для обучения только при подтверждённых правах и provenance. Модель извлекает паттерны и адаптирует их к Scene IR, а не копирует проект вслепую.

## 9. Native execution и quality gates

3Spine Ubuntu CI с лицензированным Spine Professional Editor — источник истины для нативной совместимости. Native gate:
1. фиксирует source PSD hash, Scene IR hash и export ZIP hash;
2. импортирует проект в поддерживаемую версию Spine Editor;
3. сохраняет настоящий .spine project;
4. закрывает и повторно открывает проект;
5. проверяет bones, slots, skins, constraints, animations и atlas references;
6. экспортирует JSON/SKEL и render frames;
7. выполняет структурные и визуальные проверки;
8. сохраняет logs, frames/screenshots, manifests и CI run URL.

Quality Evaluator оценивает отдельно structural correctness, source preservation, runtime correctness, animation continuity/timing, deformation artifacts, visual fidelity и artistic quality.

Native PASS не равен artistic approval. Статусы составные: built, native_verified, visual_checked, art_approved. Каждый требует собственного evidence.

## 10. Job events и артефакты

Каждый job создаёт manifest с source hash, plan version, tool versions, CI run, checks и списком артефактов. Типы артефактов: PSD preview, layer image, Spine project, JSON, SKEL, atlas, texture, PNG sequence, WebM, MP4, report и ZIP. UI показывает только реально существующие outputs и проверенные download URLs.

Append-only job events:
accepted, source_validated, analysis_ready, plan_ready, tool_started, tool_progress, tool_completed, validation_failed, native_started, artifact_ready, completed, needs_input, failed.

UI не рисует прогресс, которого не сообщил executor. Ссылки на скачивание имеют срок действия и права доступа.

## 11. API boundaries

Рекомендуемые bounded contexts:
- projects — проекты, source assets и ownership;
- jobs — задания и статусы;
- perception — PSD parsing и CV;
- planning — Scene IR и Animation Plan;
- tools — capability registry и adapters;
- execution — DAG scheduler и workers;
- native — Spine Editor CI;
- knowledge — archive, retrieval и asset packs;
- artifacts — manifests, storage и downloads;
- conversation — messages, job events и media cards.

Рекомендуемые контракты:
- POST /api/projects — создать проект;
- POST /api/sources — зарегистрировать upload или allowlisted URL;
- POST /api/jobs — поставить задачу и prompt;
- GET /api/jobs/{id} — статус и план;
- GET /api/jobs/{id}/events — stream событий;
- GET /api/jobs/{id}/artifacts — проверенные outputs;
- POST /api/jobs/{id}/decisions — ответ на needs_input;
- GET /api/tools — capabilities и версии;
- GET /api/library/search — поиск эталонов и ассетов.

GitHub Pages остаётся frontend delivery surface. Секреты, PSD processing, orchestration и native CI выполняются на серверных/CI компонентах.

## 12. Этапы внедрения

A — Experience shell: чат, вложения, ссылки, tools menu, сообщения, artifact cards и адаптивный layout. Не обещать backend-функции, которых ещё нет.

B — Runtime contracts: единые Project/Job/Artifact/Event schemas, API gateway, source ingestion, tool manifests и реальный progress stream.

C — Planner and registry: Scene IR, structured Animation Plan, DAG scheduler, conditional tools и fail-closed semantics.

D — Native production: production adapters, 3Spine CI execution, Editor roundtrip и native artifact packaging.

E — Knowledge archive: ingest библиотеки, decompile/render/index, structural + visual + animation retrieval и reusable packs.

F — Quality and autonomy: benchmark set, regression suite, automatic repair, provenance, confidence calibration, artistic evaluation и controlled deployment.

## 13. Acceptance criteria

Production acceptance требует, чтобы PSD upload и URL ingestion проверяли полный источник; source layer tree и пиксели имели provenance; Planner создавал валидные Scene IR и DAG; Registry выбирал только необходимые tools; optional capabilities не запускались без оснований; реальные инструменты выполнялись вместо mocks; native Editor roundtrip подтверждался CI evidence; preview/video строились из фактического Spine результата; ZIP содержал manifest и зависимости; чат показывал только подтверждённые статусы и артефакты; regression suite покрывал PSD, rig, constraints, masks, animation, export и recovery.

## 14. Текущее техническое состояние

Публичный frontend уже содержит PSD parser, cloud planner call и ZIP exporter integration. Это не подтверждает production-интеграцию всего Tool Registry, 3Spine native workflow или библиотеки эталонов. Новая UI-оболочка является первым этапом интерфейса; последующие подключения выполняются отдельными проверяемыми изменениями.
