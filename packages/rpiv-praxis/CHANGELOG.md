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
- Evals: `rpiv-wf eval <spec.json> [--dry-run] [--out <dir>]` runs a workflow or step across variants in fresh fixture copies, answers parks from a script, runs checks, and writes `results.jsonl` and `summary.md`. Example: `evals/memory-demo/`.
- `rpiv-wf` flags `--effort`, `--tools`, `--disallowed-tools`, `--setting-sources`; `$RPIV_WF_METRICS_FILE` receives the run's outcome and usage at exit.
- Unattended runs: `--max-cost <usd>` (exit `76`; turns in flight finish and are kept, no new turn starts) and `--timeout <minutes>` (exit `124`), both resumable. Evals gain `budgetUsd` (stop starting trials, exit `3`), per-variant `maxCostUsd`, a per-trial timeout with a SIGINT→SIGKILL backstop, `--continue <results dir>` to finish an interrupted eval against its saved spec, and Ctrl-C that leaves interrupted trials unrecorded for `--continue` (exit `130`). `rpiv-mcp`'s `run_status` reports `stopped-budget` and `stopped-timeout`.
- `rpiv-wf --help` (`-h`, `help`) prints usage, including exit codes, and exits 0.
- README: installing praxis alone from a checkout, a flags and exit-code reference, and a guide to overnight runs.
- Usage is reported per turn: the SDK's cumulative totals for resumed and forked sessions are turned into differences, and a parked session's total is saved so its resumed turns start from it.
