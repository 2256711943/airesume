---
name: gdc
description: Grill → Develop → Complete pipeline. After grill-me, grill-with-docs, or a fully-resolved wayfinder map concludes (all tickets closed, frontier empty), invoke this to: write spec → audit for gaps → break into tickets → triage tickets → develop via Subagent(s) → spec review → fix spec → code review → fix code → evaluate completion. Use when a grill session or wayfinder map ends and the user wants to proceed to implementation, or when user says "gdc", "develop after grill", "implement the plan".
argument-hint: "[optional: specific implementation guidance or constraints]"
---

# GDC — Grill → Develop → Complete

Orchestrate the full pipeline from a concluded grilling session or a fully-resolved wayfinder map through to verified implementation.

## When to invoke

- A `grill-me` or `grill-with-docs` session has just concluded and the user says "go implement" or equivalent
- A `wayfinder` map's tickets are all closed — the frontier is empty and the way to the destination is clear — and the user wants the effort implemented
- User explicitly says "gdc", "grill develop complete", or "implement the plan"
- User asks to "proceed with implementation" after a design discussion

## Pipeline

Execute these phases sequentially. After each phase, report a brief summary before proceeding to the next.

### Phase 0 — Determine mode and feature directory

Determine the entry **mode** from how this session reached gdc:

- **grill-me** — a `/grill-me` session just concluded
- **grill-with-docs** — a `/grill-with-docs` session just concluded
- **wayfinder** — a `/wayfinder` map's tickets are all closed (frontier empty, destination clear)

Then ask the user for the feature name (a short kebab-case slug, e.g. `regulator-region-level`). All spec and ticket files will be saved under `.scratch/<feature-name>/`.

If the user doesn't provide one, derive it from the conversation context — in **wayfinder** mode, from the map's Destination — and confirm with the user.

### Phase 1 — Spec

Write the spec to `.scratch/<feature-name>/PRD.md`. Use the canonical template from `to-spec` — Read its SKILL.md and follow the `<spec-template>` structure (Problem Statement, Solution, User Stories, Implementation Decisions, Testing Decisions, Out of Scope, Further Notes).

**The spec's source depends on the mode:**

- **grill-me / grill-with-docs** — write the spec from the grilling conversation.
- **wayfinder** — synthesize the spec from the map: load the map issue — including its `## Notes`, which name the skills and standing preferences the effort should consult — read each closed ticket's resolution comment, and convert `Destination` + `Decisions so far` into the spec. The map's decisions are the ground truth — do not re-grill them. Completion criterion: every line of `Decisions so far` is accounted for in the spec (as a user story, an implementation decision, or an explicit out-of-scope note), and the spec adds nothing the map never decided.

One gdc-specific addition: under **Testing Decisions**, Read the `/what-to-test` skill's SKILL.md, then apply its decision framework and record the results — test complex logic, skip simple orchestration, use domain events as seams.

After writing, confirm the spec was saved and note its path.

### Phase 2 — Requirements Gap Analysis

After the spec is written but before breaking it into tickets, re-explore the codebase to discover missed requirements and areas that need modification.

1. Read the spec to understand the full scope of changes
2. Explore the codebase using codegraph to trace:
   - Related code paths and interfaces touched by the feature
   - Modules, types, and functions that interact with the target area
   - Existing patterns and conventions in adjacent code
3. Look for gaps and missed requirements:
   - **Hidden dependencies** — upstream or downstream systems that will be affected
   - **Ripple effects** — changes that cascade beyond the stated scope
   - **Missing edge cases** — error states, empty states, loading states, race conditions
   - **Cross-cutting concerns** — auth/permissions, logging, monitoring, error handling, i18n, accessibility
   - **Existing patterns to follow or refactor** — shared utilities, design patterns, or anti-patterns in the target area
   - **Configuration or infrastructure changes** — env vars, feature flags, database migrations, API versioning
4. Present findings to the user as a numbered gap list
5. **Classify each gap** as either:
   - **Trivial** — the fix is mechanical (add a loading state, null check, error message) and follows an existing pattern in the codebase. No design choice involved — just do it.
   - **Worth grilling** — the gap involves a choice between at least two reasonable approaches, has downstream architectural consequences, or needs user preference to resolve. If you can't name two distinct viable paths, it's not worth grilling.
     Present the classification to the user and confirm before proceeding.
