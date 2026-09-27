"""coord core: schema, constants, helpers and the database plumbing every topic module uses.

One SQLite file, every mutation under BEGIN IMMEDIATE.

Identity is the session UUID, never the display name: a recycled name gets a
new session_id and a higher generation, so it cannot touch the old claims.
"""

import json
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

SESSION_TTL = 1800
CLAIM_TTL = 7200
WAKE_KEEPALIVE = 1500        # poll again within 25 min: the session dies after 30
CLAIM_RENEW_MARGIN = 600     # wake 10 min before a claim expires
WAKE_UNANSWERED = 900        # an unresolved question/warning older than 15 min becomes a wake-now hint
MSG_RECOMMENDED = 300
MSG_MAX = 10000
INBOX_DEFAULT = 20

MESSAGE_KINDS = ("info", "question", "advice", "proposal", "decision", "review", "warning", "done")
# Priority sets attention, not authority: high/urgent ask for a quick look and an acknowledgement,
# never that the content be accepted.
MESSAGE_PRIORITIES = ("low", "normal", "high", "urgent")
# What a recipient did with a directed message. `delivered` is technical (poll/inbox returned it) and
# proves nothing about understanding; `answered` is set by a reply in the thread; the rest are explicit
# acts of the recipient (`coord ack`). A work request ends `done` (or `declined`, with the reason).
RECEIPT_STATES = ("delivered", "read", "taken", "answered", "done", "declined")
ACK_STATES = ("read", "taken", "done", "declined")
# Contact policies (attention is a resource): who may send someone a direct message.
CONTACT_POLICIES = ("open", "auto", "contacts_only", "block_all")
ROLES = ("advisor", "reviewer", "coeditor", "delegate")
# Project permissions: a roster row makes a project restricted; each role carries the rights
# below (view < participate < decide < admin). Without a roster the project is open and keeps
# the behaviour it always had: everyone may view, participate and decide. The Keycloak mapping
# (`coord:<project>:<role>` groups) and the project_members table share this vocabulary.
PROJECT_ROLES = {"viewer": 0, "contributor": 1, "decider": 2, "admin": 3}
ROLE_RIGHTS = {"viewer": ("view",),
               "contributor": ("view", "participate"),
               "decider": ("view", "participate", "decide"),
               "admin": ("view", "participate", "decide", "admin")}
STANCES = ("support", "support-with-reservation", "object", "abstain", "need-more-info")
SUPPORTING = ("support", "support-with-reservation")   # both count for consensus; reservations are listed
# How a discussion decides. unanimous / majority / no-objection count heads; weighted counts weights fixed
# when the discussion opens (with a threshold and a quorum of weight); advisory collects opinions and
# binds nobody; owner: a designated person decides, the stances are advice.
CONSENSUS_RULES = ("unanimous", "majority", "no-objection", "weighted", "advisory", "owner")
DEFAULT_QUORUM = 2   # consensus always involves someone besides the decider
DOC_KINDS = ("note", "diagnosis", "plan", "proposal", "decision", "review", "adr")
NOTE_CONTEXTS = ("reflection", "discussion", "meeting", "other")   # what an imported note came from
# `policy`: an organisational rule that is not put to a vote (a security restriction...): only a
# project admin adds or edits one, and no discussion outcome overrides it.
MEMORY_KINDS = ("strategy", "overview", "convention", "architecture", "decision", "pitfall", "glossary", "policy")
TASK_STATUSES = ("open", "offered", "accepted", "done", "cancelled")   # offered: assigned, not yet accepted
# Typed links between tasks (and milestones). Only `blocks` holds a task back (its prerequisite must be
# done, cancelled or the link waived); the others are context the graph shows.
LINK_TYPES = ("blocks", "enables", "related_to", "duplicates", "part_of")
DOC_VISIBILITY = ("project", "private")      # private: the depositor, the named readers, the project admins
# What an imported note (or a message) may propose; each candidate cites its passage and says what it is.
SUGGESTION_TARGETS = ("task", "decision", "memory", "question", "summary")
SUGGESTION_NATURES = ("fact", "hypothesis", "opinion", "decision")   # decision: one already taken elsewhere
# A session's state, apart from its work: a paused agent can still have tasks assigned.
SESSION_STATES = ("active", "idle", "paused", "ended", "unreachable")
IDLE_AFTER = 600             # live but silent for 10 min: idle
# Project settings a project admin may change (`coord setting`), with their allowed values.
SETTINGS = {"wake_auto": ("off", "propose", "request"),   # sleeping agent + ready work: show, or ask it to resume
            "mandate_max_days": None}                     # a number of days, at most MANDATE_MAX
