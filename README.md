<p align="center"><img src="docs/img/coord-logo.svg" alt="coord" width="160"></p>

# coord — coordination for concurrent agent sessions

Several coding agents (Claude Code, Codex, your own TS/JS agents) working the
same repositories need to know who is doing what. `coord` gives them claims
on files and directories, direct questions that keep ownership, messages,
tasks, consensus discussions, shared documents and project memory — and it is
an **[A2A](https://a2a-protocol.org) v1.0 agent**, so any A2A client can use
it. (This repo started on IBM's ACP, which is now part of A2A under the
Linux Foundation; the ACP layer was retired in 0.3.0.)

**Site with diagrams: [datamoc.github.io/coord](https://datamoc.github.io/coord/)** - the
architecture, a claim conflict, a consensus discussion and a routine's lifecycle
([archify](https://github.com/tt-a1i/archify) sources in `docs/diagrams/`), and three guides:
[users](https://datamoc.github.io/coord/guide-users.html),
[administrators](https://datamoc.github.io/coord/guide-administrators.html),
[agents](https://datamoc.github.io/coord/guide-agents.html).

**Road to 1.0.0: [docs/ROADMAP.md](docs/ROADMAP.md)** - what remains of the design notes,
the milestones 0.11 to 1.0.0 and their forecast.

**Changelog: [CHANGELOG.md](CHANGELOG.md)** - every release, newest first, and
**[docs/UPGRADE-1.0.md](docs/UPGRADE-1.0.md)** for the move from 0.x to 1.0.

| Part | Where | Language | Command |
|---|---|---|---|
| Server (service, SQLite) | `coordination/server.py`, `a2a.py`; `service.py` = `core.py` + one module per topic (`sessions`, `messages`, `claims`, `consensus`, `documents` + `textpatch`, `tasks`, `memory`, `routing`, `members`, `governance`, `review`, `dashboard`, `wakeup`, `routines`) | Python, stdlib only | `coord-server` |
| Certificate management (local CA) | `coordination/pki.py` | Python + openssl | `coord-admin` |
| Server certificate sources | `coordination/certsource.py` | Python | `coord-server --cert-source` |
| Local mode bridge | `coordination/local.py` | Python | `coord-local` |
| Database upkeep | `coordination/maintenance.py` | Python | `coord-db` |
| **Client** (CLI + library) | `clients/ts/` | **TypeScript**, Node >= 20, no runtime deps | `coord` |
| **Agent plugin** (Claude Code, Codex, Muse, Gemini, Qwen; `tools/agent_plugins.py` for opencode, Kilo, Crush) | `plugins/coord/` | JS (bundled client) | `/coord:join` ... |
| Wire contract | `schema/ops.json`, `schema/project-vectors.json` | generated | `uv run tools/gen_schema.py` |

The contract is generated from the Python service; the TS client and its tests
are checked against it, so the two sides cannot drift.

## Why A2S2A: a server between the agents

A2A is **agent-to-agent**: a client agent discovers a remote agent from its
Agent Card and hands it a task, point to point. coord keeps A2A's wire format
but puts a server in the middle — **agent → server → agent**, A2S2A — for
three reasons.

**1. Persistence — agents are ephemeral, the work is not.** A coding session
ends, its context is compacted or reset, the laptop sleeps. In plain A2A the
state of an exchange lives inside the two agents; when one disappears, so
does the conversation. coord keeps it: claims, messages, discussions and
their decisions, documents with every revision, tasks, project memory. A new
session starts with `coord context` and sees where things stand; a dead
session's claims lapse by TTL, and a stale lease cannot write (fences), so a
vanished agent never blocks the others.

**2. Agents run out of tokens.** An agent can stop mid-task — token budget,
rate limit, context full — without warning, and it cannot be woken up by a
request: CLI agents such as Claude Code or Codex are *clients*, with no
endpoint an A2A peer could call. A server is a mailbox they poll
(store-and-forward): an agent near its budget posts where it is, writes the
analysis into a document, releases or hands over its claims, declines a task
it cannot finish — and whoever comes next, the same agent tomorrow or
another one, finds all of it waiting.

**3. The Bazaar, oddly provided by a server.** In *The Cathedral and the
Bazaar*, Eric S. Raymond contrasts software built by a few architects and
released when ready (the cathedral) with Linux's way: release early and
often, many contributors, peer review in the open ("given enough eyeballs,
all bugs are shallow"). A2A's model leans cathedral: an orchestrator plans
and delegates to specialist agents it has chosen, each opaque behind its
card. coord aims at the bazaar: every session sees the same public square
(messages, claims, discussions), anyone can propose or object, agreement is
computed from the participants' stances rather than decreed, decisions are
recorded, documents grow by small patches that merge. The paradox is only
apparent — the Linux bazaar itself ran on shared infrastructure (mailing
lists, a central tree, a bug tracker). The server is the marketplace, not the
architect: it holds the state and enforces the rules everybody agreed on
(claims, fences, consensus rules, mutual agreements); it decides nothing.

A2A stays where it fits: the server *is* an A2A agent (Agent Card, every
operation as a message, delegation as A2A tasks, push notifications), so
cathedral-style orchestrators can use the bazaar too.

## Quick start (one machine, mTLS)

Needs [uv](https://docs.astral.sh/uv/) >= 0.11, Node >= 20 and openssl
(on Windows, the one from Git for Windows). Windows: see [below](#windows).

### Linux / WSL / macOS

```sh
cd ~/dev/coord
uv sync                                          # server + admin (no runtime dependencies)
(cd clients/ts && npm ci && npm run build)       # the TS client
ln -sf "$PWD"/.venv/bin/coord-{server,admin,local} ~/.local/bin/
ln -sf "$PWD"/clients/ts/dist/cli.js ~/.local/bin/coord

coord-admin init && coord-admin server-cert      # local CA + server certificate (47 days, self-renewing)
coord-admin enroll <client-name>                 # an agent identity -> ~/.config/coord/<client-name>/ (first = default)
cp contrib/systemd/coord-server.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now coord-server   # WSL: systemd=true in /etc/wsl.conf

claude plugin marketplace add ~/dev/coord
claude plugin install coord@coord
```

Agents then run `/coord:join` (or `coord whoami <family>`), from any
directory, after reboots, with no exports. `coord --help` lists every command.

### Windows

One script does it all, and is safe to run again (it only checks what is already done):

```powershell
cd ~\dev\coord
powershell -ExecutionPolicy Bypass -File tools\setup-windows.ps1 -Codex -AutoStart
```

It checks uv, Node and port 1337, runs `uv sync`, finds a working openssl,
creates the CA and the server certificate, enrolls `claude` (`-Identity a,b`
for others) and, with `-Codex`, `codex`; writes `~\.local\bin\coord.cmd`
(the plugin's bundled client - no npm build needed) and puts that folder on
your user PATH; with `-AutoStart`, registers a `coord-server` logon task
(log: `server.log`) and starts it. It prints what is left to do by hand:
the plugin install commands below, and Codex's `config.toml` line.

Without the script: the Linux steps above, with `coord.cmd` instead of the
`ln -sf` lines and `.venv\Scripts\coord-server.exe --pki pki` (in a
terminal, or a scheduled task) instead of systemd.

### Codex

```powershell
codex plugin marketplace add C:\Users\<you>\dev\coord
codex plugin add coord@coord
```

Codex has no slash commands for plugins: start with `$coord join` (or
"join coord"). On Windows, Codex's elevated sandbox runs commands as
separate accounts (`CodexSandboxOffline`, `CodexSandboxOnline`) with their
own home folder, so the client finds no identity. Two settings fix it -
`setup-windows.ps1 -Codex` does the first and tells you the second:

1. Let those accounts read the `codex` identity, and only it:
   `icacls "$HOME\.config\coord\codex" /grant "CodexSandboxOffline:(OI)(CI)RX" "CodexSandboxOnline:(OI)(CI)RX"`
2. Point the client at it in `~\.codex\config.toml`, then restart Codex:
   ```toml
   [shell_environment_policy.set]
   COORD_CONFIG = 'C:\Users\<you>\.config\coord\codex\env'
   ```

Anything Codex runs can then use the `codex` identity - that is the point;
the `claude` bundle stays private. Loopback (`localhost:1337`) works without
`network_access`.

## For agents

**Plugin** (`plugins/coord`): the `coord` skill (the session protocol) plus
`/coord:join`, `/coord:poll`, `/coord:post`, `/coord:claim`,
`/coord:release`, `/coord:status`. It ships the compiled client, so it needs
only Node. Claude Code loads this directory marketplace in place: edits apply
at the next session (or `/reload-plugins`). Codex installs a copy
(`codex plugin marketplace add <checkout>`, `codex plugin add coord@coord`).
Command bodies must not use `$ARGUMENTS` (Codex skips such commands).

**Other agent CLIs** - the same skill and commands, one source
(`plugins/coord/claude-commands/*.md`; the Gemini/Qwen TOML commands are
generated from it):

| CLI | Install | Commands |
|---|---|---|
| Muse Code | `muse plugins install plugins/coord` (reads the Claude manifest; a copy: `muse plugins update coord` after pulling) | `/coord:join` ... |
| Gemini CLI | `gemini extensions link plugins/coord` (`install` for a copy) | `/coord:join` ... |
| Qwen Code | `qwen extensions install <checkout>\plugins\coord` (reads the Gemini manifest; absolute path; a copy: after pulling, `qwen extensions uninstall coord` and install again - `update` only sees version bumps) | `/coord:join` ... |
| opencode, Kilo | `uv run tools/agent_plugins.py install opencode kilo` | `/coord-join` ... |
| Crush | `uv run tools/agent_plugins.py install crush` | skill only |
| Deep Code | `coord-admin enroll deepcode`, then `uv run tools/agent_plugins.py install deepcode` (in `~/.deepcode/skills`) | skill only |

`install` copies the skill (and commands) into the CLI's config dir with
this checkout's client path written in, so keep the checkout where it is
and rerun `install` after pulling skill or command changes (`uninstall`
removes them). Every CLI takes its own session family: `whoami opencode`,
`whoami gemini`, ...

**One certificate per CLI.** Without `COORD_CONFIG`/`COORD_IDENTITY`, the
client picks the identity named after the CLI running it when one is
enrolled - `muse` under Muse (`MUSE_SESSION_ID` is set), `opencode` under
opencode (`OPENCODE=1`) - else the default. So `coord-admin enroll muse` and
`coord-admin enroll opencode` are enough: no per-CLI setting, and the server
log (`coord-server -v`) and revocation are per CLI instead of one shared
`mtls:claude`.
Deep Code sets no such variable, so `agent_plugins.py install deepcode` writes
`COORD_IDENTITY=deepcode` into its copy of the skill instead (when that
identity is enrolled; install again after enrolling).

**CLI** — the session protocol:

```sh
coord --json whoami claude                    # -> name claude-NN + session_id; keep both
export COORD_SESSION=<session_id>             # or prefix every command with it
coord context                                 # overview, memory, my claims, tasks, discussions, unread
coord locks && coord claim src/auth/ --note "rework login"   # dir/ = whole tree; C12
coord ask --claim C12 --to codex-01 "second opinion on the token flow?"
coord post --kind done "login rework merged (!45)"
coord poll                                    # idle: about every 5 minutes
coord release --all && coord end
```

**Library** — for agents written in TS/JS (`clients/ts`, typed from the contract):

```ts
import { CoordClient } from "@datamoc/coord-client";
const c = CoordClient.fromEnv();              // same config as the CLI (~/.config/coord/env, COORD_*)
const me = await c.call("whoami", { family: "my-agent", project: "gitlab.dci.local/team/repo" });
await c.call("claim", { session: me.session_id, scope: "src/auth/", tree: true });
const task = await c.a2a("GetTask", { id: "T3" });   // any A2A method
```

### Strategy and routines

Two things coord keeps for a project beyond single tasks (after Cursor's
[Projects](https://cursor.com/blog/projects): shared knowledge that grows,
and recurring work done without being asked):

- **Strategy** - memory entries of kind `strategy`: the project's goals and
  ways of working. `coord context` prints them in full, first, to every
  agent that joins; `coord strategy` lists them. Changing one is a
  discussion (`coord discuss`), not a unilateral edit.
- **Routines** - standing work that comes back by itself: `coord routine
  create "Security review" --every 1d --instructions "npm audit, secrets
  scan"`, or `--on-commit --path src/` to fire after a commit touching
  `src/` (seen through `coord install-hooks`' post-commit hook). Due
  routines show in `poll` and `context`; an agent takes the run (`routine
  start R1`: one runner at a time, a one-hour lease), then reports it
  (`routine done R1 "result" [--outcome issues|failed]`; not `ok` also posts
  a warning). `coord routines` shows each one's schedule, runner and last
  result; `routine show R1` its last runs. The server keeps the schedule
  and the lease - it never runs anything: a routine waits for an agent to
  poll, like everything else here.

**Worth it with a single agent too.** Nothing here needs a second agent:

- *An agent forgets; the project should not.* A session ends, its context is
  compacted, tomorrow it's another model or another CLI (Claude today, Codex
  tomorrow). The strategy is the part that comes back every time - `coord
  context` prints it first - instead of living in one chat, or in a
  `CLAUDE.md` that only one CLI reads.
- *Chores nobody asks for get done.* A lone agent does what it's told; a
  routine is what it would never think of doing: the weekly security review,
  checking that the docs followed a change in `src/`. The server remembers the
  schedule and the commits that touched the watched paths; the agent just sees
  "due" in `poll` or `context` when it next looks.
- *A record, not a memory.* Each run leaves its result (`routine show R2`, the
  UI's Routines tab): you can see when the security review last ran and what
  it found, without asking the agent.
- *It scales without rework.* When a second agent joins, it reads the same
  strategy and takes the same routines - one runner at a time, so they never
  do the same chore twice.

coord's own project uses them: two strategy entries (how to work on it,
compatibility and secrets) beside the road to 1.0.0, and routines for docs
following the code (on commit), a weekly security review, a roadmap check
every three days and a weekly database upkeep.

### Sessions: user + CLI + model

`coord whoami claude --model sonnet` names the session `michel/claude/sonnet` - the user (the
OS user, or `COORD_USER`), the agent CLI and the model (`--model` or `COORD_MODEL`). Another
`whoami` for the same association, in the same project and under the same identity, **resumes**
that live session instead of opening a new one, so an agent that re-runs `whoami` stays one
session. Two genuinely distinct instances of the same association get `#2`. Without user and
model (`COORD_USER=""`, older clients) sessions are `family-NN`, one per call, as before.

### Graphical interface (for humans)

```sh
coord-server --pki pki --ui            # + a window to follow and join the agents' work
```

`--ui` serves a small page on **127.0.0.1** only and opens it as an app window (Edge / Chrome
`--app`, else your browser), in tabs: **Overview** (every project you may see: what needs
attention, agents' session states, unblock points, next milestones, and the activity stream
filtered by project, actor, event type and age), **Now** (agents with their state and waiting
work - **Reactivate** a sleeping one -, claims, the message feed - write with a priority, reply,
take, mark done, see receipts, turn a message into a candidate task - and what is waiting for
someone), **Tasks** (the interactive graph - typed edges, other projects' nodes, click a task for
its exact blockage, waive or unlink with a reason; hide done, filter by assignee, focus on a
node's neighbourhood, highlight the path to a milestone -, the milestones timeline, the task
lists ready / blocked / unowned / unblocked recently), **Discussions** (react, abstain, decide,
weighted tallies, crisis mandates, a chat under each open one to talk with the agents), **Routines & strategy**, **Documents** (deposit a note, read
it with its provenance, comment on a passage, propose candidates from a selection, review
them); badges count what needs attention, all updated live. You take part as `ui:<your name>` (`--ui-as alex`), one session per project; nothing to
install, no certificate in the browser.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/coord-ui-dark.png">
  <img alt="The coord UI: sessions and claims, the message feed, tasks, a discussion with a reservation, routines and documents" src="docs/img/coord-ui-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/coord-ui-tasks-dark.png">
  <img alt="The Tasks tab: the task graph, prerequisites on the left, blocked tasks dashed" src="docs/img/coord-ui-tasks-light.png">
</picture>

*A demo project (`uv run tools/demo_ui.py demo.db`), not real work.*

### Task graph

`coord task create "Enable retries" --after T5,T6` (or `coord task link T7 --after T5`): a task
waiting on unfinished prerequisites is **blocked** - it can be offered, not accepted - and when
the last one is done (or cancelled), whoever it is for gets "T7 unblocked". Cycles are refused.
`coord tasks` shows `blocked by T5`, `coord tasks --graph` draws the forest in text, the UI's
Tasks tab as a graph.

The link carries a per-launch token (`…/?t=…`) that becomes an HttpOnly, SameSite=Strict
cookie; requests need that cookie and a loopback `Host` (no DNS rebinding), writes also the
UI's own `Origin` (no CSRF); the page runs under a strict CSP and shows everything agents write
as text only. `--ui-port` fixes the port, `--ui-open none` only prints the link.

### Humans and agents together

coord is shared organisational state for agents *and* people: nobody has to be the coordinator.
Humans are participants with their own identity (`whoami --human`, the UI, a Keycloak account),
roles per project (`coord member set`), and they are never absolute chiefs by default.

**One chat for every agent.** `coord post "..." --to a,b` (several sessions), `--group typescript`
(the live sessions declaring that capability or category), or the whole project; `--task T4`,
`--doc DOC2`, `--discussion D1` link a message to what it is about. **Priority sets attention,
not authority**: `--priority high|urgent` asks for a quick look and an acknowledgement, never that
the content be accepted. Each recipient of a directed (or high/urgent) message has a **receipt**:
`delivered` when its poll returned it (technical, proves nothing about understanding), `read`,
`taken`, `answered` (a reply in the thread, set by itself), `done`, or `declined` with the reason -
`coord ack 42 taken|done|declined "why"`, `coord receipts 42`. `poll` and `context` list what
waits for you; urgent ones become a wake-now hint. **Contact policies** keep the attention
budget: `coord contact policy open|auto|contacts_only|block_all`; under `contacts_only` a first
message becomes a request the person accepts (`coord contact accept name`), `block_all` refuses
direct messages (broadcasts, task offers and invitations still arrive).

**A note deposited is a source, not an order.** `coord doc import` (see Reference) keeps the
original, its fingerprint, the declared author apart from the depositor, when it was written,
its context, AI assistance, and its visibility (`--visibility private --reader b` - the
depositor, named readers and admins; `--project` deposits it in another project you take part
in). Then: `coord doc comment DOC3 "which boss?" --quote "The boss freezes"`, and **candidates**
drawn from it - `coord candidate add DOC3 task "Fix the freeze" --quote "The boss freezes when
the save fails." --nature fact` (targets task, decision, memory, question, summary; natures
fact, hypothesis, opinion, decision already taken). The quote must be found verbatim in the
source. Nothing happens until someone with the decide right reviews it: `coord candidate accept
S1 [--title ...]` creates the task (unassigned), the discussion (a decision *to debate*), the
memory entry, the question or the summary, each linked back to its passage (`task show` prints
`source: S1 from DOC3 r1 (fact): «...»`); `coord candidate reject S2 "why"` keeps the refusal.
A message becomes a structured object the same way (`coord candidate add '#42' task ...`), and
its thread learns what it became. `coord doc reviewed DOC3` closes the review. Every read of
an imported note is in its audit trail (`coord audit DOC3`).

**Sleeping agents.** An agent's session state - `active`, `idle`, `paused` (`coord pause
"why"`), `ended`, `unreachable` - is shown apart from its work (`coord agents`): a paused agent
may still have a task assigned, and an open task is not one assigned to it. `coord wake request
qwen-01 --reason task --ref T12` asks it to resume and is followed `requested -> delivered ->
woken` (it polled again, or a new session of the same identity started) `-> accepted|refused`
(`coord wake answer W3 refuse "quota until 18:00"`). How it is delivered is separate from the
request: a **wake hook** (`coord wake hook qwen --url https://... --token ...`, admins; POSTed by
coord-server to loopback or `--push-allow` hosts, recorded delivered or failed), a live
session's next poll, or a **manual relaunch** - the result carries a resume summary (the precise
work, then everything persistent waiting) to paste into a new session; its volatile context is
not restored. Limits against loops: one request per agent, reason and reference every 10 min,
at most 3 unanswered, then a diagnostic for a human. `coord setting wake_auto request` (admins)
asks a sleeping assignee to resume when its task becomes ready; `propose` only shows it.

**Governance.** A discussion's rule is chosen per subject: `unanimous`, `majority`,
`no-objection`, `weighted`, `advisory` (opinions, binding nobody), `owner --owner name` (a
designated person decides, the stances are advice). A **weighted vote** fixes everything before
it starts and shows it: the electorate (`--with`), the weights (`--weight alice/ui=3`, else the
project's per-domain weights `coord weight alice/ui 3 --domain architecture`, else 1), the
threshold (`--threshold 0.5`, share of the expressed weight), the quorum (`--quorum-weight 0.5`,
share of the electorate's weight) and the closing date (`--deadline`, required); weights changed
later do not touch it, abstention and silence never count as support, and the record keeps
every position and objection. **Policies** (`memory add policy`, admins only) are organisational
rules not put to a vote; `context` lists them apart.

**Crisis authority** (after the Roman dictator who handed his powers back): project admins may
give a *human* a bounded mandate - `coord mandate grant bob/ui --reason "..." --power decide
--power reassign --for 2d [--scope engine]` - never to themselves, capped by `setting
mandate_max_days` (default 7, at most 30), not prolonged (let it end or revoke it first).
Under it: `coord decide D4 "..." --crisis --reason "..."` (recorded as a crisis arbitration,
never as consensus, with what the normal rule gives and every objection), `coord crisis
reassign T9 --to x "why"`, `coord crisis release C3 "why"`. `coord mandate revoke A1 "why"`
(admins, or the holder handing it back); at expiry the ordinary rights return by themselves and
a **post-crisis review** discussion opens with one proposal per act to confirm, amend or annul.
Stopping agents in an emergency is a different permission.

**The graph and milestones.** Links are typed: `blocks` (the prerequisite; `--condition "the
game can be finished without a blocking error"`), and context that holds nothing back:
`enables`, `related_to`, `duplicates`, `part_of` (`coord task link T3 --after T1 --type enables
--reason ...`). A blocking link can be lifted explicitly, `coord task waive T3 --after T1 "why"`
(decider). Links may cross projects when you may see both: `coord tasks` brings the
prerequisites that live elsewhere, and permissions keep applying. `coord tasks --view
ready|blocked|unowned|recent|milestones`, `coord unblock-points` (unfinished tasks whose
completion would make others ready now - a count of descendants is not a priority). A
**milestone** is a verifiable result: `coord milestone create "Pixel Dungeon playable"
--criterion "a full game can be started, played and finished" --target 30d --after T12`,
`milestone criterion T20 1`, `milestone target T20 45d "the save system slipped"` (the previous
targets stay, with their reasons), `milestone reach T20` (every criterion met, nothing blocking
- it may be reached while other work goes on). `coord milestones` is the timeline: reached ones
with their dates, then the upcoming ones with criteria met, tasks left and how the target moved -
no invented percentage. When the history allows it (at least 5 tasks done over 3 days or more in
the last 28), an upcoming milestone carries a **projection**: the projects' observed pace, tasks
done per day, is replayed 1 000 times (Monte Carlo, seeded - the same data give the same answer)
until its remaining tasks are done, never faster than its longest chain of prerequisites at the
median accepted-to-done time. It gives P50 and P85 dates (the spread is the uncertainty), how
many runs meet the target, the basis (window, tasks done, chain) and its assumptions in words:
the pace goes on, the scope does not grow, tasks count alike. Without enough history it says so
and why, rather than inventing a date.

**Claims on any resource.** `coord claim gpu:0 --resource gpu`, `claim npm-test --resource
build`, `claim 8080 --resource port`, `claim android-test-phone --resource device`: the same
owner, note, lease (`--ttl`), renewal, fence and history as a file claim; they conflict only
with the same resource and never take part in git checks.

**Seeing it all.** `coord dashboard` (every project you may see, or `--project`): per project
the agents and their states, what needs attention - an agent asleep with work assigned, someone
waiting for an answer, a blocked or late discussion, a failed or refused wake-up, candidates and
notes waiting for review, an active crisis mandate -, the unblock points and the next
milestones. `coord activity [--actor x] [--kind task|wake|message...] [--since 2h]` is the
activity stream as readable lines ("claude-01 claimed src/combat/"), `coord audit T12` one
object's history - from a decision or a blockage back to the discussion, the vote, the note that
produced it.

### Live events

`GET /events/stream?project=P` streams the event log as server-sent events (same
authentication as `/call`; `Last-Event-ID` resumes). `coord events --follow` prints it live -
for agents and scripts that can listen. `poll` stays the guarantee: after a drop, resume from
the last id and nothing is lost.

### Waking up and database upkeep

- **Wake hints**: `poll` and `context` return `wake: {next_at, in_seconds, reason}` - when this
  session should look again: a due routine or an offer (now), a discussion deadline, a claim
  10 min before it expires, a broadcast question or warning nobody resolved within 15 min (now -
  a directed one, a task offer or a discussion invite, already has its own hint and its own way
  to close), at the latest the poll that keeps the session alive. The server cannot wake a CLI
  agent; one that can schedule itself (a loop, a cron, a wake-up when its quota returns) uses
  `next_at`. The skill says what to leave behind before stopping.
- **`coord-db`** (the administrator's, not an agent op): `coord-db export [--project P]
  [--out f.json]`, `coord-db import f.json [--apply]`, `coord-db prune --older-than 30d [--apply]`
  (a dry run without `--apply`; keeps documents, memory, discussions, tasks, routines and
  unresolved questions/warnings), `coord-db vacuum`, `coord-db merge-project OLD NEW [--apply]`
  (a renamed repository, or sessions that joined under a wrong project id; posts a notice listing
  the still-open questions moved). Safe while `coord-server` runs.

**Backup and restore.** The database is one file (`coord2.db`, with `coord2.db-wal` beside it
while the server runs), so the plainest backup is a file copy with the server stopped. While it
runs, take a JSON export instead - it reads every table inside one connection, so it cannot catch
a half-written state:

```sh
coord-db export --out backup.json                              # everything
coord-db export --project github.com/org/repo --out repo.json  # one project
coord-db import backup.json                                    # dry run: what it would insert and skip
coord-db import backup.json --apply                            # restore
```

`import` creates the database when there is none, so a restore onto a new machine is
`coord-db --db /somewhere/coord2.db import backup.json --apply`. It is **additive and repeatable**:
nothing is ever deleted, and rows whose primary key is already there are counted as skipped
rather than duplicated, so running a restore twice is harmless.

A `--project` export carries that project's rows *and* the content that belongs to them -
document bodies and revisions, proposals and reactions, message recipients, task dependencies -
so moving a project between servers is an export and an import, with no SQL.

Stop `coord-server` before restoring over the file it is serving. Both are SQLite writers and
they queue politely, but a restore is not the moment to let a second writer hold the file open.

### Server version and features

The server publishes what it is, to agents as well as A2A clients:

- `whoami` returns `server: {version, features}`; the client compares it
  with its own version and adds a `server_warning` when they differ (a newer
  server has features this client has no command for; an older one answers
  `bad_op` to newer commands).
- `coord server` (op `server_info`): version, features, what is new in this
  version, the read/write ops and the limits (session and claim lifetimes,
  message size, routine lease).
- On start, a server whose version differs from the last one its database
  saw posts one `coord-server` info message to every project, listing what
  each release since brought (`NEWS` in `coordination/core.py` - add a line
  per release).
- The A2A Agent Card carries `version` and the features as skill tags.

### Reference

**Identity.** `whoami <family>` gives `<family>-NN`, a session UUID and a
generation. Every command authenticates with the UUID (`COORD_SESSION`, else
`.coord-session` at the repo root — shared by the checkout, so a second
`whoami` never overwrites a live session's file). A recycled name gets a new
UUID and a higher generation, so it can never touch the old session's claims.
A dead or ended session cannot mutate anything; its claims lapse with it.

**Correctness.** Every mutation runs under `BEGIN IMMEDIATE`; mutations take a
`client_id` idempotency key (the CLI sends one), so a retried post/claim is
replayed, not duplicated. `poll` and `inbox --after N` use message ids as
cursors. Everything carries a `project_id` from `git remote origin`
(`github.com/org/repo`, `gitlab.dci.local/group/sub/repo`; SSH with a port and
HTTPS give the same id; override with `COORD_PROJECT`); `coord projects` is
the cross-project view.

**Permissions — open until a roster exists.** A project with no members is
open: everyone views, participates and decides, exactly as before. `members`
lists the roster; `member set <name> --role viewer|contributor|decider|admin`
restricts the project to its members — in an open project the first member can
only be yourself (`member set <you> --role admin`), then that admin adds
everyone else. The rights stack: `viewer` reads, `contributor` writes,
`decider` also closes discussions (`decide`), reviews candidates, waives a
dependency and records a milestone reached; `admin` manages members, weights,
wake hooks, project settings, policies and crisis mandates.
Restricted content needs your session — the read commands pass it
automatically — and a non-member gets `forbidden` naming the admins to ask.
Removing the last member reopens the project. The Keycloak groups
`coord:<project>:<role>` (below) use the same four roles and gate the
transport before any op runs.

**Claims.** Repo-relative, normalized paths (`\` -> `/`, `..`/absolute
refused, case-folded on Windows). `claim src/auth/` (or `--tree`) claims a
tree; a file claims `exact`. Parent/child scopes conflict; siblings don't.
Claims get ids (`C12`) and a monotonic **fence** (`fence-check C12 <fence>`
refuses stale leases). `renew`, `release C12`, `release --all`.

**Asking without losing ownership.** `ask --claim C12 --to codex-01 "..."`
sends a direct question tied to the claim and grants `advisor` (or `--role
reviewer|coeditor|delegate`); advisors get no write access, only a
`delegate` may claim inside your scope. **Roles are mutual when they carry
duties**: `advisor`/`reviewer` apply at once (advice only), `coeditor` and
`delegate` are *offers* - the grantee gets a direct message and answers
`role accept C12 delegate` or `role decline C12 delegate "why"`; they take
effect only once accepted (`roles C12` shows `offered`/`granted`).

**Messages.** Kinds `info question advice proposal decision review warning
done`; `--to <session>` is private to both ends; `reply N`, `thread N`,
`resolve N`. Soft limit 300 chars, hard 10000 — long content goes in a
document. Every command takes `--json`.

**Tasks — assignment is an offer.** `task create "..." [--assign <session>]`:
unassigned = `open` (anyone may `task accept`); assigned = `offered` - only the
assignee can `task accept T3`, or `task decline T3 "why"` (back to `open`,
unassigned, reason kept). Creator and assignee get direct messages at each
step; offers show in the assignee's `poll` and `context`. `task done T3
"note"`, `task cancel T3` (creator or assignee), `task show T3`, `task update T3
--title "..." [--priority 3] [--category x] [--description "..."]` - the creator,
the assignee or a decider edits what the task *says* (title, description,
priority, category); status keeps its own path, a field left off is untouched,
and what changed appears in `coord activity`. `tasks
--status open|offered|accepted|done|cancelled`; `task notify T3 --url
https://...` registers an A2A push webhook (below). Orphaned (both the
creator's and the assignee's sessions gone past their TTL, not just briefly
offline): decline/done/cancel open up to any live session, so a stale or
superseded task does not block its dependents forever - the note records it
was closed this way. A task created with `--human-ack` asks a human to close it: it
shows an acknowledge/close button in the UI (`task ack T3 ["note"]` does the same
in one step, from any participant), so closures that are the human's call by design -
and work no live session can otherwise close - finish in one click.

**Consensus — computed, never declared.** `discuss "topic" [--with rev-01,ops-01]
[--rule unanimous|majority|no-objection] [--quorum N] [--deadline 48h|<ISO date>]`
-> `D3` (invited participants get a direct message); `propose D3 "..."` -> `P7`;
`react P7 support|object|abstain|need-more-info`; `discussion D3` shows, per
proposal, each participant's stance and whether the rule is met; `decide D3
"..." --proposal P7` closes it and writes a `decision` document with the
per-participant stances; every participant is told the outcome.

**Ask choices in coord, not in the console.** An agent facing a decision (which version,
which design, which name) opens a discussion instead of prompting: a background session's
console prompt reaches nobody. Invite the live sessions (`coord agents`, `--with` - only
live sessions can be invited), propose one option each, and the human joins in the UI's
Discussions tab - the discussion's opening question is already in their feed, and they talk
back in the chat under the discussion. `owner
--owner <their ui:name>` when the human decides (other stances become advice); a
`--priority high|urgent` message linked with `--discussion D1` when it cannot wait.

- **Objections block a silent decision**: without consensus `decide` is
  refused (`no_consensus`, saying who objected or stayed silent). The opener
  may still decide, explicitly: `--no-consensus "reason"` - recorded with the
  objections.
- **Joint decision**: once consensus is reached, any participant may close
  the discussion, not only the opener; overriding stays the opener's.
- **Deadline**: after it, a participant's silence counts as agreement
  (marked *silent past deadline*); before it, silence is "no stance yet".

- **Participants**: the opener plus `--with` (live sessions). Without
  `--with` the discussion is open: the opener plus whoever reacts. Only
  participants count; others' reactions are shown in the tally.
- **Stances**: a participant's reaction; otherwise the proposal's author
  supports it, and so does the decider for the proposal they decide on (both
  marked *implied*).
- **Rules** (default `unanimous`): `unanimous` = everyone supports
  (abstentions allowed; an objection, `need-more-info` or silence fails it);
  `majority` = more than half of the participants support; `no-objection` =
  nobody objects or asks for more info (silence is consent).
- **Quorum** (default 2): at least that many participants took a stance, so
  consensus always involves someone besides the decider.
- `decide` records the **computed** result; `--no-consensus` can only lower
  it. Discussions from 0.2.x get `unanimous`/2 and no deadline when the
  database is opened; their old decisions keep the value recorded then.
  Grants made before 0.3 stay in effect.

**Documents & memory.** `doc create --kind note|diagnosis|plan|proposal|decision|review|adr`,
`doc show|history`, and two ways to edit:

- `doc edit DOC4 --base-revision 3 --file new.md` replaces the whole content;
  a stale base is refused with the current content (merge and retry).
- `doc patch DOC4 --base-revision 3 --from new.md` (the client diffs the file
  against revision 3 and sends only the diff), or `--file change.diff` / stdin
  with any unified diff (`diff -u`, `git diff`). If someone edited since
  revision 3, the diff is re-applied to the latest revision, each hunk found by
  its context: **non-overlapping edits merge** (`merged: true`, noted in the
  history); overlapping ones get `revision_conflict` naming the hunks, with the
  current content. A diff that doesn't match revision 3 itself is
  `patch_invalid`; exact matching only, never fuzz. Line endings (CRLF) and a
  missing final newline are preserved.
- `doc import <file> [--title ...] [--author alice]
  [--context reflection|discussion|meeting|other] [--ai yes|no|unknown]
  [--source ...] [--written 2026-09-20] [--visibility project|private --reader b]
  [--project other]` deposits a `.txt`/`.md` note as a **source document** (status
  `imported`): the original text is kept as revision 1 with a sha256
  `fingerprint` (re-hash revision 1 to verify it), the depositor recorded
  separately from the declared author, plus the context and whether AI helped
  write it. Import needs only `participate` - it is a participation act, not an
  admin one - and **nothing in it runs**: an imported note is data to read and
  discuss, never an order to agents; promoting what it says into tasks,
  decisions or memory stays an explicit, validated act: `doc comment`,
  `candidate add|accept|reject`, `doc reviewed` (see *Humans and agents
  together*). Visibility follows the project's permissions, or `private`.

`memory add overview|convention|architecture|decision|pitfall|glossary|policy` (policy: admins),
`memory show|search|edit`. `profile` / `suggest` rank live agents (a hint).

**Git.** `coord install-hooks [--mode fail|warn]`: pre-commit `coord check`
(fails the commit if a staged file is claimed by another session; `--mode
warn` prints the same conflicts but lets the commit through - also settable
per shell with `COORD_CHECK_MODE=warn`, or per invocation with `coord check
--mode warn`) and post-commit `coord post-commit` (publishes the commit,
releases every exact-scope claim you own on a file the commit touched - a
tree-scope claim (`--tree`) is not touched by this and stays yours to
release). Hooks do nothing without a session.

## A2A

The server is an A2A v1.0 agent (JSON-RPC binding), verified with the
official `@a2a-js/sdk` in `clients/ts/test/a2a-sdk.test.mjs`:

- **Agent Card** at `/.well-known/agent-card.json` (`coord agent-card`):
  endpoint `/a2a`, skills `coord-ops` and `delegate`, and the security scheme
  in use (`mtlsSecurityScheme` or `openIdConnectSecurityScheme`).
- **Every coord operation**: `SendMessage` with a data part
  `{"op": "<name>", "args": {...}}` (names and params: `schema/ops.json`); the
  reply is a Message whose data part is the result. The TS client uses this
  (falling back to `/call` on a pre-0.3 server; `COORD_PROTOCOL=call` forces it).
- **Delegation = A2A tasks**: `SendMessage` with text parts and metadata
  `{"coord": {"session": "<id>", "assign": "<name>"}}` creates a coord task and
  returns an A2A Task. `GetTask`, `ListTasks` (`contextId` = project),
  `CancelTask` (metadata `coord.session`). States: open = `SUBMITTED`,
  accepted = `WORKING`, done = `COMPLETED`, cancelled = `CANCELED`.
- **Push notifications instead of polling**:
  `Create/Get/List/DeleteTaskPushNotificationConfig`; on accept / done /
  cancel the server POSTs `{"statusUpdate": ...}` (`application/a2a+json`,
  `X-A2A-Notification-Token` or `Authorization: <scheme> <credentials>`).
  Webhooks may only target loopback or `--push-allow` hosts
  (`--push-allow .dci.local`): a registered URL makes the server send
  requests, so arbitrary hosts are refused.
- Not offered: streaming (`SendStreamingMessage`, `SubscribeToTask` ->
  `-32004`), extended card. Coord refusals are JSON-RPC errors `-32000` with
  `data.error` = the coord code (`conflict`, `forbidden`, ...).
- A renewed mTLS client certificate comes back in the `Coord-Certificate`
  response header (base64 PEM).

## Security and identities

The trust boundaries, what each of the four paths checks, the two findings this review turned up
(the UI token reaching the log; a redirect escaping the push allow-list) and the risks accepted
on purpose are written up in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

`coord-server` listens on `127.0.0.1:1337` ("leet" - the port this project has used since 0.1; 0.2.x-0.3.0 used 1338 while the ACP server held 1337). A non-loopback `--listen` is
refused unless TLS **and** an identity method are configured. Without one
(plain loopback), anyone on the machine can read and write: keep it on
loopback. In both authenticated modes a session is bound to the identity
that opened it; another identity cannot drive it.

### mTLS with the local CA (`coord-admin`)

- **Enroll**: `coord-admin enroll <client-name>` (the agent identity — not
  the server; `coord-admin server-cert [server-name]` is the server's) issues
  a 30-day client certificate and writes a self-contained bundle to
  `~/.config/coord/<client-name>/` (`ca.crt`, `agent.crt`, `agent.key` 0600,
  `env`), or `--out DIR` for another machine. The first identity (or
  `--default`) becomes `~/.config/coord/env` (a symlink, or a
  `COORD_IDENTITY=<name>` pointer where symlinks need privileges);
  `COORD_IDENTITY` / `COORD_CONFIG` select others; shell variables win.
- **Serve**: `coord-server --pki pki`. Every request asks management whether
  the certificate is still valid: `coord-admin revoke <client-name>` (and all
  its renewals) applies to the next request, no restart.
- **Renewal, 47-day cap**: once a client certificate is 15 days old
  (`--renew-after-days`), the server gets a renewal of the **same public
  key** from management and returns it; the client checks it matches its key
  and replaces `agent.crt`. No private key ever moves. The server renews its
  own certificate at start and every hour (`--check-seconds`) and loads it
  live. No certificate lives longer than 47 days (server 47, clients 30);
  longer ones are renewed at first use. A renewal retires the certificate it
  replaces once the new one is seen in use; `coord-admin tidy [--apply]`
  cleans up older leftovers; `coord-admin list` shows everything.
- **CA upgrade (from <= 0.2.0)**: Python 3.13+ and strict clients refuse a CA
  without `keyUsage`. `coord-admin init` re-signs it in place (same key and
  name, old kept as `pki/ca.crt.pre-keyusage`, local bundles refreshed), then
  `coord-admin server-cert` and restart; copy the new `ca.crt` to other
  machines' bundles.
- **Which openssl**: `COORD_OPENSSL` if set; on Windows, Git for Windows'
  copy (found next to `git`, or under Program Files) before the one on PATH -
  apps such as KDiff3 ship an `openssl.exe` that looks for a config file from
  its build machine and can crash; elsewhere the one on PATH. Windows works
  without Developer Mode.

### Keycloak (OIDC)

Server: `--oidc-introspect-url .../protocol/openid-connect/token/introspect
--oidc-client-id coord` (secret in `COORD_OIDC_SECRET`; `--oidc-cache-seconds`,
default 60, is how long a revoked token may still work). Per-project roles
from token roles/groups `coord:<project>:viewer|contributor|decider|admin`
(`coord:*:...` for all). Clients get and refresh their own tokens:

```sh
# ~/.config/coord/env
COORD_SERVER=https://coord.example.com:1337
COORD_OIDC_ISSUER=https://sso.example.com/realms/corp      # endpoints discovered
COORD_OIDC_CLIENT_ID=coord-agent
COORD_OIDC_CLIENT_SECRET_FILE=~/.config/coord/agent.secret  # service account; or omit and run `coord login` once
```

Tokens are cached (0600, `~/.config/coord/oidc/`, shared by parallel agents
under a lock), refreshed before expiry, rotated refresh tokens kept; a 401
triggers one fresh token and retry; an ended SSO session says `run coord
login`. Keycloak client: "OAuth 2.0 Device Authorization Grant" for `coord
login`, "Service accounts" for client credentials; `COORD_OIDC_SCOPE="openid
offline_access"` for agents that outlive the SSO session. A fixed
`COORD_TOKEN` still wins. Local and OIDC modes never load the PKI code.

### Corporate CA for the server (`--cert-source`)

| `--cert-source` | Who renews | Typical CA |
|---|---|---|
| `watch` | an external renewer rewrites the files; reload on content change (60 s) | cert-manager (mounted Secret), certmonger (AD CS), `step ca renew --daemon` |
| `command` | the server runs `--renew-command` when due (`{cert}`, `{key}`), then reloads | step-ca (`step ca renew --force {cert} {key}`), an AD CS script |
| `local` | our management (`--pki`) | the local mTLS setup |

"Due" = 15 days or two-thirds of the lifetime, whichever comes first (step-ca
defaults to 24 h certificates). A pair that does not load is never swapped
in. These integrations are tested with simulated renewers, not against the
real services.

## Local mode

Without `COORD_SERVER`, `coord` runs each operation on the repo's
`coord2.db` through `coord-local` (the Python package; `COORD_DB`,
`COORD_LOCAL` override) — no server, no port, no auth. A2A features
(push notifications, `a2a()`) need a server.

## Migrating from 0.2.x

| 0.2.x | 0.3 |
|---|---|
| `ACP_server.py` / `ACP_client.py` (mailbox on :1337) | removed — `coord` does it all (the old `coord.db` stays on disk, unused) |
| `post` / `inbox` / `resolve` | `coord post` / `coord inbox` / `coord resolve` |
| `request` / `requests` / `done` | `coord task create --assign` (an offer: the assignee accepts or declines) / `coord tasks` / `coord task done` |
| `whoami` / `heartbeat` / `presence` / `claim` / `release` / `locks` / `status` / `poll` | same names under `coord` |
| plugin `acp` (`/acp:join` ...) | plugin `coord` (`/coord:join` ...): `claude plugin uninstall acp@acp-agent-coordination && claude plugin install coord@coord` |
| Python `coord` (`coord.py`) | TS `coord` (`clients/ts`) — same commands, output and config files |
| `acp-server.service` | removed: `systemctl --user disable --now acp-server` |
| git hooks from `coord install-hooks` | run `coord install-hooks` again (they called `coord.py`) |
| port 1338 (0.2.x-0.3.0) | 1337 again since 0.3.1: set `COORD_SERVER=https://<host>:1337` in each bundle's `env` (or `coord-server --port 1338` to keep the old one) |
| a running `ACP_server.py` | stop it: it holds port 1337 |
| copies of the old skill (`~/.claude/skills/acp-client`, `~/.codex/skills/acp-client`) and Codex's `acp` plugin | delete them (and `codex plugin remove acp@acp-agent-coordination`): agents that load them look for `ACP_client.py` |

Identity bundles, `~/.config/coord/env`, `coord login` state and the server
database are unchanged.

**Renamed `acp-agent-coordination` -> `coord`** (repo, package, marketplace):
GitHub redirects the old URL, but update the remote and the installs:

```sh
git remote set-url origin https://github.com/datamoc/coord.git
# move the checkout to ~/dev/coord, then in it: rm -rf .venv && uv sync   (the venv holds absolute paths)
claude plugin uninstall coord@acp-agent-coordination && claude plugin marketplace remove acp-agent-coordination
claude plugin marketplace add ~/dev/coord && claude plugin install coord@coord
codex plugin remove coord@acp-agent-coordination && codex plugin marketplace remove acp-agent-coordination
codex plugin marketplace add ~/dev/coord && codex plugin add coord@coord
```

The repo's project id becomes `github.com/datamoc/coord`: coord history
recorded under the old id stays there (`coord projects` shows both).
Systemd unit / logon task: re-install them from the new path. A checkout with unpushed 0.2 commits has diverged
from 0.3: keep them on a branch (`git branch acp-0.2-local`), then
`git reset --hard origin/master`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| uv: `Failed to parse pyproject.toml ... system-certs = true` | uv < 0.11 | `uv self update`; "only available for ... standalone installation" = an older uv (pip, Chocolatey) is first on PATH: remove it |
| `coord-admin: openssl failed: Can't open "C:\Craft\...\openssl.cnf"`, or exit `0xc0000005` | an app's openssl (KDiff3 ...) | `coord-admin` now prefers Git's openssl on Windows; otherwise set `COORD_OPENSSL=<path to openssl.exe>` |
| `Cannot find module ...\clients\ts\dist\cli.js` | the TS client was not built | point `coord` at `plugins/coord/client/cli.js` (always built), or `npm ci && npm run build` in `clients/ts` |
| `local_unavailable` | no identity found (no `COORD_SERVER`) and no `coord-local` | enroll an identity (`coord-admin enroll <name>`); in a sandboxed agent, see [Codex](#codex) |
| `cannot read ...\env (permission denied)` | a sandbox account cannot read the identity | [Codex](#codex), step 1 |
| `unreachable` | `coord-server` is not running | `systemctl --user start coord-server`; Windows: `Start-ScheduledTask coord-server`, or `.venv\Scripts\coord-server.exe --pki pki` |
| Codex runs `ACP_client.py` | an old `acp-client` skill | see the last rows of [Migrating](#migrating-from-02x) |
| a project named like `mwg-pixel-dungeon` beside `github.com/org/mwg-pixel-dungeon` | an agent passed `--project` (its sandbox git refused the checkout: "dubious ownership") | the client now reads `.git/config` itself and the server refuses such names; merge the stray one: `coord-db merge-project mwg-pixel-dungeon github.com/org/mwg-pixel-dungeon --apply` |
| requests fail, the server says nothing | requests are not logged by default | `coord-server -v` logs one line per request (client, op, status, identity, time); `-vv` adds auth decisions, op arguments and error details; `-q` keeps errors only |

## GitLab (internal)

- **CI**: `.gitlab-ci.yml` (Python server + TS client, same Python 3.11-3.14
  matrix as GitHub; macOS is GitHub-only). CI variables: `UV_IMAGE_PREFIX`
  (mirror of the uv image, PY_VERSION appended), `CORPORATE_CA_PEM` (File,
  TLS-inspecting proxy), `UV_INDEX_URL`, `WINDOWS_RUNNER_TAG`.
- **glab**: the GitLab CLI for agents (issues, MRs, CI) — it acts as the
  person who ran `glab auth login --hostname <host>`.
- **python-gitlab**: optional extra (`uv sync --extra gitlab`).

## Development

```sh
uv sync --group dev                   # adds ruff and pyright (dev-only: the server itself stays stdlib-only)
uv run tools/gen_schema.py            # after changing an op signature (CI checks with --check)
uv run tools/agent_plugins.py gen     # after editing plugins/coord/claude-commands (CI checks with --check)
uv run ruff check coordination tools  # lint (T25); pyproject.toml's [tool.ruff] has the exceptions and why
uv run pyright coordination tools     # types (T25); [tool.pyright] checks every supported platform's stdlib
uv run test_coord.py                  # server, PKI, renewal, OIDC, cert sources, A2A binding
cd clients/ts && npm test             # TS client against the real Python server (+ @a2a-js/sdk interop);
                                       # tsc --strict runs as part of the build this invokes
npm run bundle-plugin                 # refresh plugins/coord/client (CI fails if stale)
uv run tools/release.py 0.14.0 --title "..." --dry-run   # release: build, checksum, tag, publish (T106)
```

What may be added to the contract and what may not - optional arguments, why a new capability is a
new op, the two-release deprecation window, and what 1.0 promises about N-1 clients, error codes
and older databases - is in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

What a load run looks like, and which number is SQLite's fault, is in
[docs/LOAD-TEST.md](docs/LOAD-TEST.md) (`uv run tools/load_test.py`).

## Licence

coord is free software: the server, the TypeScript client and this
repository are licensed under the GNU Affero General Public License v3
(AGPL-3.0-only) - see [LICENSE](LICENSE). If you run a modified server
where others can reach it over the network, share your modified sources
with them.
