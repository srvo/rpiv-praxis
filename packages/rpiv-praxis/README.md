# @ethicalcapital/rpiv-praxis

Ethical Capital's addition to rpiv-mono (not part of upstream). Three things,
all on Claude Code through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk),
no Pi process:

- **`rpiv-wf`** runs rpiv-workflow pipelines (`/wf` in Pi) headless.
- **Steps**: any one skill as a checked, logged, resumable single-stage run.
- **`rpiv-mcp`**: workflows, steps and parked questions as MCP tools, so any
  agent can call them like building blocks and fan out across them.
- **Evals**: `rpiv-wf eval` runs one workflow across variants (model, effort,
  tools, memory) and compares outcome, checks, cost and tokens.

Built only on upstream's public APIs, so it follows upstream updates without
patches to rpiv-workflow.

Same catalog as Pi's `/wf`: rpiv-pi's built-ins (`build`, `ship`, `vet`,
`polish`, `meta`) plus your user and project overlays (`.rpiv/workflows/`).
Same run state too: runs land in `.rpiv/workflows/runs/`, so a run started here
lists and resumes from Pi and vice versa.

## Install just praxis

Not on npm (`private: true`): it needs this fork's rpiv-pi, which carries the
Claude plugin and the Pi-free seams praxis imports. Install from a checkout;
the other packages' dependencies are skipped.

```sh
git clone https://github.com/ethicalcapital/rpiv-mono && cd rpiv-mono
npm install --workspace @ethicalcapital/rpiv-praxis --ignore-scripts
npm install -g ./packages/rpiv-praxis --ignore-scripts   # optional: rpiv-wf and rpiv-mcp on PATH
rpiv-wf --help
```

`--ignore-scripts` skips the root `prepare` hook (husky, a dev dependency a
workspace-only install leaves out); praxis needs no install scripts. The
global install links to the checkout, so `git pull` updates it. The rpiv
Claude plugin (`packages/rpiv-pi/hosts/claude`) is committed; there is no build
step. Authentication is Claude Code's own: whatever `claude` uses on the
machine (`claude login`, or `ANTHROPIC_API_KEY`). Verified from a fresh clone:
both commands install, and `rpiv-wf list`, `rpiv-wf steps` and an `rpiv-mcp`
handshake work from any directory.

## Use

```sh
rpiv-wf list                                          # workflows (in the current project)
rpiv-wf run ship "add a --json flag to the export command"
rpiv-wf resume <run-id|name>
rpiv-wf inbox                                         # questions runs are waiting on
rpiv-wf answer <run-id|name> <n> <choice>
rpiv-wf steps                                         # skills that run as single steps
rpiv-wf step research "how does token refresh work?"
```

Without the global install, `rpiv-wf` is
`node <checkout>/packages/rpiv-praxis/bin/rpiv-wf.mjs`.

| Flag | Default | |
| --- | --- | --- |
| `--name <name>` | workflow name | name the run; resume it by name |
| `--model <id>` | Claude Code's | default model for every stage (`haiku`, `sonnet`, `claude-opus-5-5`, …); a pack's `models.stages` pin overrides it |
| `--concurrency <n>` | `4` | parallel fan-out units |
| `--permission-mode <mode>` | `auto` | Claude Code permission mode for each stage |
| `--plugin-dir <dir>` | `rpiv-pi/hosts/claude` | the rpiv Claude plugin |
| `--cwd <dir>` | current directory | project to run in |
| `--effort <level>` | Claude Code's | `low` … `max` for every stage |
| `--tools <a,b>` | all | built-in tools stages may use (`none` = no built-ins) |
| `--disallowed-tools <a,b>` | none | tools removed from every stage |
| `--setting-sources <a,b>` | `user,project,local` | what loads, CLAUDE.md included (`none` = nothing) |
| `--max-cost <usd>` | none | stop once the run has cost this much, across resumes |
| `--timeout <minutes>` | none | stop once the run has run this long, across resumes |
| `--stage-max-cost <usd>` | none | stop once any one stage has cost this much |
| `--stage-max-tokens <n>` | none | stop once any one stage has used this many tokens |

| Exit | Means | Next |
| --- | --- | --- |
| `0` | completed | |
| `1` | failed (a stage or gate failed) | read the log; `resume` retries the failed stage |
| `2` | usage error | |
| `75` | parked: a stage is waiting on an answer | `inbox`, then `answer` |
| `76` | stopped at a cost or token cap | `resume` |
| `124` | stopped at `--timeout` | `resume` |
| `130` | interrupted (Ctrl-C / SIGTERM) | `resume` |

