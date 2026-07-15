# Vue 3 Page Workflow

## Default order

1. Read the page and related files.
2. Identify route inputs, local state, shared state, and repeated UI.
3. Decide what belongs in the page, a composable, a store, a utility, or a shared component.
4. Implement the page with Composition API and narrow responsibilities.
5. Extract repeated logic or UI into reusable modules.
6. Run lint and formatting checks, then fix the remaining issues.

## Extraction thresholds

- Extract a composable when the same reactive workflow, fetch logic, watcher setup, or effect handling repeats.
- Extract a utility when logic is pure and not tied to Vue lifecycle or rendering.
- Extract a shared component when markup, interaction, or styling is reused across pages.
- Extract a Pinia store when state must survive navigation, be shared across multiple views, or support coordinated actions.

## Review checklist

- The page file should stay readable at a glance.
- Shared logic should live in the smallest reasonable abstraction.
- Naming should follow the repository's existing conventions.
- Formatting, linting, and hook-friendly output should remain clean.

## Repo map

- `apps/web/pages/`: route entry points and page orchestration
- `apps/web/layouts/`: application shells and shared page chrome
- `apps/web/middleware/`: route guards and navigation-time checks
- `apps/web/composables/`: reusable reactive logic and side effects
- `apps/web/utils/`: pure helpers and data transforms
- `apps/web/components/`: reusable UI and shared sections
- `apps/web/stores/`: shared Pinia state
