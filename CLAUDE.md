# ECE Accounting mockup — agent entry point

Open and follow the shared rules in [`AGENTS.md`](AGENTS.md) before editing anything.
This is a browser-local synthetic mockup, not the production product.

Before any edit, explicitly read:

1. `AGENTS.md` — invariants, commands, boundaries.
2. `tasks/todo.md` — the single authoritative checklist and evidence.
3. `docs/STATE.json` and `HANDOFF.md` — current task, edit intent, known failures, next action.
4. The active section of `tasks/plan.md` and, when a rule is touched, `docs/BUSINESS-RULES.md`.

Continue existing work; never scaffold over a non-empty `mockup/`. Record actual command
results, checkpoint with `npm run checkpoint`, and leave resumable state if interrupted.
