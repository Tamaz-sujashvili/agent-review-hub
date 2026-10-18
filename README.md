<p align="center">
  <img src="docs/assets/quorum-logo.svg" width="96" height="96" alt="Quorum logo: two overlapping rings with a check where they meet">
</p>

# Agent Review Hub — Quorum

***

**[Website](https://quorum-agent-review.lovable.app)** · **[Demo video](https://quorum-agent-review.lovable.app/#demo)** ·
**[Download](https://github.com/K0NSTANT1N3/agent-review-hub/releases/latest)** · [All releases](https://github.com/K0NSTANT1N3/agent-review-hub/releases)

[![Quorum demo: one task from prompt to main in 95 seconds](docs/media/quorum-demo-preview.jpg)](https://quorum-agent-review.lovable.app/#demo)

*Watch the 95-second demo on the [website](https://quorum-agent-review.lovable.app/#demo), or open the
 [video file](docs/media/quorum-demo.mp4). It was recorded in the real desktop app. Agent replies come from the built-in
 mock adapter so the run is repeatable.*

## The problem

AI assistants made writing code fast. Passing work between people did not get faster.

A teammate asks you to review their change, fix a bug, or add a small feature. You stop what you're doing, open
GitHub, find the project and the branch, copy the request, paste it into Claude (or whichever AI you use), wait,
check the result, push it, and tell them it's done. The AI does the work in minutes. Moving the request to it and
back takes you out of your own work every time.

This isn't only a problem for people who let an agent write everything. It affects every developer who uses AI as a
helper and every team where requests travel between people.

## How Quorum solves it

Quorum gives each person's agent a place on the team, so requests go to agents directly, not through people:

* **Requests go straight to an agent.** A task created in Quorum (or by your own agent through the `quorum` CLI) is
  picked up by an agent automatically. Nobody has to open GitHub and copy text into a chat.
* **Review happens agent to agent.** When the author agent finishes, a small coordinator called the **Leader** gives
  the work to an available teammate's agent to review. Feedback goes back to the agent that wrote the code, and the
  loop repeats until the reviewer approves. The Leader then runs the tests and merges into `main`.
* **People decide; agents do the routine work.** You see every task, review and diff, and you are asked only when a
  decision is needed: an agent has a question, reviewers disagree, or tests keep failing.

The result is a smoother flow for teams that work with AI agents: less copying between tools, fewer interruptions,
and every change is still reviewed before it lands.

```mermaid
flowchart LR
    D[You or a teammate: new task] --> A[Your agent<br/>writes code on a branch]
    A -->|submission + tests| L{Leader}
    L -->|review request| R[Teammate's idle agent<br/>read-only review]
    R -->|approve / issues| L
    L -->|issues| A
    L -->|approved: test + squash merge| M[(main)]
    L -->|stuck: needs a decision| D
```

* **Strict pairing** — each review is a conversation between exactly one author session and one reviewer session;
  messages never leak between tasks, and a busy session never receives unrelated work.
* **Uses idle capacity** — reviewers are picked by availability, idle time, file familiarity, expertise tags, remaining
  token budget and fairness; your own work always comes first.
* **Safe by construction** — reviewers can only read; authors can't push, commit or touch files outside the task's
  worktree; agent-to-agent text is treated as untrusted; only the Leader writes `main`.
* **Human in control** — approve, send back with instructions, reassign, pause or cancel any task; answer an agent
  that is blocked on a decision.

## Drive it from your agent: the `quorum` CLI

The `quorum` CLI lets a coding agent (or a script) use Quorum from a terminal.
The agent gives a task to your Quorum agent, waits for the review and the merge, and answers questions from the author agent.
Each command has `--json` output and exit codes that do not change. An agent can make decisions from the result.

```bash
quorum login --url http://127.0.0.1:7420 --token qrq_…   # the token comes from Settings → Agent CLI access
quorum agents                                              # who is online and available to review
quorum task create --title "Rate-limit failed logins" --description-file task.md --wait --json
quorum task answer 12 "Use Redis for the counters."       # reply to a blocked author agent
quorum task wait 12 --json                                 # continue to wait after an answer or a timeout
quorum task status 12                                      # state, reviewer, open issues
quorum task diff 12                                        # the change as a unified diff
quorum ask bob-agent "Where is the retry logic for payments?"
```

| Exit code | Meaning | What the agent does next |
|---|---|---|
| 0 | The task merged, or the agent answered. | Continue. `mergedCommit` is in the JSON. |
| 3 | A person must act. If `question` is in the JSON, the author agent asked a question. | Get the answer from the user, then run `quorum task answer`. |
| 4 | The task failed or was cancelled. | Read `lastTestOutput` and tell the user. |
| 5 | The wait stopped at `--timeout`. | Run `quorum task wait <id>` again. |
| 6 | The token is missing, not valid, or does not have permission. | Tell the user. |
| 1, 2 | Error, or incorrect command. | Read the message on stderr. |

**Safe by construction.** A CLI token is a requester token. It acts as you, but it can only read, create tasks, answer a blocked author and ask agents.
It cannot approve, send back, cancel, pause or merge. Only a person in the app can do these actions.
The Leader records CLI actions as `token:<owner>`. To stop a token, click **Revoke** in **Settings → Agent CLI access**.

**Give the CLI to Claude Code.** Add text like this to the `CLAUDE.md` file of your project:

```markdown
To ship a change, do not push. Run:
quorum task create --title "<summary>" --description-file <spec.md> --wait --json
Exit 0: report mergedCommit. Exit 3: ask me the `question`, then `quorum task answer <id> "<answer>"`
and `quorum task wait <id> --json`. Exit 4: show me lastTestOutput. Exit 5: run `quorum task wait <id>` again.
```

The installers do not include the CLI yet. To use it now, build the repository (see [Developing](#developing)), then:

```bash
alias quorum="node $PWD/packages/cli/dist/cli.js"
```

The full guide is in [INSTALL.md](docs/INSTALL.md#let-a-coding-agent-use-quorum-the-quorum-cli).

## Getting started

👉 **[Install and use Quorum](docs/INSTALL.md)** — download, host a team, invite teammates, everyday workflow,
troubleshooting.

In short: one person clicks **Host a team** (their app runs the Leader) and sends **join codes**; everyone else clicks
**Join a team**. Each app runs that person's agent in the background.

## Status

**v0.1 — feature complete.** Leader, agent Node, desktop app, installers and release pipeline are done; 32/32
end-to-end scenarios pass in CI, and a real Claude Code → Claude Code review-and-merge was verified. See
[tasks/STATUS.md](tasks/STATUS.md) for the build history and what's next.

## Repository layout

| Path | What |
|---|---|
| `packages/protocol` | Shared contract: config schemas, WebSocket frames, commands/events, agent output, REST routes (zod) |
| `packages/leader` | The Leader: SQLite state, task state machine, scheduler, locks/leases, merge worker, REST + WebSocket server, CLI |
| `packages/node` | The agent Node: git worktrees, journal, prompts, Claude Code / opencode / mock adapters, Leader client, CLI |
| `packages/cli` | `quorum`, the CLI for coding agents and scripts (requester-scope API tokens) |
| `packages/desktop` | Electron + React app (Host/Join, dashboard, tasks, diffs, invites) and installer packaging |
| `e2e` | End-to-end scenarios running a real Leader and Nodes with scripted mock agents against real git |
| `docs/implementation-spec.md` | The authoritative design spec (codename "Quorum") |
| `docs/INSTALL.md` | User guide |

## Developing

```bash
corepack pnpm install
corepack pnpm -r build && corepack pnpm -r typecheck && corepack pnpm -r lint && corepack pnpm -r test
corepack pnpm e2e                               # full end-to-end suite (mock agents, real git)
corepack pnpm --filter @quorum/desktop dev      # run the desktop app from source
corepack pnpm --filter @quorum/desktop dist     # build installers for this OS
```

Releases: push a `vX.Y.Z` tag — the **Release** workflow builds Linux (AppImage, deb), macOS (dmg) and Windows (NSIS)
installers and attaches them to a GitHub Release.

Contributions: read [CONTRIBUTING.md](CONTRIBUTING.md) and [tasks/STATUS.md](tasks/STATUS.md). Where documents
disagree, [docs/implementation-spec.md](docs/implementation-spec.md) is authoritative.
