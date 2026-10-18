# Praxis end-to-end audit

What this repo does: Praxis runs the same staged coding workflows as `rpiv-pi`, but uses Claude Code instead of Pi to execute them. It adds saved questions, resume, usage limits, an agent-facing MCP interface, and side-by-side model evaluations. I assumed one developer with a few simultaneous local workflows and evaluation trials, not a public service with unrelated users.

Audited source: `5f3717cc10af97fe1fec0a5e5f5728ba20ca5b15`. Scope is all of `packages/rpiv-praxis`, plus the workflow definitions, contracts, session/output handling, scheduling and commit helpers it uses in `rpiv-pi` and `rpiv-workflow`. Tracker: `rpiv-praxis#gpyx`. Fix implementation and verification evidence are recorded at the end of this report.

## Must fix

1. **Resuming can silently approve a rejected human checkpoint** (`packages/rpiv-praxis/claude-host.ts:L511–525,L567`; `packages/rpiv-workflow/sessions/reattach.ts:L46–56`) — `rpiv-praxis#62n6`
   - **What this is:** A checkpoint is a stage that must receive a person's answer before the workflow continues.
   - **Problem:** The host's rejection is kept only in memory. Resume reloads the original transcript and accepts its output without checking that approval happened; the actual runner probe went from failed to completed with one query and zero human answers.
   - **Fix:** Require saved approval evidence before recording checkpoint success, including the resume path that adopts an existing result without another model call. Add a fail-then-resume test that still requires a human answer.
   - **If we skip it:** Resume becomes a way around the human gate, including build's design checkpoint.

2. **A retry can ask a question but still be recorded as complete** (`packages/rpiv-workflow/sessions/extraction.ts:L126–137`; `packages/rpiv-praxis/claude-host.ts:L426–438,L558–567`) — `rpiv-praxis#pv8f`
   - **What this is:** When a stage fails to produce its required document, the runner asks the same session to finish it.
   - **Problem:** After that retry, collection does not recheck whether the session stopped to ask a person. The real workflow engine recorded the research stage as completed after a retry wrote a draft and parked a question. The CLI still returns parked exit 75, but that does not undo the completed-stage record.
   - **Fix:** Check parked, aborted and failed status after every extra turn, before accepting its artifact or writing a completed-stage record. Add this exact parked-retry case to the runner tests.
   - **If we skip it:** Later stages can use an unapproved draft, while its question is stranded against a completed stage.

3. **An eval copy can write back into its original fixture** (`packages/rpiv-praxis/eval.ts:L183–186`) — `rpiv-praxis#5wbs`
   - **What this is:** Evals give each trial a fresh project copy so one trial cannot change another's starting point.
   - **Problem:** The copy preserves symbolic links—files that point to other files—and makes relative targets point into the source fixture. Writing `work/link.txt` changed the original fixture's `real.txt` in the actual `runTrial` probe.
   - **Fix:** Reject symlink-bearing fixtures before running, or materialize permitted targets as independent copies. Test a write through a copied link and assert the source and other trials remain unchanged.
   - **If we skip it:** A trial can damage the fixture and contaminate later comparisons without deliberately writing outside its working directory.

4. **Two resumes can run the same work twice** (`packages/rpiv-praxis/cli.ts:L495`; `packages/rpiv-workflow/runner/runner.ts:L328–376`) — `rpiv-praxis#ymt4`
   - **What this is:** Resume reconstructs a run from its saved log and retries the unfinished stage.
   - **Problem:** There is no per-run exclusion before reconstruction and execution. Two simultaneous calls to the real resume function both ran the same side effect, both succeeded, and appended stage numbers `[1,2,2]`.
   - **Fix:** Acquire an exclusive per-run ownership record before reading and resuming, with release on exit and a clear recovery path for a dead owner. Test simultaneous CLI/API resumes and stale-owner recovery.
   - **If we skip it:** Two agents answering or retrying the same run can duplicate edits or other actions and leave an ambiguous log.