6. **Write ALL gaps into the spec first** — before any grilling. Trivial gaps go directly into the relevant spec sections (User Stories, Implementation Decisions, Testing Decisions, etc.). Worth-grilling gaps are recorded as pending items under Implementation Decisions with a brief note that a decision is needed.
7. **Grill the worth-grilling gaps** one at a time. For each:
   - State the gap and what makes it non-trivial (the competing forces)
   - Present the viable approaches with your recommendation
   - Ask one question at a time — per the [grilling](grilling) skill, multiple questions at once are bewildering
   - Exit when a concrete decision is reached
   - Update the spec with the decision (replace the pending note)
     Skip gaps the user says are out of scope — remove them from the spec.

**This phase is about completeness, not correctness.** The goal is to surface what the spec may have overlooked, not to judge whether the spec's stated requirements are correct. Do NOT change the spec's core decisions — only fill in what was missed.

### Phase 3 — Ticket breakdown

Break the spec into **tracer-bullet tickets** following the `to-tickets` discipline. Each ticket is a vertical slice through every layer, sized for one context window.

**Core concepts (from `to-tickets`):**

- **Blocking edges** are first-class. Every ticket declares which other tickets must complete before it can start, forming a DAG. No ticket is worked until its blockers are all done.
- **Work the frontier.** Any ticket whose blockers are all complete can be grabbed — these are the only tickets eligible for Phase 5 at any moment.
- **Wide refactors** are the exception to vertical slicing. A **wide refactor** is one mechanical change (rename a column, retype a shared symbol) whose blast radius spans the codebase so broadly that no single vertical slice can land green. Don't force it into a tracer bullet — sequence it as **expand–contract**:
  1. **Expand** — add the new form beside the old so nothing breaks. One ticket, green.
  2. **Migrate** — convert call sites in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by Expand, keeping CI green batch to batch.
  3. **Contract** — delete the old form once no caller remains. One ticket blocked by every Migrate batch.

**GDC additions (not in upstream `to-tickets`):**

**Business verifiability standard.** Each ticket must deliver a complete, user-visible outcome a business stakeholder can verify end-to-end:

> Can a non-technical stakeholder open the app, walk through this slice, and confirm "yes, this delivers the business value I asked for" **without depending on work from another ticket**?

Each ticket bundles whatever frontend, backend, database, config, and infrastructure work its behavior needs. Never split by technical layer.

**Anti-patterns — horizontal splits (never do this):**

- ❌ "Build the API endpoints" + "Build the UI" — neither slice is business-verifiable
- ❌ "Write database migrations" — no user-visible behavior on its own
- ❌ "Add backend validation" — can't verify without the frontend to trigger it
- ❌ "Implement JWT token refresh" — technically testable, but no stakeholder sees it; bundle it into the slices that need auth
- ❌ "Add loading skeletons" — visible but not a self-contained business outcome; bundle with the feature it supports
- ❌ "Set up CI pipeline" — infrastructure, not a business outcome

**Correct pattern — slices by business verifiability:**

- ✅ "User can create and view a profile" — bundles form UI, API route, DB schema, validation
- ✅ "User receives email confirmation on signup" — bundles email template, send trigger, config, UI feedback
- ✅ "Admin can filter user list by role" — bundles admin page, query API, filter logic, pagination

**Process:**

1. Present the proposed ticket breakdown as a numbered list. For each ticket, show:
   - **Title**: short descriptive name
   - **Blocked by**: which other tickets (if any) gate this one
   - **What it delivers**: the end-to-end behavior this ticket makes work
2. Quiz the user:
   - Does the granularity feel right? (too coarse / too fine)
   - Are the blocking edges correct — does each ticket only depend on tickets that genuinely gate it?
   - Should any tickets be merged or split further?
   - Is any ticket a wide refactor needing expand–contract?
3. Iterate until the user approves.

If the user says the work is too small for multiple tickets, proceed to Phase 5 with a single Subagent implementing the entire spec.

4. Write each approved ticket as a numbered file under `.scratch/<feature-name>/issues/`, e.g. `01-create-profile.md`, `02-email-confirmation.md`. Publish in dependency order (blockers first) so filenames can be referenced in the "Blocked by" field.

<issue-template>
# <NN> — <Ticket title>

**What to build:** the end-to-end behavior this ticket makes work, from the user's perspective — not layer-by-layer.

**Blocked by:** the numbers/titles of the tickets that gate this one, or "None — can start immediately".

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Independent verification

How to verify this ticket is complete on its own (without depending on other tickets):

1. Check out the branch
2. [Step to trigger the behavior — e.g. "Open /admin/users, click 'Add Filter'"]
3. [Expected end-to-end result — e.g. "User list updates with filtered results"]
   </issue-template>