A stop (76, 124, 130) ends the current stage cleanly and the run resumes from
it. `RPIV_WF_METRICS_FILE=<path>` makes `rpiv-wf` write the outcome, cost,
tokens and tool calls as JSON at exit.

## Overnight and unattended runs

Everything a long run needs is in place: hard caps, exit codes a script can
branch on, questions that wait instead of blocking, resume after any stop, and
evals that survive a crash. What to set:

- **Permissions.** The default `auto` mode lets Claude Code's classifier decide;
  anything it would ask a person about is denied, and that stage may fail.
  For a run nobody watches, use `--permission-mode bypassPermissions` **in a
  disposable checkout, container or VM**: stages then run any tool without
  asking. Questions still park (exit 75); they never hang. The SDK prints a
  `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning in this mode; it is expected
  (the callback still sees `AskUserQuestion`, which is all parking needs).
- **Caps.** Every stage turn appends a `usage` row (tokens always; cost only
  when the SDK reports one, never an invented price) to the run's JSONL, and
  each invocation appends an `invocation` row (`run`, `resumed`, `end`). So
  `--max-cost`, `--timeout` and the per-stage caps count what earlier
  invocations of the run spent. Through a gateway the SDK reports no cost;
  `--max-cost` then warns that it cannot be enforced, and the token caps are
  the ones that bind. At the cost cap, turns already
  running finish and their work is kept; no new turn starts. A run therefore
  ends somewhat over its cap, by what was in flight, and if that was its last
  stage it completes (exit 0). The timeout cuts running turns off; the
  interrupted stage reruns on resume.
- **Cheap models.** `--model haiku` for every stage; the memory-demo eval had
  Haiku at about a sixth of Sonnet's cost. Other providers through an
  Anthropic-compatible endpoint (a variant `env` of `ANTHROPIC_BASE_URL` and
  `ANTHROPIC_AUTH_TOKEN`, which Claude Code honours) should work but are
  **not verified** here; try one trial with `--max-cost` first.
- **Per-stage models.** A pack sets them on the workflow:
  `models: { stages: { plan: "haiku", synthesize: "opus" }, escalate: { ladder: ["haiku", "sonnet", "opus"] } }`.
  With a ladder, a producer whose verify/assess verdict failed retries one
  step up per failed round; each step is a `model-escalation` row in the run
  log. A grade → fix back-edge (build's `plan-fix`, `code-fix`) escalates
  through `escalate.revisits: ["plan-fix", "code-fix"]`: the first fix runs on
  the stage's pin, each repeat lap one step up. Ids compare as exact strings,
  so write pins and ladder the same way.
- **Detach it.** `tmux`, or `nohup rpiv-wf … > night.log 2>&1 &`. Progress
  goes to stderr; the run log in `.rpiv/workflows/runs/` is the record.
- **Morning.** `rpiv-wf inbox` for parked questions; failed and stopped runs
  resume by name.

**For a night of evals** (the usual way to see how far cheap models get):

```json
{
  "name": "nightly-ship",
  "fixture": "fixture",
  "workflow": "ship",
  "input": "add a --json flag to the export command",
  "repeats": 5,
  "parallel": 2,
  "timeoutMinutes": 45,
  "budgetUsd": 40,
  "defaults": { "permissionMode": "bypassPermissions", "maxCostUsd": 4, "answers": ["1"] },
  "variants": [{ "name": "haiku", "model": "haiku" }, { "name": "sonnet", "model": "sonnet" }],
  "checks": [{ "name": "tests pass", "run": "npm test" }]
}
```

```sh
rpiv-wf eval nightly.json --dry-run          # the matrix, no spend
nohup rpiv-wf eval nightly.json > eval.log 2>&1 &
rpiv-wf eval --continue <results dir>        # after a crash, reboot or Ctrl-C
```

Each trial is recorded to `results.jsonl` as it finishes, so a crash loses at
most the trials in flight; `--continue` runs only what is missing, against the
spec saved with the results. `budgetUsd` stops *starting* trials once the eval
has spent that much (exit 3); trials in flight finish. Each trial has its own
`--timeout`; a trial still running 2 minutes past it gets SIGINT, then SIGKILL
30 seconds later.
A trial that parks with no scripted answer left ends as `parked` and counts
as incomplete; `answers` (`"1"` = the first option) keeps a night moving.
Trials run with `RPIV_WF_KATA=off`, so an eval never files tickets.

Known limits: the cost a reattached stage spent before a failed run is
counted again when `resume` reattaches it (reporting only; nothing is charged
twice). A rate limit or usage cap from Anthropic fails the stage like any
other error (expected from how errors are handled; not tested against a real
limit); the run resumes once the limit lifts.

## Parked questions (human in the loop)

A stage that needs a person does not guess. When a skill calls
`AskUserQuestion`, the run **parks**:

1. The question and its options are saved beside the run log, in
   `.rpiv/workflows/runs/<run-id>.parked.json`. The run log itself keeps
   upstream's format.
2. If `kata` is on PATH, a ticket is filed and labelled `rpiv-parked`, with the
   answer command in its body. Not `human` or `decision`: monocloud's hourly
   producer copies those two labels into `activity.timeline`, and parked
   questions stay out of the database for now. `RPIV_WF_KATA=off` disables it;
   any kata failure is a warning, never a stop.
3. The run stops cleanly and `rpiv-wf` exits `75`.

`rpiv-wf inbox` lists every waiting question in the project, oldest first.
`rpiv-wf answer <run> <n> <choice>` takes an option number, a label, or free
text; it records the answer, closes the kata ticket, and resumes the run
(`--no-resume` to only record). The parked stage reopens **its own session**
and receives the answer, so the work it did before asking is kept.

Run in passes: start or resume several runs, let each go until it finishes or
parks, then work through the inbox.

Limits: one question is answered per park (a multi-question AskUserQuestion
takes one free-text answer covering all of them); a park stops the whole run,
so fan-out units still in flight are re-run on resume; parking needs the
Claude Code host (Pi has its own in-session parking in the lane console).

## Steps: one skill, full guarantees

`rpiv-wf step <skill> [args]` runs a single skill as a one-stage workflow
named `step-<skill>`. It gets everything a full run gets: the skill's output is
checked against its `contract:` (a `research` step must produce a research
artifact), the run is logged in `.rpiv/workflows/runs/`, a question parks it,
and `resume`/`answer` pick it up. `rpiv-wf steps` lists what can run: rpiv's
skills, then your project's `.claude/skills` and your `~/.claude/skills`.

A step workflow is registered only in the process that runs or resumes that
step, never for `run` or `list`: the runner refuses to start while any
workflow in the catalog has a load error, so a step can never break an
ordinary run. Every rpiv skill is tested to load cleanly as a step.

## MCP tools: rpiv as building blocks for any agent

`rpiv-mcp` is a stdio MCP server. Add it to Claude Code's `.mcp.json` (or any
MCP client's config):

```json
{ "mcpServers": { "rpiv": { "command": "rpiv-mcp" } } }
```

(without the global install: `"command": "node", "args": ["<checkout>/packages/rpiv-praxis/bin/rpiv-mcp.mjs"]`).

| Tool | Does |
| --- | --- |
| `list_workflows` | workflows in the project (built-ins + packs) |
| `list_steps` | skills `run_step` can run, with source and kind |
| `run_workflow` | start a workflow in the background; returns a run name |
| `run_step` | start one skill as a checked step in the background; returns a run name |
| `run_status` | `running` / `completed` / `failed` / `parked` / `stopped-budget` / `stopped-timeout` / `interrupted`, stages, waiting question, log tail |
| `inbox` | questions parked runs are waiting on |
| `answer` | answer a parked question and resume its run (`resume: false` only records) |

Every run tool takes `cwd`, `name`, `model`, `permission_mode`, `concurrency`.
Long work never blocks the agent: `run_*` and `answer` start `rpiv-wf` as a
detached process and return at once; the agent polls `run_status`. The server
is a thin layer over the same CLI people use, so a run behaves the same
whoever started it. Detached runs log to `.rpiv/workflows/runs/<name>.mcp.log`.

Verified live: a headless Claude Code agent given this server started a step
in two projects in parallel, polled both, and reported both completed; over
the raw protocol, a step parked, `inbox` showed it, `answer` resumed it, and
`run_status` reported it completed.

## Evals: compare models, tools and memory on the same workflow

```sh
rpiv-wf eval packages/rpiv-praxis/evals/memory-demo/spec.json --dry-run   # the matrix, no spend
rpiv-wf eval packages/rpiv-praxis/evals/memory-demo/spec.json
```

A spec names one workflow (or one step), a fixture directory, and variants.
Every trial runs `rpiv-wf` as its own process in a **fresh copy of the
fixture**, so trials cannot leak into each other, and `checks` grade the
result. Output lands in `eval-results/<name>-<time>/` next to the spec:
`results.jsonl` (one row per trial), `summary.md` (variants side by side), and
`trials/<variant>__<n>/` (the working copy, the log, per-invocation metrics).

| Spec field | |
| --- | --- |
| `name`, `fixture` | eval name; directory copied fresh per trial (relative to the spec) |
| `workflow` *or* `step`, `input` | what runs |
| `repeats`, `parallel`, `timeoutMinutes` | trials per variant (default 1); concurrent trials (default 1); per-invocation timeout (default 30) |
| `budgetUsd` | stop starting trials once the eval has spent this (exit 3) |
| `defaults` | variant fields applied under every variant |
| `variants[]` | `name` plus any of: `model`, `effort`, `permissionMode`, `tools` (list or `"none"`), `disallowedTools`, `settingSources` (`user`/`project`/`local` or `"none"`), `concurrency`, `env`, `setup` (shell, run in the copy first), `answers`, `maxCostUsd` (per invocation) |
| `answers` | a scripted person: a trial that parks is answered with these, in order, and resumed |
| `checks[]` | `{ name, run }` — shell in the copy after the run; exit 0 = pass |

**What "memory" means here.** `settingSources` controls what Claude Code
loads: `CLAUDE.md` and `.claude/settings` (`project`), your user settings and
`~/.claude/CLAUDE.md` (`user`), local overrides (`local`); `"none"` loads
none of it. Other memory is set up per variant with `setup` and `env`: delete
`.rpiv/lessons` (meta's carried-forward lessons), add a `CLAUDE.md`, point an
env var at a different memory store. Note `"none"` also stops loading the
project's own skills from `.claude/skills`; rpiv's skills still load from the
plugin.

**Cost is per turn, not cumulative.** The SDK reports a resumed session's cost
cumulatively (measured: $0.021 → $0.051 → $0.074 over three resumed calls),
so the host charges each turn only the difference, and a parked question
saves its session's total so the resumed turns start from it. Verified live:
a trial that parked, was answered from `answers` and resumed was charged the
parked session's $0.0610 once.

`evals/memory-demo/` is a working example: does the model follow an instruction
that exists only in `CLAUDE.md`? First run (one trial each, so a lead, not a
result): with memory, Sonnet and Haiku both followed it; without it, Sonnet did
not; Haiku cost about a sixth of Sonnet.

## How it maps

rpiv-workflow's runner is host-agnostic: every stage goes through one port,
`WorkflowHostContext.spawnChild`. rpiv-pi implements it over Pi's
`AgentSession`; this package implements it over the Agent SDK.

| Runner asks for | Claude Code does |
| --- | --- |
| a fresh stage session | a new session, first turn `query({ prompt })` |
| a re-prompt (validation retry) | `query({ resume: <session id> })` |
| reattach (resume a failed stage) | `resume` the stage's persisted session in place |
| fork (`sessionPolicy: "continue"`) | `forkSession()` into a new id that inherits the transcript |
| the stage's transcript | main-thread assistant frames; the SDK `result` sets the stop reason |
| `/skill:<name>` | `/rpiv:<name>` for rpiv's skills, `/<name>` for project/user skills |
| skill-registration preflight | the plugin's skills plus `.claude/skills` and `~/.claude/skills` |

At startup it registers what rpiv-pi registers inside Pi: the built-in
workflows, skill contracts from `contract:` frontmatter, and the outcome deriver
(`rpiv-support.ts`). Those modules are Pi-free.

## Differences from Pi

- **Headless, with parking.** There is no live UI; a question parks the run
  (above) instead of being answered in place. Built-in commit stages skip their
  confirmation when the change already cleared review (`--reviewed`).
- **Permissions.** The host installs a permission callback to catch
  `AskUserQuestion`; every other tool that reaches it is denied, exactly as an
  unattended run with no callback would deny it.
- **Anthropic models only.** A Pi model key for another provider fails that
  stage rather than silently running a different model. `models.json` per-stage
  routing is not read.
- **No lane console.** Progress prints to stderr.
- **Launched from inside Claude Code** (an agent's Bash tool, a cloud session),
  the launcher's `CLAUDE_CODE_SESSION_ID` is stripped from each stage's
  environment. Inherited, it made every stage resume the launcher's own session.
