---
name: vue3-page-builder
description: Build and refactor Vue 3 pages in this repo using Composition API, Pinia, Vue Router, reusable composables, shared UI components, and project code standards. Use when implementing or polishing frontend pages, page-level state, routing behavior, reusable utilities, or when enforcing ESLint, Prettier, Husky, and Commitlint conventions.
---

# Vue3 Page Builder

## Overview

Use this skill to deliver Vue 3 pages that are thin, modular, and easy to maintain. Prefer page orchestration in the page file, reusable logic in composables and utils, shared state in Pinia, and reusable UI in common components.

## Workflow

1. Inspect the existing app structure first.
   - Follow the repository's current folders, naming, and import style.
   - Reuse existing components, composables, stores, and utilities before creating new ones.

2. Shape the page boundary before coding.
   - Keep page files focused on layout, orchestration, and route-driven data flow.
   - Move repeated or non-visual logic into composables or utils.
   - Move cross-page or shared business state into Pinia only when it is genuinely shared.

3. Implement with Vue 3 Composition API.
   - Prefer `<script setup lang="ts">`.
   - Use props, emits, computed, watch, and lifecycle hooks with explicit intent.
   - Keep side effects isolated and easy to test.
   - Favor derived state over duplicated state.

4. Use Pinia and Vue Router with restraint.
   - Use Pinia for shared, cached, or workflow state that spans pages or components.
   - Use Vue Router for route params, query state, navigation guards, and page transitions.
   - Keep route logic close to routing concerns, not buried in UI components.

5. Extract reusable code aggressively enough, but not prematurely.
   - Extract a composable when the same orchestration, data access, or effect logic appears more than once.
   - Extract a utility when the logic is pure, framework-agnostic, or data-transforming.
   - Extract a shared component when UI structure, interaction, or styling repeats.
   - Keep shared abstractions small and focused; prefer one responsibility per file.

6. Keep implementation aligned with team standards.
   - Respect ESLint and Prettier output without workaround code.
   - Preserve or add Husky-friendly changes so hooks stay green.
   - Use Commitlint-safe commit messages when a commit is part of the task.

When a task needs more detail on extraction thresholds or review steps, read [vue3-page-workflow.md](references/vue3-page-workflow.md).

## Extraction Rules

- Prefer `composables/` for reusable reactive logic and side effects.
- Prefer `utils/` for pure helpers, formatters, mappers, and guards.
- Prefer `components/` for reusable UI, empty states, lists, dialogs, and form sections.
- Prefer `stores/` for shared state and derived actions that survive page switches.
- If a pattern appears once, keep it local unless it is obviously destined to repeat.
- If a page becomes hard to read, split by responsibility before adding more code.

## Repo Conventions

- Treat `apps/web/pages/` as the route layer and keep it orchestration-focused.
- Put cross-page UI in `apps/web/components/` when it is reusable and not tied to a single route.
- Put route-agnostic logic in `apps/web/composables/` and pure helpers in `apps/web/utils/`.
- Create `apps/web/stores/` when shared state needs to survive navigation or coordinate multiple views.
- Keep feature-specific code close to the feature until it clearly needs to be shared.

## Quality Gate

Before finishing, verify that the page:

- Renders correctly in the target route and responsive breakpoints.
- Has no obvious dead code, duplicated logic, or unnecessary abstraction.
- Passes lint and formatting expectations.
- Preserves existing team conventions for naming, file placement, and imports.
- Leaves reusable code in the right shared location instead of repeating it in the page.

## References

- [vue3-page-workflow.md](references/vue3-page-workflow.md)
