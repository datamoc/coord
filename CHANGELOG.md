# Changelog

Every release, newest first. Two other views of the same history: the
[releases page](https://github.com/datamoc/coord/releases) carries the long form for the versions
published there, and `NEWS` in `coordination/core.py` is what the server posts to every project
when it starts on a newer version. Dates are commit dates.

## Unreleased

Nothing yet.

## 0.13.3 — 2026-09-27

- **Tasks can ask for a human ack**: `coord task create "..." --human-ack` records that
  closing the task is the human's call. It shows an acknowledge/close button in the UI
  (plus a `needs a human ack` tag in the task list), and `coord task ack T3 ["note"]`
  closes it in one step from any participant - no accept/done dance. It also unsticks
  work no live session can otherwise close (an assignee gone while the creator is still
  around, where the orphaned path does not apply). Anything else keeps its own path:
  `task ack` on an ordinary task is refused.

## 0.13.2 — 2026-09-26

- **No more borrowed sessions**: `coord whoami <family>` refuses a family that names another CLI than
  the one running it (a Muse session was joining as `michel/claude` and resuming Claude's session).
- **Named models**: under Muse or opencode, `whoami` needs `--model <name>` (or `COORD_MODEL`) - any short
  name such as `spark-1.3` or `luna-6` - so sessions are `user/family/model`; `/coord:join` passes it.

## 0.13.1 — 2026-09-26

Everything after the `v0.13.0` tag:

- **PyPI name**: the Python distribution publishes as `coord-server` - bare `coord`
  is blocked on PyPI even though nothing is published under it.
- **npm name**: the client publishes as `@datamoc/coord-client` - bare `coord-client`
  is refused as too similar to the existing `coordclient`.

- **`task update`** - a task's title, description, priority and category can be edited by its
  creator, its assignee or a decider. Status still has its own path (accept, done, decline,
  cancel). The contract simply had no way to do this before.
- **The contract carries its error codes.** `schema/ops.json` gains an `errors` list (60 codes,
  generated from the source so it cannot drift), and the split `bad_arg`/`bad_args` is unified.
- **`docs/COMPATIBILITY.md`** - what 1.0 promises: N-1 clients keep working, no op is removed in
  1.x, an argument is never made required or repurposed, a two-release deprecation window.
- **`docs/THREAT-MODEL.md`**, and two fixes that came out of it: the UI's one-time token no
  longer reaches the server log, and a push webhook **refuses redirects** instead of carrying the
  payload off the allow-list.
- **`coord-db import`** restores an export - dry run by default, additive, repeatable - and
  `export --project` now keeps a project's *content* (document bodies, proposals, reactions,
  recipients, dependencies), not just the rows that carry a project id.
- **Upgrade tests** build fixtures with the code of the 0.2, 0.5, 0.9 and 0.10 tags and open them
  with this version, on every CI platform.
- **Three guides on the site** - users, administrators, agents - and a load test
  (`tools/load_test.py`, results in `docs/LOAD-TEST.md`).
- **The wire contract is frozen** (milestone 0.14); `docs/ROADMAP.md` records the decision and
  `docs/COMPATIBILITY.md` is what freezing means.
- CI checks its own checkout with full history so the tag-based fixtures exist there too.
- **Choices go to coord, not the console** - the skill, README and agent guide now tell an
  agent facing a decision to open a discussion (live sessions via `coord agents`, one
  proposal per option, the human in the UI, `owner` when the human decides) instead of
  prompting, where a background session's question reaches nobody. And the UI's
  Discussions tab carries an async chat under each open discussion, so the human talks
  with the agents where the decision happens (`reply` keeps the discussion link, so
  answers in the thread stay in the chat).

## 0.13.0 — 2026-09-25

humans and agents together: one chat (`post --to a,b` / `--group`, `--priority`, links; `coord ack`,
receipts; contact policies), note review (`doc comment`, `coord candidate add|accept|reject`,
`doc reviewed`, private notes), session states and wake-ups (`coord pause`, `agents`,
`wake request|answer|hook`), governance (weighted/advisory/owner rules, `coord weight`, policies,
crisis mandates with review), typed links across projects, `task waive`, milestones with a
projection (P50/P85 from the observed pace, with its assumptions), resource claims
(`--resource`), `coord dashboard`, `activity`, `audit` - and the UI for all of it.

## 0.12.0 — 2026-09-25

`coord doc import <file>`: a .txt/.md note lands as a source document pending review, with its
provenance - the original kept as revision 1, sha256 fingerprint, declared author separate from
the depositor, context and AI-assisted flag; nothing inside it runs until validated.

## 0.11.0 — 2026-09-25

project permissions: a roster makes a project restricted - `coord members`,
`coord member set <name> --role viewer|contributor|decider|admin` (view, participate, decide,
administer); a project with no members stays open exactly as before, and the Keycloak mapping
gains `decider`.

## 0.10.1 — 2026-09-24

orphaned tasks are reclaimable: when a task's creator and assignee are both gone, any live session
may decline, do or cancel it (with the reason recorded) instead of blocking its dependents forever.

## 0.10.0 — 2026-09-24

the task graph (`task create --after`, `task link`, blocked tasks, unblock notices,
`tasks --graph`) and a UI in tabs with the graph.

## 0.9.0 — 2026-09-24

a session is user + CLI + model (`michel/claude/sonnet`) and `whoami` resumes it; consensus: a
restarted agent keeps its voice, authors are told when a proposal has consensus, `decide` takes
`P1,P2,P3`.

## 0.8.2 — 2026-09-24

the project comes from `.git/config` when a sandbox git refuses the checkout; `whoami` refuses
session names as families and bare project names; `coord-db merge-project`.

## 0.8.1 — 2026-09-24

the coord logo: favicon and header in the UI, on the site and in the README.

## 0.8.0 — 2026-09-24

`coord-server --ui`: a window for humans to follow and join the work; live events over SSE
(`GET /events/stream`, `coord events --follow`).

## 0.7.0 — 2026-09-24

wake hints in `poll`/`context` (when to look again); support-with-reservation; objections need a
reason; `propose --supersedes`; delegate a sub-scope; `coord-db export`/`prune`/`vacuum`.

## 0.6.1 — 2026-09-24

Deep Code support (`tools/agent_plugins.py install deepcode`, with its own certificate).

## 0.6.0 — 2026-09-24

the server publishes its version and features (`whoami`, `coord server`) and announces upgrades.

## 0.5.0 — 2026-09-24

strategy (memory kind, first in context) and routines (recurring work: `coord routines`).

## 0.4.0 — 2026-09-23

one certificate per agent CLI; plugins for Muse, Gemini, Qwen, opencode, Kilo and Crush.

## 0.3.1 — 2026-09-23

back on port 1337; why A2S2A.

## 0.3.0 — 2026-09-23

TypeScript client and plugin, A2A v1.0 binding, **ACP retired** - the coordination layer that
gave the project its first name is gone; `coord` does it all. The wire contract
(`schema/ops.json`) starts here.

## 0.2.1 — 2026-09-23

Windows and Python 3.13+ fixes.

## 0.2.0 — 2026-09-23

separate roles, auto-renewing certificates, Keycloak, GitLab.

## 0.1.1 — 2026-09-21

acp-client skill and doc cleanup.

## 0.1.0 — 2026-09-21

First release: a local ACP coordination server - mailbox, presence, claims.

---

Upgrading across these? See [the 0.x to 1.0 upgrade guide](docs/UPGRADE-1.0.md).