WAKE_REASONS = ("task", "message", "question", "unblocked", "review", "other")
# requested -> delivered (the agent's session saw it, or its wake hook answered) -> woken (the agent
# came back: a poll or a new session of the same identity) -> accepted / refused. failed: the hook failed.
WAKE_STATUSES = ("requested", "delivered", "woken", "accepted", "refused", "failed")
WAKE_MIN_INTERVAL = 600      # at most one wake-up request per agent and reason every 10 min
WAKE_MAX_ATTEMPTS = 3        # then stop and say why: an agent that falls asleep again needs a human
# Crisis authority: a bounded, revocable mandate for a human to break a deadlock.
MANDATE_POWERS = ("decide", "reassign", "release_claims")
MANDATE_MAX = 30 * 86400     # hard cap on a mandate's length; a project may set a lower one
ROLES_BY_CONSENT = ("coeditor", "delegate")   # carry write duties: the grantee must accept them
ROUTINE_STATUSES = ("active", "paused", "retired")
ROUTINE_OUTCOMES = ("ok", "issues", "failed")   # issues/failed also post a warning

# What this server can do - published in whoami, `coord server` (server_info) and the Agent Card.
FEATURES = ("sessions", "messages", "claims", "fences", "roles", "discussions", "consensus", "documents",
            "document-patches", "tasks", "a2a", "push-notifications", "memory", "strategy", "routines",
            "server-info", "wake-hints", "delegation-scopes", "reservations", "superseding", "event-stream", "ui", "task-graph",
            "project-permissions", "note-import", "note-review", "receipts", "priorities", "contact-policies",
            "session-states", "wake-requests", "dashboard", "activity", "weighted-votes", "crisis-authority",
            "policies", "typed-links", "milestones", "resource-claims", "task-human-ack")