### Phase 4 — Triage

If tickets were created in Phase 3, triage them before development begins. Invoke the `triage` skill to move each ticket through the triage state machine:

1. Read each ticket from `.scratch/<feature-name>/issues/`
2. For each ticket, determine:
   - **Category**: `bug` or `enhancement`
   - **State**: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, or `wontfix`
3. Present a triage summary to the user with recommended category and state for each ticket
4. Apply the triage outcomes:
   - **`ready-for-agent`** — ticket is fully specified and ready for Phase 5 development
   - **`ready-for-human`** — flag to the user that this ticket needs human implementation (judgment calls, external access, design decisions, manual testing)
   - **`needs-info`** — ask the user for clarifications before proceeding
   - **`wontfix`** — mark the ticket as out-of-scope and skip it in development
5. Update each ticket file with triage metadata (category, state, triage notes) at the top of the file

**If no tickets were created (single Subagent path):** Skip this phase and proceed to Phase 5.

### Phase 5 — Subagent development

**Architecture: single-level Subagent.** Subagents are NOT nested — there is exactly one level of delegation. Each Subagent returns its results to the main Session. The main Session evaluates those results in the full global context, decides what to do next, and then spawns the next wave. No Subagent ever spawns another Subagent.

**Development loop:**

```
1. Identify which tickets are unblocked (their "Blocked by" list contains only completed tickets,
   or "None - can start immediately").

2. Spawn Subagents (subagent_type: "gdc-developer") in PARALLEL for ALL unblocked tickets.
   - Each prompt includes: the spec path, the ticket body, instruction to read relevant code first, and instruction to follow `/tdd` workflow:
     1. Read the `/what-to-test` skill's SKILL.md and apply it to every new or changed module to decide what must be tested
     2. Write tests (red)
     3. Implement (green)
     4. Refactor
   - All spawned in ONE message with run_in_background: true

3. Wait for ALL spawned Subagents to complete.

4. For each completed Subagent, the main Session evaluates its result:
   - Was the ticket fully implemented?
   - Are there gaps or problems?
   - Did something unexpected surface that affects other tickets?

5. For any ticket with gaps:
   - Spawn a follow-up Subagent with the gaps to address
   - Wait for it to complete and re-evaluate
   - Loop until the ticket is done or remaining gaps are acceptable

6. Repeat from step 1 until all tickets are done.
```

**If single Subagent (no tickets):**

- Spawn one Subagent with `subagent_type: "gdc-developer"`
- Pass the spec path and conversation context as its prompt
- Instruct the Subagent to read relevant code before making changes
- Instruct the Subagent to follow `/tdd` workflow:
  1. Apply `/what-to-test` to every new or changed module to decide what must be tested
  2. Write tests (red)
  3. Implement (green)
  4. Refactor
- If the spec involves backend code, instruct the Subagent to read and enforce rules from the `backend-architecture` skill before writing any backend code
- Wait for completion, then main Session evaluates the result in global context
- If gaps exist, spawn follow-up Subagents one at a time until done

**Concurrency rule:** Tickets that don't block each other run in parallel. Tickets that are blocked by another ticket wait for it to complete. The main Session is the decision-maker — it reads every Subagent result, evaluates it against the full spec and codebase context, and decides the next action. Subagents execute; the main Session orchestrates.

### Phase 6 — Spec Review

Spawn the spec review Subagent to verify the implementation against the spec:

1. **Subagent (subagent_type: "gdc-prd-reviewer"):** `Review the current git diff against the spec at .scratch/<feature-name>/PRD.md. Check that every user story and acceptance criterion is satisfied. Report gaps as numbered findings.` In **wayfinder** mode, also pass the map's `Decisions so far` and instruct the reviewer to check the diff against them as well — they are the ground truth the spec was synthesized from.
2. Present findings to the user as a numbered list
3. **Classify each finding** as either:
   - **Trivial** — the fix is mechanical (missing field, wrong label, incorrect copy) and follows an existing pattern in the codebase. No design choice involved — just fix it.
   - **Worth grilling** — the finding involves a choice between at least two reasonable approaches, has downstream architectural consequences, or needs user preference to resolve.