5. **Automatic commit scope can include work that was already dirty** (`packages/rpiv-pi/skills/_shared/git-changes.mjs:L52–58,L96–103`; `packages/rpiv-pi/skills/commit/SKILL.md:L76–80`) — `rpiv-praxis#gd4f`
   - **What this is:** The commit helper separates this run's changes from files that were already changed before it started.
   - **Problem:** `.trim()` removes the first status row's meaningful leading space. A baseline-dirty `package.json` was put in the authoritative in-scope section, not the “do NOT commit” section; reviewed commit instructions trust that section and skip confirmation.
   - **Fix:** Use `.trimEnd()` so Git's status columns stay intact. Add a test where the first row is an unstaged file already present in the baseline.
   - **If we skip it:** An unattended commit can scoop up a developer's unrelated work. The probe established wrong scope; it did not execute a contaminated commit.

6. **An unknown phase write-set does not reliably prevent parallel edits** (`packages/rpiv-pi/extensions/rpiv-core/built-ins/plan-phases.ts:L159–177`) — `rpiv-praxis#yah5`
   - **What this is:** Phase scheduling uses declared file lists to decide which phases can safely run together.
   - **Problem:** A later phase with known files ignores an earlier phase whose files are unknown. A two-phase plan with no file list for phase 1 and `src/shared.ts` for phase 2 was placed in one parallel wave, even though both may edit that file.
   - **Fix:** Make a known-write phase depend on each earlier unknown-write phase as well as each overlapping phase. Test both arrangements of known and unknown file lists.
   - **If we skip it:** Implement or elaborate sessions can race edits and apply/check/revert operations in the same working tree.

7. **An already-exhausted cost cap permits another resumed turn** (`packages/rpiv-praxis/cli.ts:L407,L422–438,L467–470`; `packages/rpiv-praxis/claude-host.ts:L531–537`) — `rpiv-praxis#09ax`
   - **What this is:** Usage limits are meant to include spending from earlier invocations of the run.
   - **Problem:** Caps are checked only after a new usage report. With $1.20 already recorded and `--max-cost 1`, the actual CLI entered resume with its stop flag unset and permitted another turn before stopping.
   - **Fix:** Check the accumulated run budget before dispatch, and the accumulated stage budget before each stage turn. Test an already-exhausted resume; the existing test crosses the limit only after adding new spending.
   - **If we skip it:** Repeated resumes keep spending beyond the same limit. This is not the documented allowance for turns that were already in flight.

8. **Eval crash recovery loses a newly completed result** (`packages/rpiv-praxis/eval.ts:L290–302,L334–336,L369`) — `rpiv-praxis#drky`
   - **What this is:** `eval --continue` reads completed trials and reruns only unfinished ones.
   - **Problem:** The reader skips a partial final line, but the writer appends directly onto that fragment. In the actual two-repeat probe, the first continuation reran one trial, left only one parseable result, and a second continuation reran the same trial again.
   - **Fix:** Safely delimit or remove an unterminated partial tail before appending. Extend the crash test with a second continuation that must execute zero trials and preserve the recorded cost.
   - **If we skip it:** Recovery repeats paid work, overwrites trial directories, and drops spending from the durable comparison.

9. **Eval timeout kills the parent process, not its descendants** (`packages/rpiv-praxis/eval.ts:L394–408`) — `rpiv-praxis#k08y`
   - **What this is:** A timeout sends a polite stop, then force-kills the command 30 seconds later.
   - **Problem:** Both signals target only the directly launched process. In the real local subprocess probe, a grandchild survived the hard-kill deadline and wrote a file afterward; a surviving process retaining the output pipes can keep the trial waiting indefinitely.
   - **Fix:** On the supported Unix environment, launch each command in its own process group and signal the whole group, even if its leader has exited. Test real descendant cleanup and output-pipe closure.
   - **If we skip it:** A supposedly stopped eval can continue modifying files or hang the entire overnight run.

## Should fix