# What each release brought agents: announced to every project when the server starts on a newer version.
NEWS = {
    "0.4.0": "one certificate per agent CLI; plugins for Muse, Gemini, Qwen, opencode, Kilo and Crush",
    "0.5.0": "strategy (memory kind, first in context) and routines (recurring work: coord routines)",
    "0.6.0": "the server publishes its version and features (whoami, coord server) and announces upgrades",
    "0.6.1": "Deep Code support (tools/agent_plugins.py install deepcode, with its own certificate)",
    "0.7.0": "wake hints in poll/context (when to look again); support-with-reservation; objections need a "
             "reason; propose --supersedes; delegate a sub-scope; coord-db export/prune/vacuum",
    "0.8.0": "coord-server --ui: a window for humans to follow and join the work; live events over SSE "
             "(GET /events/stream, coord events --follow)",
    "0.8.1": "the coord logo: favicon and header in the UI, on the site and in the README",
    "0.8.2": "the project comes from .git/config when a sandbox git refuses the checkout; whoami refuses "
             "session names as families and bare project names; coord-db merge-project",
    "0.9.0": "a session is user + CLI + model (michel/claude/sonnet) and whoami resumes it; consensus: a "
             "restarted agent keeps its voice, authors are told when a proposal has consensus, decide takes "
             "P1,P2,P3",
    "0.10.0": "the task graph (task create --after, task link, blocked tasks, unblock notices, tasks --graph) "
              "and a UI in tabs with the graph",
    "0.10.1": "orphaned tasks are reclaimable: when a task's creator and assignee are both gone, any live "
              "session may decline, do or cancel it (with the reason recorded) instead of blocking its "
              "dependents forever",
    "0.11.0": "project permissions: a roster makes a project restricted - coord members, coord member set "
              "<name> --role viewer|contributor|decider|admin (view, participate, decide, administer); "
              "a project with no members stays open exactly as before, and the Keycloak mapping gains decider",
    "0.12.0": "coord doc import <file>: a .txt/.md note lands as a source document pending review, with its "
              "provenance - the original kept as revision 1, sha256 fingerprint, declared author separate "
              "from the depositor, context and AI-assisted flag; nothing inside it runs until validated",
    "0.13.3": "tasks can ask for a human ack: task create --human-ack, closed in one click from "
             "the UI (task ack) - including work no live session can otherwise close",
    "0.13.2": "a session cannot join as another CLI's family (`whoami claude` from Muse is refused) and "
              "Muse/opencode sessions must name their model (`--model spark-1.3`, `luna-6`)",
    "0.13.1": "choices go to coord, not the console (skill, README, agent guide: a decision is a "
              "discussion, never a console prompt), the UI's Discussions tab carries an async chat under "
              "each open discussion, and a reply stays in the parent's discussion; task_update edits a "
              "task's title, description, priority and category; the contract carries its error codes "
              "(bad_arg is now bad_args); docs/COMPATIBILITY.md states the 1.0 promises; installs are "
              "coord-server on PyPI and @datamoc/coord-client on npm",
    "0.13.0": "humans and agents together: one chat (post --to a,b / --group, --priority, links; coord ack, "
              "receipts; contact policies), note review (doc comment, coord candidate add|accept|reject, doc "
              "reviewed, private notes), session states and wake-ups (coord pause, agents, wake request|answer|"
              "hook), governance (weighted/advisory/owner rules, coord weight, policies, crisis mandates with "
              "review), typed links across projects, task waive, milestones with a projection (P50/P85 from the "
              "observed pace, with its assumptions), resource claims (--resource), "
              "coord dashboard, activity, audit - and the UI for all of it",
}
SERVER_NAME = "coord-server"   # sender of the server's own messages (upgrade notices)

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS repos(
    project_id TEXT PRIMARY KEY, provider TEXT, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS project_members(
    project_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
    granted_by TEXT, created_at REAL NOT NULL, PRIMARY KEY(project_id, name));
CREATE TABLE IF NOT EXISTS sessions(
    session_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, family TEXT NOT NULL,
    generation INTEGER NOT NULL, project_id TEXT NOT NULL, principal TEXT,
    status TEXT NOT NULL DEFAULT '', started_at REAL NOT NULL,
    heartbeat_at REAL NOT NULL, ended_at REAL, cursor INTEGER NOT NULL DEFAULT 0, user TEXT, model TEXT);
CREATE INDEX IF NOT EXISTS ix_sessions_name ON sessions(display_name);
CREATE TABLE IF NOT EXISTS messages(
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
    from_session_id TEXT NOT NULL, from_name TEXT NOT NULL,
    to_session_id TEXT, to_name TEXT, thread_id INTEGER, reply_to INTEGER,
    kind TEXT NOT NULL, body TEXT NOT NULL, claim_id INTEGER,
    created_at REAL NOT NULL, resolved_at REAL, resolved_by TEXT, resolution TEXT);
CREATE INDEX IF NOT EXISTS ix_messages_project ON messages(project_id, id);
CREATE INDEX IF NOT EXISTS ix_messages_thread ON messages(thread_id);
CREATE TABLE IF NOT EXISTS claims(
    claim_id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
    owner_session_id TEXT NOT NULL, owner_name TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK(scope_type IN ('exact','tree')), scope TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', claimed_at REAL NOT NULL, expires_at REAL NOT NULL,
    fence INTEGER NOT NULL, release_on_commit INTEGER NOT NULL DEFAULT 0,
    released_at REAL, released_by TEXT);
CREATE INDEX IF NOT EXISTS ix_claims_active ON claims(project_id, released_at);
CREATE TABLE IF NOT EXISTS claim_roles(
    claim_id INTEGER NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
    granted_by TEXT NOT NULL, granted_at REAL NOT NULL, accepted INTEGER NOT NULL DEFAULT 1,
    scope_type TEXT, scope TEXT, PRIMARY KEY(claim_id, session_id, role));
CREATE TABLE IF NOT EXISTS discussions(
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
    created_by TEXT NOT NULL, created_by_name TEXT NOT NULL, topic TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', claim_id INTEGER, message_id INTEGER,
    decision TEXT, consensus INTEGER, decided_by TEXT, decided_at REAL,
    decision_document_id INTEGER, created_at REAL NOT NULL,
    rule TEXT NOT NULL DEFAULT 'unanimous', quorum INTEGER NOT NULL DEFAULT 2,
    decision_reason TEXT, consensus_detail TEXT, deadline REAL);
CREATE TABLE IF NOT EXISTS discussion_participants(
    discussion_id INTEGER NOT NULL, session_id TEXT NOT NULL, name TEXT NOT NULL,
    PRIMARY KEY (discussion_id, session_id));
CREATE TABLE IF NOT EXISTS proposals(
    id INTEGER PRIMARY KEY AUTOINCREMENT, discussion_id INTEGER NOT NULL,
    author_session_id TEXT NOT NULL, author_name TEXT NOT NULL, body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', created_at REAL NOT NULL, supersedes_id INTEGER);
CREATE TABLE IF NOT EXISTS reactions(
    proposal_id INTEGER NOT NULL, author_session_id TEXT NOT NULL,
    author_name TEXT NOT NULL, stance TEXT NOT NULL, comment TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL, PRIMARY KEY(proposal_id, author_session_id));
CREATE TABLE IF NOT EXISTS documents(
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, title TEXT NOT NULL,
    kind TEXT NOT NULL, created_by TEXT NOT NULL, revision INTEGER NOT NULL,
    content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
    created_at REAL NOT NULL, updated_at REAL NOT NULL,
    origin TEXT, fingerprint TEXT, author_name TEXT, ai_assisted INTEGER,
    context TEXT, source TEXT);
CREATE TABLE IF NOT EXISTS document_revisions(
    document_id INTEGER NOT NULL, revision INTEGER NOT NULL,
    author_session_id TEXT NOT NULL, author_name TEXT NOT NULL,
    content TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL,
    PRIMARY KEY(document_id, revision));
CREATE TABLE IF NOT EXISTS events(
    event_id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
    kind TEXT NOT NULL, actor_session_id TEXT, entity_type TEXT, entity_id TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}', created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS project_memory(
    memory_id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
    kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
    revision INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS memory_revisions(
    memory_id INTEGER NOT NULL, revision INTEGER NOT NULL, content TEXT NOT NULL,
    author TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY(memory_id, revision));
CREATE TABLE IF NOT EXISTS tasks(
    task_id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
    created_by TEXT NOT NULL, assigned_to TEXT, assigned_name TEXT,
    title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open', priority INTEGER NOT NULL DEFAULT 0,
    related_claim_id INTEGER, discussion_id INTEGER, category TEXT, note TEXT,
    created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS task_deps(
    task_id INTEGER NOT NULL, after_id INTEGER NOT NULL, PRIMARY KEY(task_id, after_id));
CREATE TABLE IF NOT EXISTS task_push(
    config_id TEXT PRIMARY KEY, task_id INTEGER NOT NULL, url TEXT NOT NULL, token TEXT,
    auth_scheme TEXT, auth_credentials TEXT, principal TEXT, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS agent_profiles(
    session_id TEXT PRIMARY KEY, provider TEXT, model_id TEXT, model_family TEXT,
    category TEXT, reasoning_level TEXT, capabilities_json TEXT NOT NULL DEFAULT '[]',
    updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS routines(
    routine_id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, title TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '', every REAL, on_commit INTEGER NOT NULL DEFAULT 0,
    paths TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', created_by TEXT NOT NULL,
    pending INTEGER NOT NULL DEFAULT 1, pending_reason TEXT,
    runner_session_id TEXT, runner_name TEXT, run_expires REAL,
    last_run_at REAL, last_run_by TEXT, last_outcome TEXT, last_result TEXT,
    created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS routine_runs(
    routine_id INTEGER NOT NULL, run INTEGER NOT NULL, session_id TEXT NOT NULL, name TEXT NOT NULL,
    trigger TEXT, started_at REAL NOT NULL, finished_at REAL, outcome TEXT, result TEXT,
    PRIMARY KEY(routine_id, run));
CREATE TABLE IF NOT EXISTS message_recipients(
    message_id INTEGER NOT NULL, session_id TEXT NOT NULL, name TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'sent', delivered_at REAL, read_at REAL, taken_at REAL,
    answered_at REAL, done_at REAL, note TEXT, PRIMARY KEY(message_id, session_id));
CREATE INDEX IF NOT EXISTS ix_recipients_session ON message_recipients(session_id, state);
CREATE TABLE IF NOT EXISTS contact_policies(
    project_id TEXT NOT NULL, name TEXT NOT NULL, policy TEXT NOT NULL, set_at REAL NOT NULL,
    PRIMARY KEY(project_id, name));
CREATE TABLE IF NOT EXISTS contacts(
    project_id TEXT NOT NULL, name TEXT NOT NULL, peer TEXT NOT NULL, status TEXT NOT NULL,
    created_at REAL NOT NULL, PRIMARY KEY(project_id, name, peer));
CREATE TABLE IF NOT EXISTS document_comments(
    id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL, revision INTEGER NOT NULL,
    author_session_id TEXT NOT NULL, author_name TEXT NOT NULL, quote TEXT, body TEXT NOT NULL,
    created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS suggestions(
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
    source_type TEXT NOT NULL, source_id INTEGER NOT NULL, source_revision INTEGER,
    quote TEXT NOT NULL, nature TEXT NOT NULL, target TEXT NOT NULL, title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '', memory_kind TEXT, status TEXT NOT NULL DEFAULT 'proposed',
    proposed_by TEXT NOT NULL, reviewed_by TEXT, review_note TEXT, result TEXT,
    created_at REAL NOT NULL, reviewed_at REAL);
CREATE TABLE IF NOT EXISTS project_settings(
    project_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, set_by TEXT, set_at REAL NOT NULL,
    PRIMARY KEY(project_id, key));
CREATE TABLE IF NOT EXISTS project_weights(
    project_id TEXT NOT NULL, name TEXT NOT NULL, domain TEXT NOT NULL DEFAULT '', weight REAL NOT NULL,
    set_by TEXT, set_at REAL NOT NULL, PRIMARY KEY(project_id, name, domain));
CREATE TABLE IF NOT EXISTS mandates(
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, holder TEXT NOT NULL,
    granted_by TEXT NOT NULL, reason TEXT NOT NULL, scope TEXT NOT NULL, powers TEXT NOT NULL,
    starts_at REAL NOT NULL, expires_at REAL NOT NULL, revoked_at REAL, revoked_by TEXT,
    revoke_reason TEXT, review_discussion_id INTEGER, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS wake_requests(
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, target_name TEXT NOT NULL,
    target_session_id TEXT, reason TEXT NOT NULL, ref TEXT, note TEXT NOT NULL DEFAULT '',
    requested_by TEXT NOT NULL, auto INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'requested',
    mechanism TEXT NOT NULL DEFAULT 'manual', diagnostic TEXT, response TEXT, created_at REAL NOT NULL,
    delivered_at REAL, woken_at REAL, answered_at REAL);
CREATE TABLE IF NOT EXISTS wake_hooks(
    project_id TEXT NOT NULL, target TEXT NOT NULL, url TEXT NOT NULL, token TEXT,
    created_by TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY(project_id, target));
CREATE TABLE IF NOT EXISTS task_links(
    task_id INTEGER NOT NULL, other_id INTEGER NOT NULL, type TEXT NOT NULL, reason TEXT,
    created_by TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY(task_id, other_id, type));
CREATE TABLE IF NOT EXISTS milestone_criteria(
    milestone_id INTEGER NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL,
    met_at REAL, met_by TEXT, note TEXT, PRIMARY KEY(milestone_id, idx));
CREATE TABLE IF NOT EXISTS milestone_targets(
    milestone_id INTEGER NOT NULL, rev INTEGER NOT NULL, target_at REAL, reason TEXT NOT NULL,
    set_by TEXT NOT NULL, set_at REAL NOT NULL, PRIMARY KEY(milestone_id, rev));
CREATE TABLE IF NOT EXISTS idempotency(
    client_id TEXT PRIMARY KEY, op TEXT NOT NULL, result_json TEXT NOT NULL,
    created_at REAL NOT NULL);
"""

PREFIX = {"claim": "C", "discussion": "D", "proposal": "P", "document": "DOC",
          "task": "T", "memory": "M", "message": "#", "routine": "R", "suggestion": "S",
          "wake": "W", "mandate": "A", "comment": "K"}


class CoordError(Exception):
    def __init__(self, code: str, message: str, data: dict | None = None):
        super().__init__(message)
        self.code = code
        self.data = data or {}


def iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, UTC).isoformat(timespec="seconds")


def server_version() -> str:
    try:
        from importlib.metadata import version
        return version("coord")
    except Exception:
        return "0"


def version_key(v: str) -> tuple[int, ...]:
    """"0.10.1" -> (0, 10, 1); anything unparsable sorts first."""
    try:
        return tuple(int(x) for x in v.split("."))
    except ValueError:
        return ()


def parse_when(value: str, now: float) -> float:
    """A deadline: "90m", "48h", "3d", "30s" from now, or an ISO 8601 date/time (UTC if no zone)."""
    v = str(value).strip()
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([smhd])", v)
    if m:
        return now + float(m.group(1)) * {"s": 1, "m": 60, "h": 3600, "d": 86400}[m.group(2)]
    try:
        t = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError as e:
        raise CoordError("bad_deadline", f"deadline {v!r}: use 90m, 48h, 3d or an ISO date like 2026-10-01T12:00Z") from e
    return (t if t.tzinfo else t.replace(tzinfo=UTC)).timestamp()


def parse_id(kind: str, value) -> int:
    s = str(value).strip().upper()
    p = PREFIX[kind]
    if s.startswith(p):
        s = s[len(p):]
    if not s.isdigit():
        raise CoordError("bad_id", f"expected a {kind} id like {p}12, got {value!r}")
    return int(s)


class CoordBase:
    def __init__(self, path=None, clock=time.time, case_insensitive: bool | None = None):
        self.path = Path(path or os.environ.get("COORD_DB") or Path.cwd() / "coord2.db")
        self.clock = clock
        self.case_insensitive = case_insensitive
        with self._connect() as db:
            db.executescript(SCHEMA)
            db.execute("INSERT OR IGNORE INTO meta VALUES('schema_version','2')")
            self._migrate(db)
            db.execute("INSERT OR IGNORE INTO meta VALUES('fence','0')")

    # --- plumbing -------------------------------------------------------
    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA busy_timeout=30000")
        return db

    @contextmanager
    def _tx(self):
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.execute("COMMIT")
        except BaseException:
            db.execute("ROLLBACK")
            raise
        finally:
            db.close()

    @contextmanager
    def _read(self):
        db = self._connect()
        try:
            db.execute("BEGIN")
            yield db
            db.execute("COMMIT")
        finally:
            db.close()

    def _mutate(self, op: str, client_id: str | None, fn):
        with self._tx() as db:
            if client_id:
                row = db.execute(
                    "SELECT op, result_json FROM idempotency WHERE client_id=?", (client_id,)
                ).fetchone()
                if row:
                    if row["op"] != op:
                        raise CoordError("idempotency_conflict",
                                         f"client_id {client_id} already used for {row['op']}")
                    result = json.loads(row["result_json"])
                    result["replayed"] = True
                    return result
            result = fn(db)
            if client_id:
                db.execute("INSERT INTO idempotency VALUES(?,?,?,?)",
                           (client_id, op, json.dumps(result), self.clock()))
            return result

    def _event(self, db, project, event_kind, actor, etype=None, eid=None, **payload):
        db.execute(
            "INSERT INTO events(project_id, kind, actor_session_id, entity_type, entity_id,"
            " payload_json, created_at) VALUES(?,?,?,?,?,?,?)",
            (project, event_kind, actor, etype, None if eid is None else str(eid),
             json.dumps(payload), self.clock()),
        )

    def _next_fence(self, db) -> int:
        db.execute("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key='fence'")
        return int(db.execute("SELECT value FROM meta WHERE key='fence'").fetchone()[0])

    def _live(self, row) -> bool:
        return row["ended_at"] is None and row["heartbeat_at"] >= self.clock() - SESSION_TTL

    def _session(self, db, session_id) -> sqlite3.Row:
        if not session_id:
            raise CoordError("no_session", "no session: run `coord whoami <family>` first")
        row = db.execute("SELECT * FROM sessions WHERE session_id=?", (session_id,)).fetchone()
        if row is None:
            raise CoordError("unknown_session", f"unknown session {session_id}")
        if not self._live(row):
            raise CoordError("dead_session",
                             f"session {row['display_name']} (gen {row['generation']}) has "
                             "ended or expired; run `coord whoami` again")
        return row

    # --- project permissions: view / participate / decide / admin -------------------------
    def _roster(self, db, project) -> list[sqlite3.Row]:
        """The membership rows that restrict `project`: empty means open (the historic behaviour)."""
        return db.execute("SELECT name, role FROM project_members WHERE project_id=?"
                          " ORDER BY created_at, name", (project,)).fetchall()

    def _access(self, db, session_id, project, right: str | None = None):
        """(me, project) after enforcing `right` for this caller; `project` defaults to the
        caller's own. `right=None` just resolves the pair. An open project (no roster) allows
        everything, exactly as before the roster existed."""
        me = self._session(db, session_id)
        project = project or me["project_id"]
        if right is None:
            return me, project
        roster = self._roster(db, project)
        if not roster:
            return me, project
        role = next((r["role"] for r in roster if r["name"] == me["display_name"]), None)
        if right == "decide" and self._mandate(db, project, me["display_name"], "decide") is not None:
            return me, project                       # crisis authority: bounded, audited, see governance.py
        if role is None:
            admins = [r["name"] for r in roster if r["role"] == "admin"]
            raise CoordError("forbidden",
                             f"project '{project}' is restricted and {me['display_name']} is not a "
                             f"member; ask an admin ({', '.join(admins) or 'none'}) to add you",
                             {"project": project, "required": right})
        if right not in ROLE_RIGHTS[role]:
            raise CoordError("forbidden", f"role '{role}' may not {right} in project '{project}'",
                             {"project": project, "role": role, "required": right})
        return me, project

    def _view(self, db, project, session) -> None:
        """Read gate for an explicit project: an open one reads without any session (as before),
        a restricted one only through a live roster session (every role carries view)."""
        if not self._roster(db, project):
            return
        if not session:
            raise CoordError("forbidden", f"project '{project}' is restricted: pass your session "
                             "to read it", {"project": project, "required": "view"})
        self._access(db, session, project, "view")

    def _view_filter(self, db, session) -> tuple[str, tuple]:
        """SQL predicate for list reads that span projects: open projects always, a restricted
        one only when `session` is on its roster (no session = open projects only)."""
        if session:
            me = self._session(db, session)
            return ("(project_id NOT IN (SELECT project_id FROM project_members) OR"
                    " project_id IN (SELECT project_id FROM project_members WHERE name=?))",
                    (me["display_name"],))
        return ("project_id NOT IN (SELECT project_id FROM project_members)", ())

    # Columns added after a table first shipped: (table, column, DDL). Existing databases get them
    # on open; CREATE TABLE above already has them for new ones.
    _MIGRATIONS = (
        ("discussions", "rule", "TEXT NOT NULL DEFAULT 'unanimous'"),
        ("discussions", "quorum", "INTEGER NOT NULL DEFAULT 2"),
        ("discussions", "decision_reason", "TEXT"),
        ("discussions", "consensus_detail", "TEXT"),
        ("discussions", "deadline", "REAL"),
        ("claim_roles", "accepted", "INTEGER NOT NULL DEFAULT 1"),   # grants made before stay in effect
        ("claim_roles", "scope_type", "TEXT"),                       # a delegate's sub-scope (NULL: the whole claim)
        ("claim_roles", "scope", "TEXT"),
        ("proposals", "supersedes_id", "INTEGER"),
        ("sessions", "user", "TEXT"),                                # the association user + CLI + model
        ("sessions", "model", "TEXT"),
        # imported notes (0.12): provenance kept beside the content, NULL for documents created in coord
        ("documents", "origin", "TEXT"),                             # 'import' | NULL
        ("documents", "fingerprint", "TEXT"),                        # sha256 of the deposited original
        ("documents", "author_name", "TEXT"),                        # declared author, NULL = the depositor
        ("documents", "ai_assisted", "INTEGER"),                     # 1/0, NULL = not stated
        ("documents", "context", "TEXT"),                            # reflection | discussion | meeting | other
        ("documents", "source", "TEXT"),                             # where the file came from
        ("documents", "written_at", "REAL"),                         # when the note was written (declared)
        ("documents", "visibility", "TEXT"),                         # NULL/'project' | 'private'
        ("documents", "readers", "TEXT"),                            # JSON names, for private notes
        # the unified chat (0.13): priority, several recipients, links to the structured objects
        ("messages", "priority", "TEXT NOT NULL DEFAULT 'normal'"),
        ("messages", "listed", "INTEGER NOT NULL DEFAULT 0"),        # 1: only its recipients (and sender) see it
        ("messages", "task_id", "INTEGER"),
        ("messages", "document_id", "INTEGER"),
        ("messages", "discussion_id", "INTEGER"),
        # human participants and paused agents
        ("sessions", "kind", "TEXT NOT NULL DEFAULT 'agent'"),       # 'agent' | 'human'
        ("sessions", "paused_at", "REAL"),
        ("sessions", "pause_reason", "TEXT"),
        ("sessions", "end_reason", "TEXT"),                          # 'ended' (by itself) | 'expired' (reaped)
        # governance: weights fixed when the discussion opens, designated owner, crisis decisions
        ("discussion_participants", "weight", "REAL NOT NULL DEFAULT 1"),
        ("discussions", "threshold", "REAL"),
        ("discussions", "quorum_weight", "REAL"),
        ("discussions", "owner_name", "TEXT"),
        ("discussions", "domain", "TEXT"),
        ("discussions", "mandate_id", "INTEGER"),                    # decided under crisis authority
        # the task graph: blocking links carry a condition and can be waived; milestones are tasks
        ("task_deps", "condition", "TEXT"),
        ("task_deps", "reason", "TEXT"),
        ("task_deps", "waived_at", "REAL"),
        ("task_deps", "waived_by", "TEXT"),
        ("task_deps", "waive_reason", "TEXT"),
        ("tasks", "kind", "TEXT NOT NULL DEFAULT 'task'"),           # 'task' | 'milestone'
        ("tasks", "target_at", "REAL"),
        ("tasks", "reached_at", "REAL"),
        ("tasks", "owner", "TEXT"),
        ("tasks", "suggestion_id", "INTEGER"),                       # promoted from a candidate (provenance)
        ("tasks", "human_ack", "INTEGER NOT NULL DEFAULT 0"),         # created with --human-ack: a human closes it
        ("claims", "resource", "TEXT"),                              # NULL: a file scope; else gpu, build, port...
    )

    @classmethod
    def _migrate(cls, db) -> None:
        # `requests` (planned in v2, replaced by tasks) was never used: drop it - only if empty
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='requests'").fetchone() \
                and db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 0:
            db.execute("DROP TABLE requests")
        for table, column, ddl in cls._MIGRATIONS:
            have = {r[1] for r in db.execute(f"PRAGMA table_info({table})")}
            if column not in have:
                db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")

    def _mandate(self, db, project: str, name: str, power: str):
        """The active crisis mandate giving `name` this power in `project`, or None."""
        now = self.clock()
        for m in db.execute("SELECT * FROM mandates WHERE project_id=? AND holder=? AND revoked_at IS NULL"
                            " AND starts_at<=? AND expires_at>? ORDER BY id", (project, name, now, now)):
            if power in json.loads(m["powers"]):
                return m
        return None

    def _session_state(self, row) -> str:
        """active | idle | paused | ended | unreachable - the session, apart from its work."""
        now = self.clock()
        if row["ended_at"] is not None:
            return "unreachable" if row["end_reason"] == "expired" else "ended"
        if row["heartbeat_at"] < now - SESSION_TTL:
            return "unreachable"
        if row["paused_at"] is not None:
            return "paused"
        return "idle" if row["heartbeat_at"] < now - IDLE_AFTER else "active"

    def _setting(self, db, project: str, key: str, default=None):
        row = db.execute("SELECT value FROM project_settings WHERE project_id=? AND key=?", (project, key)).fetchone()
        return default if row is None else json.loads(row["value"])

    def _is_human(self, db, name: str) -> bool:
        """A name is a human's when a session under it said so (the UI, `whoami --human`, a ui:/oidc principal)."""
        return db.execute("SELECT 1 FROM sessions WHERE display_name=? AND kind='human' LIMIT 1",
                          (name,)).fetchone() is not None

    def _notify(self, db, sender, to_session_id: str | None, body: str, kind: str = "info",
                claim_id: int | None = None) -> int | None:
        """A direct message written in the caller's transaction (invitations, offers, decisions).
        `sender` is a sessions row; a recipient that is gone (None / unknown) is skipped."""
        to = db.execute("SELECT * FROM sessions WHERE session_id=?", (to_session_id,)).fetchone() if to_session_id else None
        if to is None or to["session_id"] == sender["session_id"]:
            return None
        return db.execute(
            "INSERT INTO messages(project_id, from_session_id, from_name, to_session_id, to_name, kind, body,"
            " claim_id, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (sender["project_id"], sender["session_id"], sender["display_name"], to["session_id"],
             to["display_name"], kind, body, claim_id, self.clock())).lastrowid

    def _live_by_name(self, db, name: str | None):
        """The live session currently holding a display name, or None."""
        if not name:
            return None
        return db.execute("SELECT * FROM sessions WHERE display_name=? AND ended_at IS NULL AND heartbeat_at>=?"
                          " ORDER BY generation DESC LIMIT 1", (name, self.clock() - SESSION_TTL)).fetchone()

    def _resolve_name(self, db, name: str, project: str) -> sqlite3.Row:
        cutoff = self.clock() - SESSION_TTL
        row = db.execute(
            "SELECT * FROM sessions WHERE display_name=? AND ended_at IS NULL AND heartbeat_at>=?"
            " ORDER BY generation DESC LIMIT 1", (name, cutoff)).fetchone()
        if row is None:
            raise CoordError("unknown_recipient", f"no live session named {name}")
        return row

    def _reap(self, db) -> None:
        """End sessions past their TTL and release what they held."""
        now = self.clock()
        dead = [r[0] for r in db.execute(
            "SELECT session_id FROM sessions WHERE ended_at IS NULL AND heartbeat_at<?", (now - SESSION_TTL,))]
        for sid in dead:
            db.execute("UPDATE sessions SET ended_at=?, end_reason='expired' WHERE session_id=?", (now, sid))
        db.execute("UPDATE claims SET released_at=?, released_by='reaper' WHERE released_at IS NULL AND"
                   " owner_session_id IN (SELECT session_id FROM sessions WHERE ended_at IS NOT NULL)", (now,))

    _LIVE_OWNER = (" AND owner_session_id IN (SELECT session_id FROM sessions WHERE ended_at IS NULL"
                   " AND heartbeat_at>=?)")

    if TYPE_CHECKING:
        # Every mixin combines into Coord (service.py) and calls one another's methods across mixin
        # boundaries; these declarations let pyright see that surface from any single mixin file
        # without a real cross-import. Never executed: at runtime the real implementations (defined
        # on the mixins themselves) are what's actually called.
        def post(self, *a, **k) -> dict: ...
        def locks(self, *a, **k) -> list: ...
        def tasks(self, *a, **k) -> list: ...
        def discussions(self, *a, **k) -> list: ...
        def routines(self, *a, **k) -> list: ...
        def wake(self, *a, **k) -> dict: ...
        def memory(self, *a, **k) -> list: ...
        def presence(self, *a, **k) -> list: ...
        def _norm(self, *a, **k) -> tuple: ...
        def _routines_on_commit(self, *a, **k) -> list: ...
        def _doc_insert(self, *a, **k) -> int: ...
        def _awake(self, *a, **k) -> None: ...
        def _awaiting(self, *a, **k) -> list: ...
        def _visible(self, *a, **k) -> tuple: ...
        def _blocked_by(self, *a, **k) -> list: ...
        def _auto_wake(self, *a, **k) -> None: ...
        def _suggestion_source(self, *a, **k) -> str: ...
        def _discussion_open(self, *a, **k) -> dict: ...
        def _memory_insert(self, *a, **k) -> int: ...
        def _doc_gate(self, *a, **k) -> None: ...
        def _doc_readable(self, *a, **k) -> bool: ...
        def _sweep_mandates(self, *a, **k) -> None: ...
        def wake_requests(self, *a, **k) -> list: ...
        def agents(self, *a, **k) -> list: ...
        def projects(self, *a, **k) -> list: ...
        def unblock_points(self, *a, **k) -> list: ...
        def milestones(self, *a, **k) -> list: ...
        def discussion(self, *a, **k) -> dict: ...
