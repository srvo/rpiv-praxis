# @ethicalcapital/rpiv-praxis

Ethical Capital's addition to rpiv-mono (not part of upstream). Three things,
all on Claude Code through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk),
no Pi process:

- **`rpiv-wf`** runs rpiv-workflow pipelines (`/wf` in Pi) headless.
- **Steps**: any one skill as a checked, logged, resumable single-stage run.
- **`rpiv-mcp`**: workflows, steps and parked questions as MCP tools, so any
  agent can call them like building blocks and fan out across them.

Built only on upstream's public APIs, so it follows upstream updates without
patches to rpiv-workflow.

Same catalog as Pi's `/wf`: rpiv-pi's built-ins (`build`, `ship`, `vet`,
`polish`, `meta`) plus your user and project overlays (`.rpiv/workflows/`).
Same run state too: runs land in `.rpiv/workflows/runs/`, so a run started here
lists and resumes from Pi and vice versa.

`private: true`, like rpiv-telemetry: it runs from a checkout of this repo.

## Use

```sh
npm install                                   # at the repo root
npm run export:hosts                          # once: renders the rpiv Claude plugin

node packages/rpiv-praxis/bin/rpiv-wf.mjs list
node packages/rpiv-praxis/bin/rpiv-wf.mjs run ship "add a --json flag to the export command"
node packages/rpiv-praxis/bin/rpiv-wf.mjs resume <run-id|name>
node packages/rpiv-praxis/bin/rpiv-wf.mjs inbox
node packages/rpiv-praxis/bin/rpiv-wf.mjs answer <run-id|name> <n> <choice>
node packages/rpiv-praxis/bin/rpiv-wf.mjs steps
node packages/rpiv-praxis/bin/rpiv-wf.mjs step research "how does token refresh work?"
```

| Flag | Default | |
| --- | --- | --- |
| `--name <name>` | workflow name | name the run; resume it by name |
| `--model <id>` | Claude Code's | model for every stage (`claude-opus-5-5`, `sonnet`, `anthropic/…`) |
| `--concurrency <n>` | `4` | parallel fan-out units |
| `--permission-mode <mode>` | `auto` | Claude Code permission mode for each stage |
| `--plugin-dir <dir>` | `rpiv-pi/hosts/claude` | the rpiv Claude plugin |
| `--cwd <dir>` | current directory | project to run in |

Exit codes: `0` completed, `1` failed, `2` usage error, `75` parked (a stage is
waiting on an answer), `130` interrupted (Ctrl-C stops the run at the current
stage; resume picks it up).

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

Authentication is Claude Code's own: whatever `claude` uses on the machine.

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
{ "mcpServers": { "rpiv": { "command": "node", "args": ["/path/to/rpiv-mono/packages/rpiv-praxis/bin/rpiv-mcp.mjs"] } } }
```

| Tool | Does |
| --- | --- |
| `list_workflows` | workflows in the project (built-ins + packs) |
| `list_steps` | skills `run_step` can run, with source and kind |
| `run_workflow` | start a workflow in the background; returns a run name |
| `run_step` | start one skill as a checked step in the background; returns a run name |
| `run_status` | `running` / `completed` / `failed` / `parked` / `interrupted`, stages, waiting question, log tail |
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
