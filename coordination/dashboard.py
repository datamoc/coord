"""The human view of the organisation: a multi-project dashboard and the activity stream.

Not an inbox: the relations between projects, agents, tasks, claims, conversations, decisions and
alerts - who works on what, who holds which resource, who waits for an answer, which agent sleeps
with work assigned, what a single finished task would unblock, how far the next milestone is.
The activity stream turns the event log into readable lines, filterable by project, actor, event
type and age, so one can go back from a decision or a blockage to what produced it."""

import json
import re

from .core import WAKE_UNANSWERED, CoordBase, CoordError, iso, parse_when

# event kind -> how it reads ("{who} {text}"); payload fields fill the braces
PHRASES = {
    "session.started": "joined", "session.resumed": "is back", "session.ended": "left",
    "session.paused": "paused{reason_}",
    "message.posted": "posted a {kind} #{id}", "message.resolved": "resolved #{id}",
    "message.taken": "took #{id}", "message.done": "finished #{id}", "message.declined": "declined #{id}",
    "message.read": "read #{id}",
    "claim.acquired": "claimed {scope}", "claim.released": "released C{id}", "claim.renewed": "renewed C{id}",
    "task.created": "created task T{id}", "task.accepted": "accepted T{id}", "task.done": "completed T{id}",
    "task.cancelled": "cancelled T{id}", "task.declined": "declined T{id}", "task.unblocked": "unblocked T{id}",
    "task.acked": "acknowledged T{id}",
    "task.updated": "updated T{id} ({fields})",
    "task.linked": "linked T{id} ({type})", "task.unlinked": "unlinked T{id} ({type}): {reason}",
    "task.waived": "waived T{id}'s wait for {after}: {reason}",
    "milestone.created": "set milestone T{id}", "milestone.reached": "reached milestone T{id}",
    "milestone.target": "moved milestone T{id}'s target to {target}: {reason}",
    "milestone.criterion": "marked criterion {criterion} of T{id}",
    "discussion.opened": "opened discussion D{id}", "discussion.decided": "decided D{id}{crisis_}",
    "proposal.created": "proposed P{id}", "proposal.reacted": "reacted {stance} to P{id}",
    "document.created": "wrote DOC{id}", "document.edited": "edited DOC{id}", "document.imported": "deposited DOC{id}",
    "document.read": "read DOC{id}", "document.commented": "commented on DOC{id}", "document.reviewed": "closed the review of DOC{id}",
    "suggestion.proposed": "proposed candidate S{id} ({target})", "suggestion.accepted": "accepted S{id} -> {result}",
    "suggestion.rejected": "rejected S{id}",
    "wake.requested": "asked {agent} to resume (W{id}, {reason})", "wake.woken": "woke up (W{id})",
    "wake.accepted": "accepted to resume (W{id})", "wake.refused": "refused to resume (W{id}): {note}",
    "wake.delivered": "wake hook delivered W{id}", "wake.failed": "wake hook failed for W{id}: {diagnostic}",
    "wake.skipped": "did not ask {agent} to resume: {why}",
    "mandate.granted": "granted crisis mandate A{id} to {holder} until {until}", "mandate.revoked": "revoked A{id}: {reason}",
    "mandate.ended": "A{id} ended ({how}); review {review}",
    "crisis.reassigned": "reassigned T{id} to {to} under {mandate}", "crisis.released": "released C{id} under {mandate}",
    "member.set": "gave {id} the role {role}", "member.removed": "removed {id}",
    "routine.started": "started R{id}", "routine.done": "finished R{id} ({outcome})",
    "commit.created": "committed {id}",
}


class _Fill(dict):
    def __missing__(self, key):
        return ""