4. **If ALL findings are Trivial:** Report the findings briefly and proceed directly to Phase 7 (Fix spec findings) — no need to ask the user. There is nothing worth grilling.
5. **If ANY finding is Worth grilling:** Present the classification to the user and confirm before proceeding. Then **grill the worth-grilling findings** one at a time. For each:
   - State the finding and what makes it non-trivial (the competing forces)
   - Present the viable approaches with your recommendation
   - Ask one question at a time — per the [grilling](grilling) skill, multiple questions at once are bewildering
   - Exit when a concrete decision is reached
   - Record the decision in the spec under Implementation Decisions
     Skip findings the user says are out of scope.

### Phase 7 — Fix spec findings

If the spec review found issues:

- Spawn ONE fix Subagent with `subagent_type: "gdc-developer"` that receives the classified spec review findings (both trivial and grilled decisions)
- Prompt: `Fix the following spec review findings. [findings with decisions]. Apply fixes to the working tree.`
- Wait for completion, then evaluate: were all findings addressed?
- If not, loop until done or remaining findings are acceptable.

### Phase 8 — Code Review

After spec fixes are applied, spawn the code review Subagent on the **current** diff (now includes spec fixes):

1. **Subagent (subagent_type: "gdc-code-reviewer"):** `Review the current git diff for correctness bugs and reuse/simplification/efficiency cleanups. Focus on: type safety, error handling, edge cases, consistency with surrounding code patterns, and unnecessary abstraction. Report findings as a numbered list.`
2. Present findings to the user as a numbered list
3. **Classify each finding** as either:
   - **Trivial** — the fix is mechanical (null check, missing await, wrong type, dead code) and follows an existing pattern in the codebase. No design choice involved — just fix it.
   - **Worth grilling** — the finding involves a tradeoff (simplicity vs DRY, perf vs readability), a non-obvious design choice, or needs user preference to resolve.
4. **If ALL findings are Trivial:** Report the findings briefly and proceed directly to Phase 9 (Fix Code findings) — no need to ask the user. There is nothing worth grilling.
5. **If ANY finding is Worth grilling:** Present the classification to the user and confirm before proceeding. Then **grill the worth-grilling findings** one at a time. For each:
   - State the finding and what makes it non-trivial (the competing forces)
   - Present the viable approaches with your recommendation
   - Ask one question at a time — per the [grilling](grilling) skill, multiple questions at once are bewildering
   - Exit when a concrete decision is reached
   - Record the decision in the spec under Implementation Decisions
     Skip findings the user says are out of scope.

### Phase 9 — Fix Code findings

If the code review found issues:

- Spawn ONE fix Subagent with `subagent_type: "gdc-developer"` that receives the classified code review findings (both trivial and grilled decisions)
- Prompt: `Fix the following code review findings. [findings with decisions]. Apply fixes to the working tree.`
- Wait for completion, then evaluate: were all findings addressed?
- If not, loop until done or remaining findings are acceptable.

### Phase 10 — Evaluate completion

Review the final state:

1. Rerun any failing tests
2. Verify build succeeds
3. Compare the diff against the spec's user stories one last time
4. Report to the user:

> **GDC complete.**
>
> - Spec: `.scratch/<feature-name>/PRD.md`
> - Tickets: [N created / none] under `.scratch/<feature-name>/issues/`
> - Subagents spawned: [N]
> - Spec review findings fixed: [N]
> - Code review findings fixed: [N]
> - Build: [pass/fail]
> - Tests: [pass/fail]
> - Remaining concerns (if any): [list]

## File layout

```
.scratch/<feature-name>/
├── PRD.md                    # Phase 1 output (Phase 2 gap analysis may update)
└── issues/                   # Phase 3 output (if split into tickets)
    ├── 01-first-slice.md     # Phase 4 triage metadata added inline
    ├── 02-second-slice.md
    └── ...
```

`.scratch/` is committed to the repo — these files are part of the project's design documentation.

## Rules

- Never skip a phase unless the user explicitly asks to
- Each phase must complete before the next begins
- Specs and tickets are saved to `.scratch/<feature-name>/` — NEVER publish to external issue trackers
- If a Subagent fails or times out, spawn a fresh one with the same prompt (max 2 retries per Subagent)
- Do not push or merge code unless the user explicitly asks
- If the session approaches the smart zone (~120k tokens) mid-pipeline, don't push on degraded — run `/handoff` and continue in a fresh thread referencing the file
- **Ticket decomposition must be by business verifiability** — bundle frontend, backend, and database work into the same ticket so each slice delivers a complete user-visible outcome a business stakeholder can verify. No splits by technical layer (API layer / UI layer / migrations as separate tickets).
- **Only ONE level of Subagent** — Subagents execute tasks and return results to the main Session. The main Session evaluates results in global context and decides the next action. Subagents never spawn Subagents.
