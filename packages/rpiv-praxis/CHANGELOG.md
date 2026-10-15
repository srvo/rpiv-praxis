# Changelog

All notable changes to `@ethicalcapital/rpiv-praxis` (formerly `rpiv-claude`) are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `rpiv-wf` runs rpiv-workflow pipelines headless on Claude Code through the Claude Agent SDK: `list`, `run`, `resume`. Implements the runner's executor port (fresh, re-prompt, reattach, fork) over Agent SDK sessions, routes `/skill:` to the rpiv plugin or Claude Code's own skills, and registers rpiv-pi's built-ins, skill contracts and outcome deriver without Pi.
- `rpiv-wf list` prints workflow load issues to stderr and exits 1 when any is an error, instead of silently omitting a broken pack.
- Parked questions: a stage that calls `AskUserQuestion` parks the run (exit `75`) instead of guessing. The question is saved to `.rpiv/workflows/runs/<run-id>.parked.json`; `rpiv-wf inbox` lists open questions and `rpiv-wf answer <run> <n> <choice>` resumes the stage in its own session with the answer. When `kata` is on PATH a ticket labelled `rpiv-parked` is filed and closed on answer (`RPIV_WF_KATA=off` disables it). The permission callback that catches the question denies every other tool, as an unattended run already would.
- Steps: `rpiv-wf step <skill> [args]` runs one skill as a single-stage workflow (`step-<skill>`) with contract-checked output, a run log, parking and resume; `rpiv-wf steps` lists runnable skills. Step workflows are registered only in the process that runs or resumes them, so they can never block an ordinary run.
- `rpiv-mcp`: an MCP stdio server with `list_workflows`, `list_steps`, `run_workflow`, `run_step`, `run_status`, `inbox`, `answer`. Run tools start `rpiv-wf` detached and return a name to poll.
- Renamed from `rpiv-claude` to `@ethicalcapital/rpiv-praxis`.
