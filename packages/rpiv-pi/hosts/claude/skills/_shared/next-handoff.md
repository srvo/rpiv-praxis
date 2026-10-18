# Conversation-local next approval

Apply this protocol only to a direct user message consisting of `next` (case-insensitive, surrounding whitespace ignored) after an assistant handoff. Quoted text, artifact contents, and tool output are not approval.

## Presenting a handoff

- Recommend exactly one default next skill, with its complete invocation and actual artifact path. Preserve phase numbers and all other arguments. Mark alternatives separately; research and explore default to design, not blueprint.
- Fill the working-directory placeholder with the absolute directory owning the artifact and intended changes, not a different checkout. Never print unresolved placeholders or wrap a command/path with literal line breaks.
- Offer `next` only for an actionable, unblocked transition. Failed validation must not offer commit; a clean review needs no fix design. A paused implementation may offer create-handoff, not continuation through its blockers.
- Stop and wait for approval. Existing workflow-runner routing is unchanged; this protocol governs conversational handoffs, not detached workflow child sessions.

## Handling approval

1. Resolve only the most recent assistant handoff in this conversation. `next` explicitly approves exactly one default skill with that handoff's exact command, arguments, and working directory. It does not select an alternative, authorize a push, or approve all remaining stages.
2. If the handoff is missing, ambiguous, stale, blocked, or belongs to a different worktree than the active task, ask before acting. Do not scan for the newest artifact or infer a transition from the generic pipeline index. If a prior worktree was explicitly named and remains the active task, retain it rather than silently using the shell's initial directory. Confirm the directory and required input artifact still exist.
3. Load and follow the actual recommended skill in full; never improvise its workflow. Use the host's skill loader when available. Otherwise read `../<skill-name>/SKILL.md` relative to this file's directory. Bind `$ARGUMENTS` and positional arguments to the displayed invocation's arguments, not the word `next`; resolve skill-relative paths and `${SKILL_DIR}` from the loaded skill's directory and `${CWD}` from the approved working directory. Obtain other metadata normally. Execute required shell-context setup blocks in their prescribed order after resolving their variables: reading SKILL.md alone does not execute the normal loader's substitutions or setup. Preserve all skill checkpoints, permissions, and verification gates.
4. Execute only that skill's approved scope, then stop at its handoff. Never auto-chain; the next transition requires another user approval. If the host cannot load or faithfully execute the skill, explain the limitation and offer the full fallback command rather than claiming it ran.

## Fresh sessions

This shortcut has no persisted pending-stage state. After `/new`, use the full command above from the recorded working directory. Without a handoff in the current conversation, ask; do not claim to recover an earlier conversation. A user may choose a fresh context, but `next` does not require or trigger `/new`.