10. **Resume reads messages from abandoned transcript branches** (`packages/rpiv-praxis/transcript.ts:L107–129`; `packages/rpiv-praxis/claude-host.ts:L411–415`) — `rpiv-praxis#sdzq`
    - **What this is:** Saved Claude transcripts can contain alternate histories after rewinding; only the selected history should feed resume and artifact collection.
    - **Problem:** Praxis reads every main-thread message in file order, ignoring parent links. In a divergent transcript probe, the SDK selected three messages while Praxis included four, and collection accepted an artifact named only in the abandoned branch.
    - **Fix:** Use the SDK's selected-branch reader, or reconstruct that parent chain explicitly. Add a divergent-history artifact test.
    - **If we skip it:** A resumed workflow can adopt work the user or model already discarded.

11. **Phase numbers can disagree even when phase counts match** (`packages/rpiv-pi/extensions/rpiv-core/built-ins/plan-phases.ts:L42–76,L196–204`) — `rpiv-praxis#kqkm`
    - **What this is:** The plan's structured phase list tells implementation sessions which body sections to execute.
    - **Problem:** Validation compares counts, not identities. Two titled frontmatter entries both numbered 1, above body phases 1 and 2, produced two `Phase 1` prompts and duplicate `phase-1` identities that the scheduler accepted.
    - **Fix:** Match the ordered body phase numbers against the structured list and reject duplicates before dispatch. Add a same-count, wrong-identity test.
    - **If we skip it:** A malformed generated plan can repeat one phase and omit another instead of stopping for repair.

12. **Forced-exit time disappears from the next timeout budget** (`packages/rpiv-praxis/run-ledger.ts:L184–196`; `packages/rpiv-praxis/cli.ts:L409–418`) — `rpiv-praxis#fzff`
    - **What this is:** The run ledger counts time already used so a resumed run does not receive a fresh full timeout.
    - **Problem:** The exit handler writes a terminal record, but the elapsed-time reader ignores it. An invocation recorded at 00:00 and aborted at 00:02, with no usage/end record, was counted as zero milliseconds.
    - **Fix:** Include terminal timestamps in each invocation's elapsed span, while still excluding idle time between invocations. Test forced exit followed by resume.
    - **If we skip it:** Repeated interrupted runs can exceed their advertised cumulative timeout without the ledger showing it.

## Verification and coverage

- Praxis baseline: `npm test -- packages/rpiv-praxis --maxWorkers=2` — **14 files, 170 tests passed**.
- Workflow runtime and built-in baseline: `npm test -- packages/rpiv-workflow packages/rpiv-pi/extensions/rpiv-core/built-in packages/rpiv-pi/extensions/rpiv-core/built-ins --maxWorkers=2` — **94 files, 3,201 tests passed**.
- TypeScript no-emit and `npm run check:hosts` passed. Existing green tests do not cover the cases above.
- Findings came from executable offline probes using actual exported helpers, the real workflow runner, or real local child processes. Model responses were injected at the SDK boundary; no live Claude requests, production workflows or paid calls were made.
- Separate claim reviewers checked the findings against their callers and existing safeguards. No implementation, installation, deployment, commit or push was performed.
- MCP starts fresh CLI processes, so normal MCP calls do not share the in-process workflow-registration cache between projects. I did not report that suspected cache leak.
- The documented permission-mode choice, normal in-flight cost overshoot, and known no-op commit result were not reported as new defects.
- **Dependency provenance limit:** this worktree's existing `node_modules/@juicesharp/*` workspace links point into `/Users/srvo/dev/rpiv-praxis-9pcc`. Existing-suite results describe that installed dependency graph, not a clean install of this commit. Deterministic host/runner probes used explicit audited-source paths/aliases; direct helper/eval probes imported the audited files. No dependency links were changed.

## Evidence digest

