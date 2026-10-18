# RPIV next handoffs

Current fresh-session implementation: `rpiv-praxis#y9nt`, with hardening tracked in `rpiv-praxis#6g6w`. The historical conversational-only change is `rk5x`; its verification and delivery notes are retained below.

## Conversational `next`

A standalone `next` explicitly approves exactly the default RPIV skill most recently recommended by the assistant in this conversation. The handoff carries the full command, all arguments (including any phase), and the exact working directory. Alternatives are not defaults. Research and explore default to design; blueprint remains an explicit alternative.

The assistant loads and follows the actual skill, never an improvised substitute. Missing, stale, ambiguous, blocked, or wrong-worktree context requires clarification. Do not search for the newest artifact, start the rest of the pipeline, commit/push merely because a handoff exists, or treat a quoted `next` as approval. Each stage stops at its own handoff; it requires a new approval.

`next` relies on conversation context. After `/new`, paste the complete fallback command and working directory. Fresh-context execution remains available but is not mandatory for a user-approved conversation-local transition. Existing workflow-runner routing and internal-only stages are unchanged.
## Fresh-session `/next`

Kata: `rpiv-praxis#y9nt`. This is the source contract; source verification does not mean an installed Pi package has been updated. Delivery requires separate approval, package identity checks, and an installed-host smoke test.

`/next` is a registered command, not a synonym for plain `next`. It accepts no arguments and reads only the latest completed assistant message on the active session branch. It never searches older messages or selects the newest artifact. The closing handoff must include one actionable public-stage command and all of:

- **Next step:** the complete `/skill:<stage>` command, including quoted paths and any `Phase N` argument.
- **Working directory:** the absolute directory matching both Pi's tool cwd and the process cwd.
- **Input artifact:** one absolute, readable document path also present in the command arguments.
- **Branch:** the exact symbolic branch of the current worktree.
- **Kata issue:** a qualified, open and ready issue, such as `rpiv-praxis#y9nt`.

The footer must end with `Reply /next to run only the step above in a fresh session.` outside code fences and quotes. Legacy two-field footers still support conversational `next`; request a refreshed footer or use the full command manually instead of `/next`.

### Before replacement

The source session must be saved, idle, in a trusted project, with no queued input and no running detached lane. Wait for a running lane to finish; `/next` never aborts it. The existing worktree and exact issue are checked read-only. Uncommitted changes are allowed (`--allow-dirty`); no stash, checkout, worktree creation, bootstrap, issue creation, or issue claim is performed. Protected editing branches and detached HEAD are refused. Register the repository's Kata workspace separately before using this command; `/next` never initializes it.

The target skill must be one of discover, research, design, explore, plan, blueprint, implement, or validate, with installed skill provenance. Skills needing argument/variable substitution or shell-context setup require loaded `rpiv-args`; missing dependencies fail before reset. Arbitrary commands, internal workflow stages, commit, and push are not supported targets.

### One replacement, one invocation

A successful preflight saves a recovery attempt in native session custom entries, replaces the session in the same worktree, then rechecks the target context and artifact hash. The target receives a compact provenance capsule and the exact approved command, not the old transcript. Its one-shot authorization admits only that skill/path/argument tail. Normal skill expansion/setup and per-skill model/thinking overrides apply; the target baseline is restored after the run or pre-agent dispatch failure.

The source session remains available in history. A receipt records input acceptance, not stage completion or validation success. Any recommendation produced by the selected skill requires new user approval; `/next` never advances the rest of the pipeline.

### Recovery

- **Wrong directory:** leave the source intact, launch Pi in the intended working directory, and use the full command there. An absolute artifact path does not redirect tools to another worktree.
- **Missing artifact, stale hash, blocked/closed issue, or unavailable check:** correct the condition or request a refreshed handoff before retrying. No preflight failure consumes an attempt.
- **Reset veto:** the source attempt is recorded as cancelled, no command is sent, and retry is allowed once the veto is resolved.
- **Startup/setup failure or unknown delivery:** retain the source attempt and any target records. Resume the source session file or inspect the existing target in session history. Automatic replay is refused because a stage might already have started. Confirm the target state before using the exact manual command/workdir from the recovery diagnostic. Do not treat an unknown delivery as permission to run twice.

