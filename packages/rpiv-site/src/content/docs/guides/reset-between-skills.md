---
title: "Continue or reset between skills"
description: "Approve one stage with conversational next, fresh-session /next, or a full manual command."
section: "guides"
order: 2
---

Each skill writes its output to `.rpiv/artifacts/<stage>/`, and the next skill reads it back. That artifact-on-disk handoff supports both continuing in the current conversation and starting with a clean context.

## Continue with `next`

A conversational handoff recommends one default next skill, prints its complete command, and records the absolute working directory. Reply with just `next` to approve that one recommendation. Research and explore default to design; blueprint remains an explicit alternative.

The assistant loads and follows the actual skill with the displayed arguments, artifact path, phase scope, and worktree. It preserves checkpoints and verification gates, then stops at the next handoff. `next` is not permission to run the remaining pipeline or push changes.

If the handoff is missing, ambiguous, stale, blocked, or points at a worktree different from the active task, the assistant asks instead of guessing. Quoted `next` is not approval. Failed validation never offers commit as an actionable next step.

## Replace the session with `/next`

`/next` is a command with stricter checks than conversational `next`. It accepts no arguments. It uses only the latest completed assistant message on the active session branch, never an older handoff or the newest artifact on disk.

The closing footer must give the full skill command, absolute working directory, absolute input artifact, symbolic branch, qualified Kata issue, and the exact marker `Reply /next to run only the step above in a fresh session.` outside code fences and quotes. Older two-field footers need a refresh; the full manual command still works.

Before reset, Pi's tool cwd, process cwd, worktree and branch must match the footer. The saved session must be idle and trusted, with no queued input or running detached lane. Wait for a running lane to finish instead of aborting it. An existing registered Kata issue must be open and ready. Uncommitted changes are allowed; the read-only preflight uses `--allow-dirty` and never creates a worktree or issue. Skills requiring argument/setup expansion need loaded `rpiv-args`.

On success, the new session keeps the same tool cwd and receives a compact handoff plus the exact command, including any `Phase N` argument. The old transcript stays in session history. Normal model/thinking overrides are restored afterward, and later stage recommendations still require new approval.

### Recover without duplicate execution

- Wrong directory: launch Pi in the recorded working directory. An absolute plan path alone does not change where tools run.
- Missing/legacy footer, missing artifact, unavailable check, or blocked issue: correct the condition or request a fresh footer. No reset has occurred.
- Reset veto: the source remains active and retry is permitted once the veto is resolved.
- Startup failure or unknown delivery: resume the source session or inspect the existing target in session history. `/next` refuses automatic replay. Check whether the skill started before using the exact manual command/workdir from the recovery diagnostic.

This describes the source feature, not proof that your installed package has it. Package installation and reload/restart need separate approval and installed-host verification; source tests alone do not establish availability.

## Start a fresh context

A fresh context is still useful when a conversation is large or stage boundaries need stronger isolation. Copy the complete command and working directory from the handoff, run `/new` (or your harness's clear-context command), and invoke the command from that directory.

`next` is conversation-local: it has no persisted pending-stage state and does not recover a prior conversation after `/new`. The artifact is durable; the shortcut is not.

Do not reset within a skill invocation. Interviews, review fanouts, and internal checkpoint loops belong to that skill and retain their own context. Detached `/wf` runs continue to follow their configured session policies; this conversational shortcut does not change workflow routing.

## Implementing a multi-phase plan

For a small plan, an explicit command without a phase executes all phases in one invocation:

```text
/skill:implement .rpiv/artifacts/plans/<plan>.md
```

For larger plans, use one phase at a time:

```text
/skill:implement .rpiv/artifacts/plans/<plan>.md Phase 1
```

A plan handoff recommending `Phase 1` retains that scope when you say `next`; it never silently drops the phase argument. To run a later phase, explicitly select it, optionally in a fresh session:

```text
/skill:implement .rpiv/artifacts/plans/<plan>.md Phase 2
```

The plan's completion markers carry implementation state between sessions. The next recommendation still follows the skill's actual handoff: for example, a completed in-scope implementation hands off to validation rather than automatically starting a sibling phase.

## Next steps

- [Pick your path](/docs/guides/pick-a-path): which chain to run for what you're shipping
- [Handoffs](/docs/guides/handoffs): pause the pipeline and resume it later from a fresh session
- [Walk the chain](/docs/guides/first-skill-chain): the mid-size path demonstrated end-to-end