| Case | Observed result |
| --- | --- |
| Unanswered checkpoint, then resume | Initial failed; resume completed; one query, zero human answers |
| Research collection nudge parks | Engine completed, one stage, two turns, park still waiting; CLI separately reports parked exit 75 |
| Copied relative symlink | Original source text changed; copied link points into source |
| Concurrent resume | Two effects, both success, stage numbers `[1,2,2]` |
| Baseline-first unstaged status | Raw ` M package.json`; scoped helper `M package.json`; no pre-existing section |
| Mixed phase write-sets | Both dependency lists empty; one wave `[[0,1]]` |
| Already-exhausted cap | Prior $1.20, cap $1; halt false at entry; another turn allowed; exit 76 |
| Partial eval result tail | First continue executes one; only one parseable result; second continue executes one again |
| Eval process-tree timeout | Parent force-killed at about 30.2 s; grandchild writes at 31 s; close at about 31.45 s |
| Divergent Claude transcript | SDK active messages 3; Praxis messages 4; abandoned artifact accepted |
| Phase identity mismatch | `Phase 1` twice, duplicate `phase-1` IDs accepted |
| Terminal-only elapsed time | Recorded 120 seconds; ledger returns 0 ms |

Verdict: The twelve verified findings have implementation fixes and regression coverage in the current uncommitted worktree; the original reproductions are no longer the working state. See the verification evidence below. Windows process-tree cleanup remains unverified.

Not checked: live Anthropic authentication, actual model adherence, a real contaminated auto-commit, deployment/installed-host identity, Windows process-tree behavior, production gateway cost reporting, Pi↔Claude cross-host resume compatibility, and the unrelated voice/web/UI packages. No lean reduction is claimed: the verified findings are behavior defects, not evidence that a dependency or abstraction can safely be deleted.


## Fix implementation and verification

All twelve findings above have code and regression-test fixes in the current working tree on branch `1f82-fix-praxis-audit` (base `5f3717cc10af97fe1fec0a5e5f5728ba20ca5b15`, fix tracker `rpiv-praxis#1f82`). Their initial probe results above are historical reproduction evidence, not current behavior. The tests for each case were observed failing before the relevant fix and passing afterward.

| Finding | Implemented correction |
| --- | --- |
| `62n6` | Checkpoint resume cold-runs the stage unless the saved-answer path provides approval; persisted unanswered output is not promoted. |
| `pv8f` | Collection rechecks aborted, parked and classified stop outcomes after a retry before accepting its artifact. |
| `5wbs` | Eval copies preserve symlinks and validate the copied links stay within the trial before execution; external/broken links fail the trial. |
| `ymt4` | Resume atomically hard-links a fully written owner record before reconstruction, releases only its matching token, and serializes stale-owner recovery. |
| `gd4f` | Git status parsing preserves the two status columns, including the first row's leading space, and the Claude/Agent exports match the canonical helper. |
| `yah5` | Unknown phase write-sets create dependencies rather than being scheduled as independent work. |
| `09ax` | Accumulated run budget is checked before dispatch and accumulated stage budget before each turn. |
| `drky` | Eval continuation removes an unterminated JSONL tail before appending new results. |
| `k08y` | On Unix, each eval child runs in a process group and timeout signals target the group; Windows descendant cleanup remains unverified. |
| `sdzq` | Transcript adoption reads the SDK-selected message branch, with legacy transcript fallback. |
| `kqkm` | Phase identity validation matches ordered body headings and rejects duplicate/non-sequential body numbering. |
| `fzff` | Terminal timestamps extend each invocation's elapsed span without charging idle time between invocations. |

Fresh verification on the final code changes:

- `npm test -- --maxWorkers=2 --reporter=verbose` — **339 files passed, 7,281 tests passed**.
- `tsc --noEmit -p tsconfig.base.json` — passed.
- `npm run check:hosts`, `check:host-provided-deps`, `check:decision-codes`, and `check:file-sizes` — passed; generated host exports are current.
- Biome check on all changed source, test and generated host files — passed; `git diff --check` — passed.
- No live model calls, paid workflows, production operations, installation, deployment, commit, or push were performed. The changes remain uncommitted and unpushed.
- Independent follow-up review found no remaining blockers. The suite does not pause a process mid-acquisition or force an interleaved symlink swap; owner identity is present atomically at hard-link claim, and copied symlinks are checked before execution.