Manual fallback is always the complete approved `/skill:<stage> ...` command in its recorded working directory. Plain `next` cannot recover a prior conversation after `/new`.


## Source validation (`rpiv-praxis#y9nt`)

**Verdict: source change approvable; installed delivery pending.** Verified on 2026-10-18 in branch `y9nt-next-phase1`, based on `2fdacf2354ff75dba95039b9f7b25287445a4547`. These are uncommitted worktree results, not a release or an installed-package claim. This section supersedes the earlier failing validation report.

### Acceptance evidence

- **P1.1–P1.4:** `next-command.test.ts` verifies footer/latest-message selection, exact phase-bearing arguments, file/provenance binding, dirty continuation and read-only preflight guards. Runtime cases assert no reset or source attempt on refusal. The new safety suite rejects command shadowing and unsupported tab delimiters before reset.
- **P2.1/P2.5 and P3.2:** `next-host-smoke.test.ts` invokes the real SDK `/next` handler and native runtime replacement with a test-only skill, deterministic provider and native `bash pwd`. It checks distinct source/target session IDs, source-file lineage, unchanged tool cwd, compact fresh model context without the old transcript, exact quoted `Phase 1` input, setup once, accepted target receipt, model/thinking restoration exactly once, and no next-stage execution after a model-emitted footer. Network access is forbidden. Only read-only issue/preflight facts are injected; no live Kata policy or installed-package behavior is inferred from this fixture.
- **P2.2:** `next-command-recovery.test.ts` covers creation/setup failure after source disposal, post-reset artifact changes, two source sessions with different commands, twenty simultaneous invocations, veto followed by retry, and unknown-delivery replay refusal. Source methods throw if used after disposal. Snapshots and diagnostics retain the source session file, exact command and working directory.
- **P2.3/P2.4:** `next-loader.test.ts` executes the actual `rpiv-args` and skill bracket handlers in both orders. Twenty cases cover substitution, skill-relative references, real shell setup once in the verified directory, token/non-token trailers, outer argument whitespace, literal `Skill input:` arguments, wrong skill/path/tail rejection, and model/thinking restoration. Existing interactive, workflow/RPC exclusion and bracket tests remain green.
- **Additional safety review (`6g6w`):** ten executable regressions cover extension-command collisions before reset and in the replacement registry; the ASCII-space delimiter required by both loaders; and revocation after target artifact/issue/dependency refusal or thrown validation/preflight. Target registry access is owned by the target extension, not a disposed source API. The independent reviewer reran these cases and the native smoke (11 tests) and found no remaining concrete blocker in the targeted review.
- **P3.1/P3.4:** existing Vitest discovery reaches the added tests; registration and publication checks pass. Source docs and generated hosts preserve the five-field actionable footer protocol and distinguish continuation, reset, failure recovery and delivery.

### Executed checks

| Check | Result |
| --- | --- |
| `npm test -- --maxWorkers=2` | 338 files, 7,260 tests passed |
| `npm test -- packages/rpiv-pi packages/rpiv-args --maxWorkers=2` | 110 files, 2,113 tests passed after mutation restoration |
| Focused command/registration/recovery/safety/loader/native-smoke/bracket/pipeline/session-hook suite | 10 files, 127 tests passed after mutation restoration |
| `npm run export:hosts` then `npm run check:hosts` | Generated mirrors match source |
| `npm run check:host-provided-deps` | Passed |
| `npm run check:decision-codes` | Passed |
| `npm run check:file-sizes` | Passed; baseline not raised |
| Local `tsc --noEmit -p tsconfig.base.json` | Passed |
| Non-writing Biome with `--error-on-warnings`, all changed TypeScript files | Passed |
| `git diff --check` | Passed |
| `npm pack --dry-run --ignore-scripts --json --workspace=@juicesharp/rpiv-pi` | Runtime modules included; no tests or native-smoke fixtures published |

The unbounded default-worker full-suite attempt exceeded its 180-second timeout; it was not counted as a pass. The complete bounded two-worker run above passed in 221.66 seconds. Reconcile-lint emitted its expected missing-file/phase diagnostics during negative-path tests; no test failed.

### Red/green and mutation evidence

