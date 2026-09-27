"""Tasks, the task graph and milestones; tasks' A2A push-notification configs.

The graph: typed, directed links between tasks. `blocks` (task_deps) is the only kind that holds a
task back - it may carry a verifiable condition and can be waived explicitly, with a reason; enables,
related_to, duplicates and part_of (task_links) are context. Links may cross projects when the caller
may see both. A task is `ready` when every blocking prerequisite is done, cancelled or waived.

A milestone is a task of kind `milestone`: a verifiable result with acceptance criteria, an owner, a
target date whose revisions are kept with their reasons, and the date it was actually reached."""

import random
import uuid

from .core import LINK_TYPES, CoordBase, CoordError, iso, parse_id, parse_when

RESOLVED = ("done", "cancelled")      # a prerequisite in one of these no longer blocks
RECENT = 86400                        # "unblocked recently": within a day
# Milestone projection: only with enough history, never as a percentage of completion.
PROJECTION_WINDOW = 28                # days of history the throughput is read from
PROJECTION_MIN_DONE = 5               # fewer tasks done than this in the window: no projection
PROJECTION_MIN_DAYS = 3               # nor with less than this much history
PROJECTION_RUNS = 1000                # Monte Carlo runs
PROJECTION_HORIZON = 3650             # days: beyond this, "not at this pace"