class DashboardMixin(CoordBase):
    def _names(self, db) -> dict:
        return {r[0]: r[1] for r in db.execute("SELECT session_id, display_name FROM sessions")}

    def _line(self, e, names: dict) -> dict:
        payload = json.loads(e["payload_json"] or "{}")
        who = names.get(e["actor_session_id"]) or e["actor_session_id"] or "coord"
        fill = _Fill({k: (", ".join(v) if isinstance(v, list) else v) for k, v in payload.items() if v is not None})
        fill["id"] = e["entity_id"]
        if payload.get("reason"):
            fill["reason_"] = f": {payload['reason']}"
        if payload.get("crisis"):
            fill["crisis_"] = f" as a crisis arbitration ({payload['crisis']})"
        phrase = PHRASES.get(e["kind"])
        text = phrase.format_map(fill) if phrase else f"{e['kind']} {e['entity_type'] or ''} {e['entity_id'] or ''}".strip()
        return {"event": e["event_id"], "at": iso(e["created_at"]), "project": e["project_id"], "actor": who,
                "kind": e["kind"], "text": f"{who} {text}".rstrip(": "), "entity": e["entity_type"], "id": e["entity_id"]}

    def activity(self, project: str | None = None, actor: str | None = None, kind: str | None = None,
                 since: str | None = None, limit: int = 50, session: str | None = None) -> list[dict]:
        """The activity stream, newest last: "09:41 Claude claimed src/combat/**". Filters: project,
        actor (a name), kind (an event type or its family: task, wake, message...), since (2h, 3d or
        an ISO date)."""
        with self._read() as db:
            q, a = "SELECT * FROM events WHERE 1=1", []
            if project:
                self._view(db, project, session)
                q += " AND project_id=?"; a.append(project)
            else:
                f, fargs = self._view_filter(db, session)
                q += f" AND {f}"; a += list(fargs)
            if kind:
                q += " AND (kind=? OR kind LIKE ?)"; a += [kind, f"{kind}.%"]
            if since:
                ago = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([smhd])", since.strip())
                start = self.clock() - parse_when(since, 0) if ago else parse_when(since, 0)
                q += " AND created_at>=?"; a.append(start)
            if actor:
                q += " AND actor_session_id IN (SELECT session_id FROM sessions WHERE display_name=?)"; a.append(actor)
            rows = db.execute(q + f" ORDER BY event_id DESC LIMIT {int(limit)}", a).fetchall()
            names = self._names(db)
        return [self._line(e, names) for e in reversed(rows)]

    def dashboard(self, project: str | None = None, session: str | None = None) -> dict:
        """Everything that deserves a human's attention, across the projects this caller may see (or one):
        per project its agents with their session state and their work, and what needs attention -
        an agent asleep with work assigned, someone waiting for an answer, a blocked discussion, a
        failed or refused wake-up, candidates waiting for review, an active crisis mandate, the tasks
        that would unblock others, the next milestones - then the latest activity."""
        with self._tx() as db:
            self._sweep_mandates(db)
        names = [p["project"] for p in self.projects(session=session)] if project is None else [project]
        out = []
        for p in names:
            out.append(self._project_board(p, session))
        return {"projects": out, "activity": self.activity(project=project, limit=20, session=session),
                "at": iso(self.clock())}

    def _project_board(self, project: str, session: str | None) -> dict:
        agents = self.agents(project=project, session=session)
        tasks = [t for t in self.tasks(project=project, session=session) if t["project"] == project]
        attention: list[dict] = []
        for a in agents:
            if a["asleep_with_work"]:
                work = a["pending"]["ready_tasks"] + a["pending"]["messages"] + a["pending"]["discussions"]
                attention.append({"kind": "asleep_with_work", "agent": a["name"], "state": a["state"],
                                  "work": work, "text": f"{a['name']} is {a['state']} with {', '.join(work)} waiting"})
            for w in a["wake_requests"]:
                attention.append({"kind": "wake_in_flight", "agent": a["name"], "wake": w["wake"],
                                  "text": f"{w['wake']} to {a['name']}: {w['status']} ({w['mechanism']})"})
        now = self.clock()
        with self._read() as db:
            for r in db.execute("SELECT m.*, r.name AS rname, r.state AS rstate FROM message_recipients r JOIN messages m"
                                " ON m.id=r.message_id WHERE m.project_id=? AND r.state IN ('sent','delivered','read')"
                                " AND m.resolved_at IS NULL AND (m.priority IN ('high','urgent') OR m.created_at<=?)"
                                " ORDER BY m.id", (project, now - WAKE_UNANSWERED)).fetchall():
                if r["kind"] in ("info", "done") and r["priority"] not in ("high", "urgent"):
                    continue
                attention.append({"kind": "awaiting_answer", "message": f"#{r['id']}", "from": r["from_name"],
                                  "to": r["rname"], "priority": r["priority"],
                                  "text": f"{r['from_name']} waits for {r['rname']} on #{r['id']} ({r['rstate']}"
                                          f"{', ' + r['priority'] if r['priority'] != 'normal' else ''})"})
            for w in db.execute("SELECT * FROM wake_requests WHERE project_id=? AND status IN ('failed','refused')"
                                " AND created_at>=? ORDER BY id", (project, now - 86400)).fetchall():
                attention.append({"kind": "wake_" + w["status"], "agent": w["target_name"], "wake": f"W{w['id']}",
                                  "text": f"W{w['id']} to {w['target_name']} {w['status']}: "
                                          f"{w['response'] or w['diagnostic'] or '-'}"})
            pending_sg = db.execute("SELECT COUNT(*) FROM suggestions WHERE project_id=? AND status='proposed'",
                                    (project,)).fetchone()[0]
            if pending_sg:
                attention.append({"kind": "candidates", "count": pending_sg,
                                  "text": f"{pending_sg} candidate(s) wait for review (coord suggestions)"})
            imported = [f"DOC{r[0]}" for r in db.execute("SELECT id FROM documents WHERE project_id=? AND status='imported'",
                                                          (project,))]
            if imported:
                attention.append({"kind": "notes_pending", "documents": imported,
                                  "text": f"imported notes pending review: {', '.join(imported)}"})
            for m in db.execute("SELECT * FROM mandates WHERE project_id=? AND revoked_at IS NULL AND expires_at>?",
                                (project, now)).fetchall():
                attention.append({"kind": "crisis_mandate", "mandate": f"A{m['id']}", "holder": m["holder"],
                                  "text": f"crisis mandate A{m['id']}: {m['holder']} until {iso(m['expires_at'])} "
                                          f"({', '.join(json.loads(m['powers']))})"})
        for d in self.discussions(project=project, session=session):
            full = self.discussion(d["discussion"], session=session)
            open_props = [p for p in full["proposals"] if p["status"] == "open"]
            stuck = [p for p in open_props if any(r["stance"] in ("object", "need-more-info") for r in p["reactions"])]
            late = full["deadline"] and full["deadline"] < iso(now) and not any(p["consensus"]["met"] for p in open_props)
            if stuck or late:
                attention.append({"kind": "discussion_blocked", "discussion": d["discussion"],
                                  "text": f"{d['discussion']} {d['topic']}: "
                                          + ("objections on " + ", ".join(p["proposal"] for p in stuck) if stuck
                                             else "deadline passed without consensus")})
        live = [t for t in tasks if t["status"] not in ("done", "cancelled")]
        return {"project": project,
                "counts": {"agents": len(agents), "active": sum(a["state"] == "active" for a in agents),
                           "paused": sum(a["state"] == "paused" for a in agents),
                           "tasks": len([t for t in live if t["kind"] == "task"]),
                           "ready": sum(t["ready"] for t in live),
                           "blocked": sum(bool(t["blocked_by"]) for t in live),
                           "unowned": sum(t["status"] == "open" and not t["assigned"] and t["kind"] == "task" for t in live),
                           "claims": len(self.locks(project, session=session)),
                           "attention": len(attention)},
                "agents": agents, "attention": attention,
                "unblock_points": self.unblock_points(project=project, session=session, limit=5),
                "milestones": [m for m in self.milestones(project=project, session=session) if m["status"] == "upcoming"][:3]}

    def audit(self, entity: str, session: str | None = None) -> list[dict]:
        """The history of one object (T12, D4, DOC3, S2, W5, A1, C9, #34): who created, read, changed,
        validated, revoked or promoted it, and when."""
        e = entity.strip().upper()
        m = re.fullmatch(r"(DOC|T|D|P|S|W|A|C|M|R|#)(\d+)", e)
        if not m:
            raise CoordError("bad_id", f"expected an id like T12, DOC3, D4, S2, W5, A1, C9 or #34, got {entity!r}")
        etype = {"DOC": "document", "T": "task", "D": "discussion", "P": "proposal", "S": "suggestion", "W": "wake",
                 "A": "mandate", "C": "claim", "M": "memory", "R": "routine", "#": "message"}[m.group(1)]
        with self._read() as db:
            rows = db.execute("SELECT * FROM events WHERE entity_type=? AND entity_id=? ORDER BY event_id",
                              (etype, m.group(2))).fetchall()
            if rows:
                self._view(db, rows[0]["project_id"], session)
            names = self._names(db)
        return [self._line(r, names) | {"payload": json.loads(r["payload_json"] or "{}")} for r in rows]
