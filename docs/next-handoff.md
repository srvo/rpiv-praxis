# Conversation-local next handoffs

Kata: `rk5x`. User approved current-conversation scope, not recovery after `/new`.

## Contract

A standalone `next` explicitly approves exactly the default RPIV skill most recently recommended by the assistant in this conversation. The handoff carries the full command, all arguments (including any phase), and the exact working directory. Alternatives are not defaults. Research and explore default to design; blueprint remains an explicit alternative.

The assistant loads and follows the actual skill, never an improvised substitute. Missing, stale, ambiguous, blocked, or wrong-worktree context requires clarification. Do not search for the newest artifact, start the rest of the pipeline, commit/push merely because a handoff exists, or treat a quoted `next` as approval. Each stage stops at its own handoff; it requires a new approval.

`next` relies on conversation context. After `/new`, paste the complete fallback command and working directory. Fresh-context execution remains available but is not mandatory for a user-approved conversation-local transition. Existing workflow-runner routing and internal-only stages are unchanged.

## Implementation plan

1. Add failing tests for the injected authorization contract and handoff templates.
2. Update the pipeline pointer and closing blocks; preserve explicit fallback commands and validation gates. Update the fresh-context guide to explain both routes.
3. Regenerate host exports. Run focused tests, host-drift validation, and lint/type checks. Document observed results below without claiming model behavior from text assertions alone.

## Verification

- Baseline: the new instruction tests failed on the original source (16 failures), establishing the absent approval wording and handoff offers. The original pointer injection/frontmatter-sync tests remain intact.
- `npm test -- packages/rpiv-pi`: 100 test files, 1,942 tests passed. Expected negative-path stderr from reconcile-lint fixtures appeared; there were no failing tests.
- Focused final run: pointer, session hooks, and host exporter: 64 tests passed.
- Mutation check: replacing the pointer's `exactly one` with `all remaining` produced one failing test (22 passed); restoring it returned all 23 pointer tests to green as part of the 64-test run.
- `npm run check:hosts`, targeted Biome with `--error-on-warnings`, root TypeScript `tsc --noEmit`, and `git diff --check` passed. Host exports were regenerated through `npm run export:hosts`.
- Independent bounded adversarial review found no remaining concrete defects in the inspected pointer, shared rules, research/validate/discover handoffs, and tests. The reviewer correctly identified the temporary mutation; it was restored before final verification.
- Full pre-merge checks found the original test file exceeded its size ratchet. The new contract cases were moved to `pipeline-next.test.ts`, leaving the original pointer tests unchanged. File-size and decision-code guards then passed; the four-file focused suite still passed all 64 tests. Full-repo Biome reported only four pre-existing informational suggestions, no warnings/errors.
- These are instruction-contract, generation, injection, lint, and type checks. They do not establish live model/CLI end-to-end execution. No actual RPIV stage was launched.

## Delivery boundary

The reviewed change was prepared in `/Users/srvo/dev/rpiv-praxis-rk5x-next`, branch `rk5x-next`, based on fork main `304b78af`. The user subsequently authorized merging into the original checkout at `/Users/srvo/.cache/monocloud/rpiv-praxis` and rebuilding the local install from there. No registry publication or unrelated package upgrades are intended. Praxis's global CLI is linked to that original checkout; Pi loads a separate installed npm copy, which also needs updating. No changes are made to the user's dirty monocloud checkout or the th5f artifacts. Installation evidence is recorded in kata `rk5x` after execution.