- Loader regressions initially produced three failures: bracket-first wrong-path acceptance, and token/non-token outer-whitespace order dependence. Fresh target skill-registry binding and tail normalization fixed them; all twenty now pass.
- Creation/setup recovery initially produced two failures for missing source-file/command/workdir diagnostics. The snapshot and recovery diagnostic fix made all seven recovery cases pass.
- The lineage regression failed with a source UUID in `parentSession`; native lineage requires the source session file. The corrected command and real-host smoke pass.
- The independent safety regressions initially produced nine failures and one positive control. Collision guards, native target revocation and delimiter checks made all ten pass.
- **Protected-worktree guard mutation:** replacing the protected-branch condition with `false` made `rejects wrong cwd, branch, ...` fail (`ok:true` instead of refusal).
- **One-shot mutation:** removing receipt exclusion made `consumes a replacement authorization ...` fail (two model changes instead of one).
- **Model-restore mutation:** removing the target restoration call made `restores through the target-owned callback ...` fail (zero baseline-model restores).
- Each mutation was undone immediately. The restored 127-test focused suite and 2,113-test package suite then passed.

### Delivery boundary (P3.3)

**Not installed, deployed, committed or pushed.** The native smoke uses the repository-resolved Pi SDK and inert resources, not the user's installed RPIV package. Before claiming `/next` is available in the user's normal installation, obtain separate delivery approval, use the declared package/configuration source path, verify installed module and instruction identity against the approved source, reload/restart as appropriate, and repeat the inert installed-host smoke with temporary config/session directories. Keep the prior package source/version available for rollback. No hand edits to installed `node_modules` or rendered home configuration are authorized by source approval.

## Historical conversational implementation plan (`rk5x`)

1. Add failing tests for the injected authorization contract and handoff templates.
2. Update the pipeline pointer and closing blocks; preserve explicit fallback commands and validation gates. Update the fresh-context guide to explain both routes.
3. Regenerate host exports. Run focused tests, host-drift validation, and lint/type checks. Document observed results below without claiming model behavior from text assertions alone.

## Historical conversational verification (`rk5x`)

- Baseline: the new instruction tests failed on the original source (16 failures), establishing the absent approval wording and handoff offers. The original pointer injection/frontmatter-sync tests remain intact.
- `npm test -- packages/rpiv-pi`: 100 test files, 1,942 tests passed. Expected negative-path stderr from reconcile-lint fixtures appeared; there were no failing tests.
- Focused final run: pointer, session hooks, and host exporter: 64 tests passed.
- Mutation check: replacing the pointer's `exactly one` with `all remaining` produced one failing test (22 passed); restoring it returned all 23 pointer tests to green as part of the 64-test run.
- `npm run check:hosts`, targeted Biome with `--error-on-warnings`, root TypeScript `tsc --noEmit`, and `git diff --check` passed. Host exports were regenerated through `npm run export:hosts`.
- Independent bounded adversarial review found no remaining concrete defects in the inspected pointer, shared rules, research/validate/discover handoffs, and tests. The reviewer correctly identified the temporary mutation; it was restored before final verification.
- Full pre-merge checks found the original test file exceeded its size ratchet. The new contract cases were moved to `pipeline-next.test.ts`, leaving the original pointer tests unchanged. File-size and decision-code guards then passed; the four-file focused suite still passed all 64 tests. Full-repo Biome reported only four pre-existing informational suggestions, no warnings/errors.
- These are instruction-contract, generation, injection, lint, and type checks. They do not establish live model/CLI end-to-end execution. No actual RPIV stage was launched.

## Historical delivery boundary (`rk5x`)

The reviewed change was prepared in `/Users/srvo/dev/rpiv-praxis-rk5x-next`, branch `rk5x-next`, based on fork main `304b78af`. The user subsequently authorized merging into the original checkout at `/Users/srvo/.cache/monocloud/rpiv-praxis` and rebuilding the local install from there. No registry publication or unrelated package upgrades are intended. Praxis's global CLI is linked to that original checkout; Pi loads a separate installed npm copy, which also needs updating. No changes are made to the user's dirty monocloud checkout or the th5f artifacts. Installation evidence is recorded in kata `rk5x` after execution.