class TasksMixin(CoordBase):
    # --- the task graph: T3 after T1, T2 ---------------------------------------
    def _deps(self, db, tid: int) -> list[int]:
        return [r[0] for r in db.execute("SELECT after_id FROM task_deps WHERE task_id=? ORDER BY after_id", (tid,))]

    def _blocked_by(self, db, tid: int) -> list[int]:
        return [r[0] for r in db.execute("SELECT d.after_id FROM task_deps d JOIN tasks t ON t.task_id=d.after_id"
                                         " WHERE d.task_id=? AND t.status NOT IN ('done','cancelled')"
                                         " AND d.waived_at IS NULL ORDER BY d.after_id", (tid,))]

    def _task_row(self, db, task):
        tid = parse_id("task", task)
        t = db.execute("SELECT * FROM tasks WHERE task_id=?", (tid,)).fetchone()
        if t is None:
            raise CoordError("missing", f"no task T{tid}")
        return t

    def _other_end(self, db, session: str | None, project: str, other: str):
        """The far end of a link: same project, or another one this caller may view (the permissions
        and visibility of every project touched keep applying)."""
        row = self._task_row(db, other)
        if row["project_id"] != project:
            if not session:
                raise CoordError("bad_args", f"T{row['task_id']} is in another project")
            self._access(db, session, row["project_id"], "view")
        return row

    def _link(self, db, project: str, tid: int, after: list[str], session: str | None = None,
              condition: str | None = None, reason: str | None = None, by: str = "") -> list[int]:
        """Add blocking prerequisites to a task: no self-loop, no cycle; another project only if visible."""
        added = []
        for a in after:
            aid = self._other_end(db, session, project, a)["task_id"]
            if aid == tid or tid in self._ancestors(db, aid):
                raise CoordError("cycle", f"T{tid} after T{aid} would make a cycle")
            db.execute("INSERT OR IGNORE INTO task_deps(task_id, after_id, condition, reason) VALUES(?,?,?,?)",
                       (tid, aid, condition or None, reason or None))
            added.append(aid)
        return added

    def _ancestors(self, db, tid: int) -> set[int]:
        seen, todo = set(), [tid]
        while todo:
            for dep in self._deps(db, todo.pop()):
                if dep not in seen:
                    seen.add(dep); todo.append(dep)
        return seen

    def _descendants(self, db, tid: int) -> set[int]:
        seen, todo = set(), [tid]
        while todo:
            for (dep,) in db.execute("SELECT task_id FROM task_deps WHERE after_id=?", (todo.pop(),)).fetchall():
                if dep not in seen:
                    seen.add(dep); todo.append(dep)
        return seen

    def _task_orphaned(self, db, t) -> bool:
        """Neither the assignee nor the creator has a live session - nobody with standing over T{id}
        is around to close it themselves, so any live session may (a stale/superseded task would
        otherwise block its dependents forever)."""
        if t["assigned_to"]:
            row = db.execute("SELECT * FROM sessions WHERE session_id=?", (t["assigned_to"],)).fetchone()
            if row is not None and self._live(row):
                return False
        return self._live_by_name(db, t["created_by"]) is None

    def _unblock_dependents(self, db, me, tid: int) -> None:
        """T{tid} just finished (or its link was waived): tell whoever waits on a task that now has
        nothing left before it; with the project's wake_auto rule, a sleeping assignee is asked to resume."""
        for (dep,) in db.execute("SELECT task_id FROM task_deps WHERE after_id=?", (tid,)).fetchall():
            t = db.execute("SELECT * FROM tasks WHERE task_id=?", (dep,)).fetchone()
            if t is None or t["status"] in RESOLVED or self._blocked_by(db, dep):
                continue
            target = t["assigned_to"] or (self._live_by_name(db, t["created_by"]) or {"session_id": None})["session_id"]
            self._notify(db, me, target, f"[T{dep}] unblocked - everything before it is finished: {t['title']}",
                         kind="info")
            self._event(db, t["project_id"], "task.unblocked", me["session_id"], "task", dep)
            if t["kind"] != "milestone":
                self._auto_wake(db, me, t["project_id"], t["assigned_name"], "unblocked", f"T{dep}",
                                f"T{dep} is ready: {t['title']}")

    def task_link(self, session: str, task: str, after: list[str], remove: bool = False, type: str = "blocks",
                  condition: str | None = None, reason: str = "") -> dict:
        """T3 after T1, T2 (type `blocks`): T3 cannot be accepted until they are done, cancelled or the
        link is waived; `condition` says what "done" must mean (a verifiable sentence). Other types record
        context without holding T3 back: T1 enables T3 (useful before it, like a prerequisite), T3
        related_to T1, T3 duplicates T1, T3 part_of T1. The `reason` of an addition or a removal is kept
        in the event history (the UI asks for it)."""
        if type not in LINK_TYPES:
            raise CoordError("bad_args", f"type must be one of {', '.join(LINK_TYPES)}")
        with self._tx() as db:
            t = self._task_row(db, task)
            tid = t["task_id"]
            me, _ = self._access(db, session, t["project_id"], "participate")
            others = [self._other_end(db, session, t["project_id"], a)["task_id"] for a in after]
            if remove:
                for aid in others:
                    if type == "blocks":
                        db.execute("DELETE FROM task_deps WHERE task_id=? AND after_id=?", (tid, aid))
                    else:
                        db.execute("DELETE FROM task_links WHERE task_id=? AND other_id=? AND type=?", (tid, aid, type))
            elif type == "blocks":
                self._link(db, t["project_id"], tid, after, session, condition, reason, me["display_name"])
            else:
                for aid in others:
                    if aid == tid:
                        raise CoordError("cycle", f"T{tid} cannot be linked to itself")
                    if type == "part_of" and tid in self._parts_up(db, aid):
                        raise CoordError("cycle", f"T{tid} part_of T{aid} would make a cycle")
                    db.execute("INSERT OR IGNORE INTO task_links VALUES(?,?,?,?,?,?)",
                               (tid, aid, type, reason or None, me["display_name"], self.clock()))
            self._event(db, t["project_id"], "task.unlinked" if remove else "task.linked", session, "task", tid,
                        type=type, to=[f"T{x}" for x in others], reason=reason or None, condition=condition)
            if remove and type == "blocks" and others and t["status"] not in RESOLVED and not self._blocked_by(db, tid):
                self._ready_notice(db, me, t, f"link removed by {me['display_name']}: {reason}")
            return {"task": f"T{tid}", "type": type, "after": [f"T{x}" for x in self._deps(db, tid)],
                    "blocked_by": [f"T{x}" for x in self._blocked_by(db, tid)],
                    "links": self._typed_links(db, tid)}

    def _ready_notice(self, db, me, t, why: str) -> None:
        target = t["assigned_to"] or (self._live_by_name(db, t["created_by"]) or {"session_id": None})["session_id"]
        self._notify(db, me, target, f"[T{t['task_id']}] ready - {why}")
        self._event(db, t["project_id"], "task.unblocked", me["session_id"], "task", t["task_id"])

    def _parts_up(self, db, tid: int) -> set[int]:
        seen, todo = set(), [tid]
        while todo:
            for (x,) in db.execute("SELECT other_id FROM task_links WHERE task_id=? AND type='part_of'",
                                   (todo.pop(),)).fetchall():
                if x not in seen:
                    seen.add(x); todo.append(x)
        return seen

    def _typed_links(self, db, tid: int) -> list[dict]:
        out = [{"type": r["type"], "to": f"T{r['other_id']}", "reason": r["reason"]}
               for r in db.execute("SELECT * FROM task_links WHERE task_id=? ORDER BY type, other_id", (tid,))]
        out += [{"type": r["type"], "from": f"T{r['task_id']}", "reason": r["reason"]}
                for r in db.execute("SELECT * FROM task_links WHERE other_id=? ORDER BY type, task_id", (tid,))]
        return out

    def task_waive(self, session: str, task: str, after: str, reason: str) -> dict:
        """Lift one blocking prerequisite explicitly (the decider right): T3 no longer waits for T1,
        and the reason is kept on the link. The link itself stays, marked waived."""
        if not reason.strip():
            raise CoordError("reason_required", "waiving a dependency needs its reason")
        with self._tx() as db:
            t = self._task_row(db, task)
            me, _ = self._access(db, session, t["project_id"], "decide")
            aid = parse_id("task", after)
            d = db.execute("SELECT * FROM task_deps WHERE task_id=? AND after_id=?", (t["task_id"], aid)).fetchone()
            if d is None:
                raise CoordError("missing", f"T{t['task_id']} does not wait for T{aid}")
            db.execute("UPDATE task_deps SET waived_at=?, waived_by=?, waive_reason=? WHERE task_id=? AND after_id=?",
                       (self.clock(), me["display_name"], reason, t["task_id"], aid))
            self._event(db, t["project_id"], "task.waived", session, "task", t["task_id"], after=f"T{aid}", reason=reason)
            blocked = self._blocked_by(db, t["task_id"])
            if not blocked and t["status"] not in RESOLVED:
                self._ready_notice(db, me, t, f"T{aid} waived by {me['display_name']}: {reason}")
            return {"task": f"T{t['task_id']}", "waived": f"T{aid}", "blocked_by": [f"T{x}" for x in blocked]}

    def task_create(self, session: str, title: str, description: str = "", priority: int = 0,
                    claim: str | None = None, assign: str | None = None, category: str | None = None,
                    after: list[str] | None = None, client_id: str | None = None,
                    human_ack: bool = False) -> dict:
        def fn(db):
            me, _ = self._access(db, session, None, "participate")
            target = self._resolve_name(db, assign, me["project_id"]) if assign else None
            now = self.clock()
            tid = db.execute("INSERT INTO tasks(project_id, created_by, assigned_to, assigned_name, title,"
                             " description, status, priority, related_claim_id, category, human_ack, created_at,"
                             " updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                             (me["project_id"], me["display_name"], target["session_id"] if target else None,
                              target["display_name"] if target else None, title, description,
                              "offered" if target else "open", int(priority),
                              parse_id("claim", claim) if claim else None, category, 1 if human_ack else 0,
                              now, now)).lastrowid
            self._link(db, me["project_id"], tid, after or [], session)
            if target:   # an offer, not an order: the assignee accepts or declines
                self._notify(db, me, target["session_id"],
                             f"[T{tid}] {me['display_name']} offers you a task: {title} - "
                             f"coord task accept T{tid} / coord task decline T{tid} \"why\"", kind="question")
            self._event(db, me["project_id"], "task.created", session, "task", tid)
            return {"task": f"T{tid}", "id": tid}
        return self._mutate("task_create", client_id, fn)

    def _task_dict(self, db, r) -> dict:
        after, blocked = self._deps(db, r["task_id"]), self._blocked_by(db, r["task_id"])
        d = {"task": f"T{r['task_id']}", "title": r["title"], "status": r["status"], "kind": r["kind"],
             "priority": r["priority"], "assigned": r["assigned_name"], "created_by": r["created_by"],
             "claim": f"C{r['related_claim_id']}" if r["related_claim_id"] else None,
             "category": r["category"], "human_ack": bool(r["human_ack"]),
             "after": [f"T{x}" for x in after],
             "blocked_by": [f"T{x}" for x in blocked], "project": r["project_id"],
             "ready": r["kind"] == "task" and r["status"] in ("open", "offered", "accepted") and not blocked}
        links = self._typed_links(db, r["task_id"])
        if links:
            d["links"] = links
        away = [f"T{x[0]}" for x in db.execute(
            "SELECT t.task_id FROM task_deps d JOIN tasks t ON t.task_id=d.after_id WHERE d.task_id=? AND"
            " t.project_id!=?", (r["task_id"], r["project_id"]))]
        if away:
            d["other_projects"] = away
        if r["kind"] == "milestone":
            d.update(target=iso(r["target_at"]), reached_at=iso(r["reached_at"]), owner=r["owner"])
        return d

    def tasks(self, project: str | None = None, status: str | None = None,
              assigned_session: str | None = None, session: str | None = None, view: str | None = None,
              assigned: str | None = None) -> list[dict]:
        """Tasks (and milestones). `view`: ready (nothing blocks them), blocked, unowned (open, nobody
        assigned), recent (unblocked in the last day), milestones. With a project, its tasks also bring
        the prerequisites they wait for in other projects (when visible), so the graph crosses projects."""
        if view not in (None, "ready", "blocked", "unowned", "recent", "milestones"):
            raise CoordError("bad_args", "view must be ready, blocked, unowned, recent or milestones")
        with self._read() as db:
            q, a = "SELECT * FROM tasks WHERE 1=1", []
            if project:
                self._view(db, project, session)
                q += " AND project_id=?"; a.append(project)
            else:
                f, fargs = self._view_filter(db, session)
                q += f" AND {f}"; a += list(fargs)
            if status:
                q += " AND status=?"; a.append(status)
            if assigned_session:
                q += " AND assigned_to=?"; a.append(assigned_session)
            if assigned:
                q += " AND assigned_name=?"; a.append(assigned)
            rows = db.execute(q + " ORDER BY priority DESC, task_id", a).fetchall()
            out = [self._task_dict(db, r) for r in rows]
            if project and not status and not view and not assigned_session and not assigned:
                have = {t["task"] for t in out}
                f, fargs = self._view_filter(db, session)
                for t in list(out):
                    for x in t.get("other_projects", []):
                        if x in have:
                            continue
                        r = db.execute(f"SELECT * FROM tasks WHERE task_id=? AND {f}", (parse_id("task", x), *fargs)).fetchone()
                        if r is not None:
                            out.append(self._task_dict(db, r)); have.add(x)
            if view == "recent":
                since = self.clock() - RECENT
                recent = {int(x[0]) for x in db.execute("SELECT entity_id FROM events WHERE kind='task.unblocked'"
                                                        " AND created_at>=?", (since,))}
                out = [t for t in out if int(t["task"][1:]) in recent and t["status"] not in RESOLVED]
        if view == "ready":
            out = [t for t in out if t["ready"]]
        elif view == "blocked":
            out = [t for t in out if t["blocked_by"] and t["status"] not in RESOLVED]
        elif view == "unowned":
            out = [t for t in out if t["status"] == "open" and not t["assigned"] and t["kind"] == "task"]
        elif view == "milestones":
            out = [t for t in out if t["kind"] == "milestone"]
        return out

    def _task_update(self, session, task, status, note=None, require_assignee=False):
        with self._tx() as db:
            tid = parse_id("task", task)
            t = db.execute("SELECT * FROM tasks WHERE task_id=?", (tid,)).fetchone()
            if t is None:
                raise CoordError("missing", f"no task T{tid}")
            me, _ = self._access(db, session, t["project_id"], "participate")
            if t["kind"] == "milestone":
                raise CoordError("milestone", f"T{tid} is a milestone: it is reached when its criteria are met "
                                 f"(coord milestone reach T{tid}), not accepted or done")
            if status == "accepted":
                if t["status"] == "offered" and t["assigned_to"] != session:
                    raise CoordError("forbidden", f"T{tid} is offered to {t['assigned_name']}, not to you")
                if t["status"] not in ("open", "offered"):
                    raise CoordError("taken", f"T{tid} is {t['status']} ({t['assigned_name'] or '-'})")
                waiting = self._blocked_by(db, tid)
                if waiting:
                    raise CoordError("blocked", f"T{tid} waits for {', '.join(f'T{x}' for x in waiting)} - "
                                     "you are told when they are done", {"blocked_by": [f"T{x}" for x in waiting]})
            orphaned = False
            if require_assignee and t["assigned_to"] not in (None, session):
                orphaned = self._task_orphaned(db, t)
                if not orphaned:
                    raise CoordError("forbidden", f"T{tid} is assigned to {t['assigned_name']}")
            if status == "accepted" and t["status"] == "offered":
                creator = self._live_by_name(db, t["created_by"])
                self._notify(db, me, creator["session_id"] if creator else None,
                             f"[T{tid}] {me['display_name']} accepted: {t['title']}")
            if orphaned:
                note = (note or "") + f" (orphaned: {t['assigned_name']} and {t['created_by']} are gone)"
            db.execute("UPDATE tasks SET status=?, assigned_to=COALESCE(assigned_to, ?),"
                       " assigned_name=COALESCE(assigned_name, ?), note=COALESCE(?, note), updated_at=?"
                       " WHERE task_id=?", (status, session, me["display_name"], note, self.clock(), tid))
            self._event(db, t["project_id"], f"task.{status}", session, "task", tid)
            if status == "done":
                self._unblock_dependents(db, me, tid)
            return {"task": f"T{tid}", "status": status}

    def task_decline(self, session: str, task: str, reason: str = "") -> dict:
        """Turn down a task offered (or given back after accepting): it returns to open, unassigned."""
        with self._tx() as db:
            me = self._session(db, session)
            tid = parse_id("task", task)
            t = db.execute("SELECT * FROM tasks WHERE task_id=?", (tid,)).fetchone()
            if t is None:
                raise CoordError("missing", f"no task T{tid}")
            if t["status"] not in ("offered", "accepted"):
                raise CoordError("forbidden", f"T{tid} is not offered to or accepted by you ({t['status']})")
            orphaned = t["assigned_to"] != session and self._task_orphaned(db, t)
            if t["assigned_to"] != session and not orphaned:
                raise CoordError("forbidden", f"T{tid} is not offered to or accepted by you ({t['status']})")
            note = f"declined by {me['display_name']}" + (f" (orphaned: {t['assigned_name']} gone)" if orphaned else "") \
                + (f": {reason}" if reason else "")
            db.execute("UPDATE tasks SET status='open', assigned_to=NULL, assigned_name=NULL,"
                       " note=?, updated_at=? WHERE task_id=?", (note, self.clock(), tid))
            creator = self._live_by_name(db, t["created_by"])
            self._notify(db, me, creator["session_id"] if creator else None,
                         f"[T{tid}] {me['display_name']} declined: {t['title']}" + (f" - {reason}" if reason else ""),
                         kind="warning")
            self._event(db, t["project_id"], "task.declined", session, "task", tid)
            return {"task": f"T{tid}", "status": "open", "declined_by": me["display_name"]}

    def task_get(self, task: str, session: str | None = None) -> dict:
        """One task in full (the A2A GetTask view of it): its links with their conditions, what exactly
        blocks it, the tasks and milestones downstream, where it came from, and the messages about it."""
        tid = parse_id("task", task)
        with self._read() as db:
            r = db.execute("SELECT * FROM tasks WHERE task_id=?", (tid,)).fetchone()
            if r is None:
                raise CoordError("missing", f"no task T{tid}")
            self._view(db, r["project_id"], session)
            after, blocked = self._deps(db, tid), self._blocked_by(db, tid)
            before = [x[0] for x in db.execute("SELECT task_id FROM task_deps WHERE after_id=? ORDER BY task_id", (tid,))]
            deps = [{"task": f"T{d['after_id']}", "title": d["title"], "status": d["status"], "project": d["project_id"],
                     "condition": d["condition"], "reason": d["reason"],
                     **({"waived_by": d["waived_by"], "waive_reason": d["waive_reason"]} if d["waived_at"] else {})}
                    for d in db.execute("SELECT d.*, t.title, t.status, t.project_id FROM task_deps d JOIN tasks t ON"
                                        " t.task_id=d.after_id WHERE d.task_id=? ORDER BY d.after_id", (tid,))]
            down = self._descendants(db, tid)
            milestones = [f"T{x[0]}" for x in db.execute(
                f"SELECT task_id FROM tasks WHERE kind='milestone' AND task_id IN ({','.join('?' * len(down))})"
                " ORDER BY task_id", tuple(down))] if down else []
            vis, vargs = self._visible(session)
            msgs = [{"id": m["id"], "from": m["from_name"], "kind": m["kind"], "body": m["body"][:200]}
                    for m in db.execute(f"SELECT * FROM messages WHERE task_id=? AND {vis} ORDER BY id", (tid, *vargs))]
            source = None
            if r["suggestion_id"]:
                sg = db.execute("SELECT * FROM suggestions WHERE id=?", (r["suggestion_id"],)).fetchone()
                if sg is not None:
                    source = self._suggestion_source(sg)
            out = {"task": f"T{tid}", "project": r["project_id"], "title": r["title"], "description": r["description"],
                   "kind": r["kind"], "after": [f"T{x}" for x in after], "blocked_by": [f"T{x}" for x in blocked],
                   "before": [f"T{x}" for x in before], "prerequisites": deps, "links": self._typed_links(db, tid),
                   "downstream": len(down), "milestones": milestones, "messages": msgs, "source": source,
                   "status": r["status"], "priority": r["priority"], "assigned": r["assigned_name"],
                   "created_by": r["created_by"], "note": r["note"], "category": r["category"],
                   "human_ack": bool(r["human_ack"]),
                   "ready": r["kind"] == "task" and r["status"] in ("open", "offered", "accepted") and not blocked,
                   "claim": f"C{r['related_claim_id']}" if r["related_claim_id"] else None,
                   "created_at": iso(r["created_at"]), "updated_at": iso(r["updated_at"])}
            if r["kind"] == "milestone":
                out.update(self._milestone_extra(db, r))
        return out

    def task_cancel(self, session: str, task: str, note: str = "") -> dict:
        """The creator or the assignee withdraws a task that is not done yet."""
        with self._tx() as db:
            tid = parse_id("task", task)
            t = db.execute("SELECT * FROM tasks WHERE task_id=?", (tid,)).fetchone()
            if t is None:
                raise CoordError("missing", f"no task T{tid}")
            me, _ = self._access(db, session, t["project_id"], "participate")
            if t["status"] in ("done", "cancelled"):
                raise CoordError("not_cancelable", f"T{tid} is already {t['status']}")
            mine = me["display_name"] == t["created_by"] or t["assigned_to"] == session
            if not mine and not self._task_orphaned(db, t):
                raise CoordError("forbidden", f"only {t['created_by']} or the assignee can cancel T{tid}")
            if not mine:
                note = (note or "") + f" (orphaned: {t['assigned_name'] or '-'} and {t['created_by']} are gone)"
            db.execute("UPDATE tasks SET status='cancelled', note=COALESCE(NULLIF(?, ''), note), updated_at=?"
                       " WHERE task_id=?", (note, self.clock(), tid))
            self._event(db, t["project_id"], "task.cancelled", session, "task", tid)
            self._unblock_dependents(db, me, tid)
            return {"task": f"T{tid}", "status": "cancelled"}

    def task_update(self, session: str, task: str, title: str | None = None,
                    description: str | None = None, priority: int | None = None,
                    category: str | None = None, client_id: str | None = None) -> dict:
        """Edit what a task *says*: its title, description, priority and category. Status keeps its
        own path (accept, done, decline, cancel) and the graph keeps its own (link, waive). The
        creator, the assignee or a decider may edit; a field left as None is untouched, so a caller
        can change exactly one thing, and what changed is recorded."""
        def fn(db):
            tid = parse_id("task", task)
            t = db.execute("SELECT * FROM tasks WHERE task_id=?", (tid,)).fetchone()
            if t is None:
                raise CoordError("missing", f"no task T{tid}")
            me, _ = self._access(db, session, t["project_id"], "participate")
            if me["display_name"] != t["created_by"] and t["assigned_to"] != session:
                self._access(db, session, t["project_id"], "decide")   # raises unless a decider
            sets: list[str] = []
            args: list = []
            changed: list[str] = []
            if title is not None:
                new = title.strip()
                if not new:
                    raise CoordError("bad_args", "a task keeps a non-empty title")
                if new != t["title"]:
                    sets.append("title=?")
                    args.append(new)
                    changed.append("title")
            if description is not None and description != t["description"]:
                sets.append("description=?")
                args.append(description)
                changed.append("description")
            if priority is not None:
                new = int(priority)
                if not 0 <= new <= 9:
                    raise CoordError("bad_args", "priority must be between 0 and 9")
                if new != t["priority"]:
                    sets.append("priority=?")
                    args.append(new)
                    changed.append("priority")
            if category is not None:
                new = category.strip() or None
                if new != t["category"]:
                    sets.append("category=?")
                    args.append(new)
                    changed.append("category")
            if not changed:
                return {"task": f"T{tid}", "changed": []}
            sets.append("updated_at=?")
            args.append(self.clock())
            args.append(tid)
            db.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE task_id=?", args)
            self._event(db, t["project_id"], "task.updated", session, "task", tid,
                        fields=", ".join(changed))
            return {"task": f"T{tid}", "changed": changed}
        return self._mutate("task_update", client_id, fn)

    # --- milestones -----------------------------------------------------------------
    def _milestone_row(self, db, milestone):
        t = self._task_row(db, milestone)
        if t["kind"] != "milestone":
            raise CoordError("bad_args", f"T{t['task_id']} is a task, not a milestone")
        return t

    def _milestone_extra(self, db, t) -> dict:
        crit = [{"n": c["idx"], "text": c["text"], "met": c["met_at"] is not None, "met_by": c["met_by"],
                 "met_at": iso(c["met_at"]), "note": c["note"]}
                for c in db.execute("SELECT * FROM milestone_criteria WHERE milestone_id=? ORDER BY idx", (t["task_id"],))]
        targets = [{"rev": x["rev"], "target": iso(x["target_at"]), "reason": x["reason"], "by": x["set_by"],
                    "at": iso(x["set_at"])}
                   for x in db.execute("SELECT * FROM milestone_targets WHERE milestone_id=? ORDER BY rev", (t["task_id"],))]
        remaining = []
        for x in sorted(self._ancestors(db, t["task_id"])):
            a = db.execute("SELECT task_id, title, status, assigned_name, project_id FROM tasks WHERE task_id=?", (x,)).fetchone()
            if a is not None and a["status"] not in RESOLVED:
                remaining.append({"task": f"T{x}", "title": a["title"], "status": a["status"], "assigned": a["assigned_name"],
                                  "project": a["project_id"], "blocked_by": [f"T{y}" for y in self._blocked_by(db, x)]})
        out = {"owner": t["owner"], "scope": t["description"], "target": iso(t["target_at"]),
               "reached_at": iso(t["reached_at"]), "criteria": crit, "criteria_met": sum(c["met"] for c in crit),
               "target_history": targets, "remaining": remaining}
        if t["reached_at"] is None:
            out["projection"] = self._projection(db, t, remaining)
        return out

    def _projection(self, db, t, remaining: list[dict]) -> dict:
        """A forecast of when the milestone's remaining tasks will be done - only when the data allow it,
        always with its assumptions and its uncertainty, never as a percentage of completion.

        Method: the projects' observed throughput (tasks done per day over the last PROJECTION_WINDOW
        days) is resampled day by day, PROJECTION_RUNS times, until the remaining tasks are done
        (Monte Carlo); no run can finish before the longest chain of remaining prerequisites, taken
        at the observed median time from accepted to done. P50 / P85 are the dates half / 85 % of the
        runs finish by; with a target, the share of runs that meet it. The seed is the milestone id:
        the same data give the same answer."""
        now, n = self.clock(), len(remaining)
        if n == 0:
            return {"available": True, "remaining": 0, "p50": iso(now), "p85": iso(now),
                    "note": "no task left before it: it is reached as soon as its criteria are met"}
        projects = sorted({t["project_id"], *(r["project"] for r in remaining)})
        marks = ",".join("?" * len(projects))
        since = now - PROJECTION_WINDOW * 86400
        done = db.execute(f"SELECT entity_id, created_at FROM events WHERE kind='task.done' AND project_id IN ({marks})"
                          " AND created_at>=? ORDER BY created_at", (*projects, since)).fetchall()
        first = db.execute(f"SELECT MIN(created_at) FROM events WHERE project_id IN ({marks})", tuple(projects)).fetchone()[0]
        observed = (now - max(since, first or now)) / 86400
        why = []
        if len(done) < PROJECTION_MIN_DONE:
            why.append(f"only {len(done)} task(s) done in the last {PROJECTION_WINDOW} days (needs {PROJECTION_MIN_DONE})")
        if observed < PROJECTION_MIN_DAYS:
            why.append(f"only {observed:.1f} day(s) of history (needs {PROJECTION_MIN_DAYS})")
        if why:
            return {"available": False, "remaining": n, "why": why,
                    "note": "not enough history for an honest forecast: follow the criteria and the remaining tasks"}
        days = max(1, int(observed + 0.999))
        per_day = [0] * days
        for e in done:
            per_day[min(days - 1, int((e["created_at"] - (now - days * 86400)) // 86400))] += 1
        cycles = []
        for e in done:
            acc = db.execute("SELECT MIN(created_at) FROM events WHERE kind='task.accepted' AND entity_id=?",
                             (e["entity_id"],)).fetchone()[0]
            if acc is not None and acc <= e["created_at"]:
                cycles.append(e["created_at"] - acc)
        cycles.sort()
        median_cycle = cycles[len(cycles) // 2] if cycles else 0.0
        ids = {int(r["task"][1:]) for r in remaining}
        chain: dict[int, int] = {}

        def depth(x: int) -> int:           # the longest chain of remaining prerequisites ending at x
            if x not in chain:
                chain[x] = 0
                chain[x] = 1 + max([depth(a) for a in self._blocked_by(db, x) if a in ids], default=0)
            return chain[x]
        longest = max(depth(x) for x in ids)
        floor_days = longest * median_cycle / 86400
        rng = random.Random(t["task_id"])
        finish = []
        for _ in range(PROJECTION_RUNS):
            left, day = n, 0
            while left > 0 and day < PROJECTION_HORIZON:
                day += 1
                left -= rng.choice(per_day)
            finish.append(max(day, floor_days))
        finish.sort()
        p50, p85 = finish[len(finish) // 2], finish[int(len(finish) * 0.85)]
        beyond = p85 >= PROJECTION_HORIZON
        out = {"available": True, "method": "monte-carlo on observed throughput, bounded by the critical chain",
               "remaining": n, "p50": iso(now + p50 * 86400), "p85": None if beyond else iso(now + p85 * 86400),
               "spread_days": None if beyond else round(p85 - p50, 1),
               "basis": {"window_days": PROJECTION_WINDOW, "observed_days": round(observed, 1), "done": len(done),
                         "per_day": round(len(done) / days, 2), "critical_chain": longest,
                         "median_cycle_days": round(median_cycle / 86400, 2), "runs": PROJECTION_RUNS,
                         "projects": projects},
               "assumptions": [f"the pace of the last {days} day(s) ({len(done)} task(s) done) goes on",
                               f"the {n} remaining task(s) are all that is left: new tasks or a wider scope move the date",
                               "the tasks are of comparable size - one task counts as one",
                               f"a chain of {longest} task(s) is done one after the other, each taking the median "
                               f"{median_cycle / 86400:.1f} day(s) from accepted to done",
                               "calendar days: pauses, quotas and absences only count as far as they did in the history"]}
        if beyond:
            out["note"] = f"at this pace, not within {PROJECTION_HORIZON} days"
        if t["target_at"] is not None:
            by_target = (t["target_at"] - now) / 86400
            hit = sum(1 for f in finish if f <= by_target)
            out["target_runs_met"] = f"{hit}/{PROJECTION_RUNS}"
            out["target_chance"] = round(hit / PROJECTION_RUNS, 2)
        return out

    def milestone_create(self, session: str, title: str, criteria: list[str], target: str | None = None,
                         owner: str | None = None, scope: str = "", after: list[str] | None = None,
                         client_id: str | None = None) -> dict:
        """A milestone: a verifiable result (acceptance criteria), not a date or a percentage. `target` is
        a forecast (ISO date, or 30d from now) whose revisions are kept; `after` lists the tasks (or
        milestones) it waits for."""
        crit = [c.strip() for c in criteria if c and c.strip()]
        if not crit:
            raise CoordError("bad_args", "a milestone needs at least one acceptance criterion (--criterion)")
        due = parse_when(target, self.clock()) if target else None

        def fn(db):
            me, project = self._access(db, session, None, "participate")
            now = self.clock()
            tid = db.execute("INSERT INTO tasks(project_id, created_by, title, description, status, kind, target_at,"
                             " owner, created_at, updated_at) VALUES(?,?,?,?,'open','milestone',?,?,?,?)",
                             (project, me["display_name"], title, scope, due, owner or me["display_name"], now,
                              now)).lastrowid
            for i, c in enumerate(crit, 1):
                db.execute("INSERT INTO milestone_criteria(milestone_id, idx, text) VALUES(?,?,?)", (tid, i, c))
            if due is not None:
                db.execute("INSERT INTO milestone_targets VALUES(?,?,?,?,?,?)",
                           (tid, 1, due, "first target", me["display_name"], now))
            self._link(db, project, tid, after or [], session)
            self._event(db, project, "milestone.created", session, "task", tid, target=iso(due))
            return {"milestone": f"T{tid}", "task": f"T{tid}", "id": tid, "criteria": len(crit), "target": iso(due)}
        return self._mutate("milestone_create", client_id, fn)

    def milestone_criterion(self, session: str, milestone: str, criterion: int, met: bool = True,
                            note: str = "") -> dict:
        """Mark one acceptance criterion met (or not met any more), with who and why."""
        with self._tx() as db:
            t = self._milestone_row(db, milestone)
            me, _ = self._access(db, session, t["project_id"], "participate")
            c = db.execute("SELECT * FROM milestone_criteria WHERE milestone_id=? AND idx=?",
                           (t["task_id"], int(criterion))).fetchone()
            if c is None:
                raise CoordError("missing", f"T{t['task_id']} has no criterion {criterion}")
            db.execute("UPDATE milestone_criteria SET met_at=?, met_by=?, note=? WHERE milestone_id=? AND idx=?",
                       (self.clock() if met else None, me["display_name"] if met else None, note or None,
                        t["task_id"], int(criterion)))
            self._event(db, t["project_id"], "milestone.criterion", session, "task", t["task_id"],
                        criterion=int(criterion), met=bool(met), note=note or None)
            return {"milestone": f"T{t['task_id']}", "criterion": int(criterion), "met": bool(met)}

    def milestone_target(self, session: str, milestone: str, reason: str, target: str | None = None) -> dict:
        """Revise the target date - a forecast, not a promise rewritten afterwards: the previous targets
        stay visible with the reason of each revision. No target (None) means "no date for now"."""
        if not reason.strip():
            raise CoordError("reason_required", "a target revision needs its reason")
        due = parse_when(target, self.clock()) if target else None
        with self._tx() as db:
            t = self._milestone_row(db, milestone)
            me, _ = self._access(db, session, t["project_id"], "participate")
            rev = db.execute("SELECT COALESCE(MAX(rev), 0) + 1 FROM milestone_targets WHERE milestone_id=?",
                             (t["task_id"],)).fetchone()[0]
            db.execute("INSERT INTO milestone_targets VALUES(?,?,?,?,?,?)",
                       (t["task_id"], rev, due, reason, me["display_name"], self.clock()))
            db.execute("UPDATE tasks SET target_at=?, updated_at=? WHERE task_id=?", (due, self.clock(), t["task_id"]))
            self._event(db, t["project_id"], "milestone.target", session, "task", t["task_id"], target=iso(due),
                        previous=iso(t["target_at"]), reason=reason)
            return {"milestone": f"T{t['task_id']}", "target": iso(due), "previous": iso(t["target_at"]), "rev": rev}

    def milestone_reach(self, session: str, milestone: str, note: str = "") -> dict:
        """Record that the milestone is reached (the decider right): every criterion met and nothing
        blocking it left - it may be reached while other work of the project stays open."""
        with self._tx() as db:
            t = self._milestone_row(db, milestone)
            me, _ = self._access(db, session, t["project_id"], "decide")
            if t["reached_at"] is not None:
                raise CoordError("closed", f"T{t['task_id']} was reached on {iso(t['reached_at'])}")
            unmet = [c["idx"] for c in db.execute("SELECT idx FROM milestone_criteria WHERE milestone_id=? AND"
                                                   " met_at IS NULL ORDER BY idx", (t["task_id"],))]
            blocked = self._blocked_by(db, t["task_id"])
            if unmet or blocked:
                raise CoordError("not_reached", f"T{t['task_id']} is not reached: "
                                 + "; ".join(x for x in (f"criteria {', '.join(map(str, unmet))} not met" if unmet else "",
                                                        f"waits for {', '.join(f'T{b}' for b in blocked)}" if blocked else "")
                                             if x), {"unmet": unmet, "blocked_by": [f"T{b}" for b in blocked]})
            now = self.clock()
            db.execute("UPDATE tasks SET status='done', reached_at=?, note=COALESCE(NULLIF(?, ''), note), updated_at=?"
                       " WHERE task_id=?", (now, note, now, t["task_id"]))
            self._event(db, t["project_id"], "milestone.reached", session, "task", t["task_id"],
                        target=iso(t["target_at"]))
            self._unblock_dependents(db, me, t["task_id"])
            return {"milestone": f"T{t['task_id']}", "reached_at": iso(now), "target": iso(t["target_at"])}

    def milestones(self, project: str | None = None, session: str | None = None) -> list[dict]:
        """The timeline: milestones reached (with their dates) then the upcoming ones (by target), each with
        its criteria, what still blocks it, and the history of its target date. No percentage: what is met,
        what is left, and how the forecast moved."""
        with self._read() as db:
            q, a = "SELECT * FROM tasks WHERE kind='milestone' AND status!='cancelled'", []
            if project:
                self._view(db, project, session)
                q += " AND project_id=?"; a.append(project)
            else:
                f, fargs = self._view_filter(db, session)
                q += f" AND {f}"; a += list(fargs)
            rows = db.execute(q, a).fetchall()
            out = [{"milestone": f"T{r['task_id']}", "title": r["title"], "project": r["project_id"],
                    "status": "reached" if r["reached_at"] else "upcoming", **self._milestone_extra(db, r)} for r in rows]
        big = float("inf")
        out.sort(key=lambda m: (m["status"] != "reached", m["reached_at"] or "", m["target"] or str(big)))
        return out

    def unblock_points(self, project: str | None = None, session: str | None = None, limit: int = 10) -> list[dict]:
        """Unfinished tasks whose completion would make other tasks ready now (they are the last thing
        those wait for), with the milestones downstream. A count of descendants is not a priority."""
        with self._read() as db:
            q, a = "SELECT * FROM tasks WHERE status NOT IN ('done','cancelled')", []
            if project:
                self._view(db, project, session)
                q += " AND project_id=?"; a.append(project)
            else:
                f, fargs = self._view_filter(db, session)
                q += f" AND {f}"; a += list(fargs)
            out = []
            for r in db.execute(q, a).fetchall():
                frees = [dep for (dep,) in db.execute(
                    "SELECT d.task_id FROM task_deps d JOIN tasks t ON t.task_id=d.task_id WHERE d.after_id=? AND"
                    " d.waived_at IS NULL AND t.status NOT IN ('done','cancelled')", (r["task_id"],))
                    if self._blocked_by(db, dep) == [r["task_id"]]]
                if not frees:
                    continue
                down = self._descendants(db, r["task_id"])
                ms = [f"T{x[0]}" for x in db.execute(
                    f"SELECT task_id FROM tasks WHERE kind='milestone' AND task_id IN ({','.join('?' * len(down))})",
                    tuple(down))] if down else []
                out.append({"task": f"T{r['task_id']}", "title": r["title"], "status": r["status"],
                            "assigned": r["assigned_name"], "project": r["project_id"],
                            "unblocks": [f"T{x}" for x in frees], "downstream": len(down), "milestones": ms,
                            "blocked_by": [f"T{x}" for x in self._blocked_by(db, r["task_id"])]})
        out.sort(key=lambda x: (-len(x["unblocks"]), -x["downstream"]))
        return out[:int(limit)]

    # --- push notifications for tasks (A2A TaskPushNotificationConfig) ---
    def push_create(self, task: str, url: str, token: str | None = None, auth_scheme: str | None = None,
                    auth_credentials: str | None = None, principal: str | None = None,
                    config_id: str | None = None) -> dict:
        tid = parse_id("task", task)
        self.task_get(f"T{tid}")
        cid = config_id or str(uuid.uuid4())
        with self._tx() as db:
            db.execute("INSERT OR REPLACE INTO task_push VALUES(?,?,?,?,?,?,?,?)",
                       (cid, tid, url, token, auth_scheme, auth_credentials, principal, self.clock()))
        return self.push_get(f"T{tid}", cid)

    def push_list(self, task: str) -> list[dict]:
        with self._read() as db:
            rows = db.execute("SELECT * FROM task_push WHERE task_id=? ORDER BY created_at",
                              (parse_id("task", task),)).fetchall()
        return [{"id": r["config_id"], "task": f"T{r['task_id']}", "url": r["url"], "token": r["token"],
                 "auth_scheme": r["auth_scheme"], "auth_credentials": r["auth_credentials"]} for r in rows]

    def push_get(self, task: str, config_id: str) -> dict:
        for c in self.push_list(task):
            if c["id"] == config_id:
                return c
        raise CoordError("missing", f"no push config {config_id} on {task}")

    def push_delete(self, task: str, config_id: str) -> None:
        self.push_get(task, config_id)
        with self._tx() as db:
            db.execute("DELETE FROM task_push WHERE config_id=?", (config_id,))

    def task_accept(self, session: str, task: str) -> dict:
        return self._task_update(session, task, "accepted")

    def task_done(self, session: str, task: str, note: str = "") -> dict:
        return self._task_update(session, task, "done", note, require_assignee=True)

    def task_ack(self, session: str, task: str, note: str = "") -> dict:
        """Close a task that asked for a human ack, in one step: any participant may call it -
        the human's acknowledge/close button in the UI calls this, not accept then done. It also
        unsticks work no live session can otherwise close (an assignee that is gone while the
        creator is still around, so the orphaned path does not apply). Only tasks created with
        `human_ack` close this way; anything else keeps its own path."""
        with self._tx() as db:
            tid = parse_id("task", task)
            t = db.execute("SELECT * FROM tasks WHERE task_id=?", (tid,)).fetchone()
            if t is None:
                raise CoordError("missing", f"no task T{tid}")
            me, _ = self._access(db, session, t["project_id"], "participate")
            if t["kind"] == "milestone":
                raise CoordError("milestone", f"T{tid} is a milestone: it is reached when its criteria are met "
                                 f"(coord milestone reach T{tid}), not acknowledged")
            if not t["human_ack"]:
                raise CoordError("bad_args", f"T{tid} does not ask for a human ack -"
                                 " accept it and finish it with coord task done")
            if t["status"] in ("done", "cancelled"):
                raise CoordError("not_cancelable", f"T{tid} is already {t['status']}")
            note = note or f"acknowledged by {me['display_name']}"
            db.execute("UPDATE tasks SET status='done', assigned_to=COALESCE(assigned_to, ?),"
                       " assigned_name=COALESCE(assigned_name, ?), note=?, updated_at=?"
                       " WHERE task_id=?", (session, me["display_name"], note, self.clock(), tid))
            self._event(db, t["project_id"], "task.acked", session, "task", tid)
            self._unblock_dependents(db, me, tid)
            return {"task": f"T{tid}", "status": "done"}
