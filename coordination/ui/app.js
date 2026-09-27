// coord UI - served by `coord-server --ui`. Everything agents write is untrusted: it only ever
// reaches the page as text (el(), textContent), never as HTML.
"use strict";

const $ = (id) => document.getElementById(id);
let state = null, project = null, me = null, replyTo = null, stream = null, pending = null;

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k instanceof Node ? k : String(k));
  return n;
}
const fill = (node, items, empty = "—") => node.replaceChildren(...(items.length ? items : [el("li", { class: "muted" }, empty)]));
const ago = (iso) => {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? "now" : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
};

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), 4000);
}

async function call(op, args = {}) {
  const r = await fetch("/api/call", { method: "POST", headers: { "Content-Type": "application/json" },
                                       body: JSON.stringify({ op, args, project }) });
  const env = await r.json();
  if (!env.ok) throw new Error(`${env.error}: ${env.message ?? ""}`);
  return env.result;
}
const act = (fn) => async (ev) => {
  ev?.preventDefault?.();
  try { await fn(ev); await refresh(); } catch (e) { toast(e.message); }
};

// --- panels -------------------------------------------------------------
let agentsCache = [], tasksCache = [], meta = { admin: false, mandate: null };
const stateTag = (st) => el("span", { class: `tag state-${st}` }, st);

function renderSessions(list, agents) {
  agentsCache = agents;
  fill($("sessions"), agents.map((a) => {
    const p = a.pending || {};
    const work = [...(p.ready_tasks || []), ...(p.messages || []), ...(p.discussions || [])];
    return el("li", { class: a.asleep_with_work ? "asleep" : "" },
      el("b", {}, a.name), a.kind === "human" ? el("span", { class: "tag" }, "human") : null, " ", stateTag(a.state),
      el("span", { class: "tag" }, ago(a.seen)),
      a.paused ? el("div", { class: "small muted" }, `paused: ${a.paused}`) : null,
      work.length || (p.blocked_tasks || []).length ? el("div", { class: "small" }, work.length ? `waiting: ${work.join(", ")}` : "",
        (p.blocked_tasks || []).length ? el("span", { class: "muted" }, ` blocked: ${p.blocked_tasks.join(", ")}`) : null) : null,
      ...(a.wake_requests || []).map((w) => el("div", { class: "small" }, `${w.wake} ${w.status} (${w.mechanism})`)),
      a.state !== "active" && a.kind !== "human" ? el("button", { class: "ghost small", onclick: act(() => wakeDialog(a)) }, "Reactivate") : null);
  }), "nobody yet");
  const live = list.map((s) => s.name);
  const to = $("to"), assign = $("assign"), keep = [to.value, assign.value];
  to.replaceChildren(el("option", { value: "" }, "everyone"), ...live.map((n) => el("option", { value: n }, n)));
  assign.replaceChildren(el("option", { value: "" }, "open"), ...live.map((n) => el("option", { value: n }, n)));
  [to.value, assign.value] = keep;
}

/** "Reactivate": shows the precise work that motivates the request, then follows it. */
async function wakeDialog(a) {
  const p = a.pending || {};
  const choices = [...(p.ready_tasks || []).map((t) => ["task", t]), ...(p.messages || []).map((m) => ["message", m]),
                   ...(p.discussions || []).map((d) => ["review", d])];
  const menu = choices.map(([r, ref], i) => `${i + 1}. ${r} ${ref}`).join("\n");
  const pick = prompt(`Ask ${a.name} (${a.state}) to resume - because of:\n${menu || "(nothing assigned: say why below)"}\n\nNumber, or a free reason:`,
                      choices.length ? "1" : "");
  if (pick === null) return;
  const chosen = choices[Number(pick) - 1];
  const r = await call("wake_request", chosen ? { agent: a.name, reason: chosen[0], ref: chosen[1] }
                                              : { agent: a.name, reason: "other", note: pick });
  showText(`${r.wake} to ${r.agent}: ${r.status} (${r.mechanism})`, r.manual || "", r.resume);
}

function renderClaims(list) {
  fill($("claims"), list.map((c) => el("li", {}, el("span", { class: "id" }, c.claim), el("code", {}, c.scope), " ",
    c.resource ? el("span", { class: "tag" }, c.resource) : null,
    el("span", { class: "muted small" }, `${c.owner} · until ${c.expires_at.slice(11, 16)}`), c.note ? el("div", { class: "small muted clamp", title: c.note }, c.note) : null)),
  "no active claim");
}

function renderStrategy(list) {
  $("strategy").replaceChildren(...(list.length ? list.map((m) => el("div", { class: "item" }, el("b", {}, m.title), m.content))
    : [el("p", { class: "muted small" }, "No strategy yet - agents add it with coord memory add strategy.")]));
}

function renderMessages(list, awaitingIds) {
  const feed = $("messages");
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  fill(feed, list.map((m) => {
    const open = !m.resolved_at && (m.kind === "question" || m.kind === "warning");
    const forMe = awaitingIds.has(m.id);
    return el("li", { class: `kind-${m.kind}${m.from === me ? " mine" : ""}${m.priority ? ` prio-${m.priority}` : ""}` },
      el("div", { class: "head" }, el("span", { class: "id" }, `#${m.id}`), el("span", { class: "from" }, m.from),
        m.to ? ` → ${m.to}` : "", " · ", el("span", { class: "kind" }, m.kind), m.priority ? el("span", { class: "tag due" }, m.priority) : null,
        m.claim ? ` · ${m.claim}` : "", m.task ? ` · ${m.task}` : "", m.document ? ` · ${m.document}` : "",
        m.reply_to ? ` · re #${m.reply_to}` : "", " · ", ago(m.at)),
      el("div", { class: "body" }, m.body),
      m.resolved_at ? el("div", { class: "small muted" }, `resolved by ${m.resolved_by}: ${m.resolution || ""}`) : null,
      el("div", { class: "actions" },
        el("button", { class: "ghost small", onclick: () => startReply(m) }, "Reply"),
        forMe ? el("button", { class: "ghost small", onclick: act(() => call("ack", { message: m.id, state: "taken" })) }, "Take") : null,
        forMe ? el("button", { class: "ghost small", onclick: act(() => call("ack", { message: m.id, state: "done" })) }, "Done") : null,
        m.to || m.priority ? el("button", { class: "ghost small", onclick: act(async () => {
          const r = await call("receipts", { message: m.id });
          showText(`Receipts of #${m.id}`, "", r.recipients.map((x) => `${x.name}: ${x.state}${x.note ? ` - ${x.note}` : ""}`).join("\n") || "no recipient");
        }) }, "Receipts") : null,
        el("button", { class: "ghost small", title: "propose a task, decision or memory entry from this message", onclick: act(() => candidateFrom(`#${m.id}`, m.body)) }, "→ Task…"),
        open ? el("button", { class: "ghost small", onclick: act(() => {
          const note = prompt(`Resolve #${m.id} - note:`, "");
          if (note !== null) return call("resolve", { message: m.id, resolution: note });
        }) }, "Resolve") : null));
  }), "no message yet");
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

/** A candidate drawn from a source (a message, or a passage of a document): validated later, never executed. */
async function candidateFrom(source, text, quote) {
  const target = prompt("Turn it into: task, decision, memory, question or summary?", "task");
  if (!target) return;
  const title = prompt("Title:", (quote || text).slice(0, 80));
  if (!title) return;
  const nature = prompt("What is the cited passage: fact, hypothesis, opinion or decision (already taken)?", "fact");
  if (!nature) return;
  const memory_kind = target === "memory" ? prompt("Memory kind (convention, architecture, decision, pitfall...):", "convention") : null;
  const r = await call("suggestion_add", { source, target, title, quote: quote || null, nature, memory_kind });
  toast(`${r.suggestion} proposed - a decider accepts or rejects it`);
}

const taskState = (t) => (t.status === "done" || t.status === "cancelled" ? "done" : t.blocked_by?.length ? "blocked" : t.status);
let taskView = "";

function renderTasks(list) {
  tasksCache = list;
  const live = list.filter((t) => t.status !== "done" && t.status !== "cancelled" && t.project === project);
  const shown = taskView === "ready" ? live.filter((t) => t.ready) : taskView === "blocked" ? live.filter((t) => t.blocked_by?.length)
    : taskView === "unowned" ? live.filter((t) => t.status === "open" && !t.assigned && t.kind === "task")
    : taskView === "recent" ? live.filter((t) => recentUnblocked.has(t.task)) : live;
  fill($("tasks"), shown.map((t) => el("li", { title: t.title }, el("div", { class: "clamp" },
      el("a", { class: "link", onclick: act(() => openTask(t.task)) }, el("span", { class: "id" }, t.task)), t.title),
    t.kind === "milestone" ? el("span", { class: "tag" }, "milestone") : null,
    t.human_ack ? el("span", { class: "tag" }, "needs a human ack") : null,
    el("span", { class: `tag${t.blocked_by?.length ? " due" : ""}` }, t.blocked_by?.length ? `blocked by ${t.blocked_by.join(", ")}` : t.ready ? "ready" : t.status),
    t.assigned ? el("span", { class: "tag" }, t.assigned) : null,
    !t.blocked_by?.length && t.after?.length ? el("span", { class: "tag" }, `after ${t.after.join(", ")}`) : null)), "nothing here");
  const who = $("g-who"), focus = $("g-focus"), path = $("g-path"), keep = [who.value, focus.value, path.value];
  who.replaceChildren(el("option", { value: "" }, "anyone"), ...[...new Set(list.map((t) => t.assigned).filter(Boolean))].map((n) => el("option", { value: n }, n)));
  focus.replaceChildren(el("option", { value: "" }, "whole graph"), ...list.map((t) => el("option", { value: t.task }, `around ${t.task} ${t.title.slice(0, 30)}`)));
  path.replaceChildren(el("option", { value: "" }, "no path highlighted"),
    ...list.filter((t) => t.kind === "milestone").map((t) => el("option", { value: t.task }, `path to ${t.task} ${t.title.slice(0, 30)}`)));
  [who.value, focus.value, path.value] = keep;
  renderGraph(list.filter((t) => t.status !== "cancelled"));
}
let recentUnblocked = new Set();

// --- the task graph: columns by depth (longest chain of blocking prerequisites), typed edges ------------
const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const k of kids) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
function neighbourhood(all, center, hops = 2) {
  const adj = new Map(all.map((t) => [t.task, new Set()]));
  const link = (a, b) => { if (adj.has(a) && adj.has(b)) { adj.get(a).add(b); adj.get(b).add(a); } };
  for (const t of all) { for (const a of t.after || []) link(a, t.task); for (const l of t.links || []) link(t.task, l.to || l.from); }
  const seen = new Set([center]); let edge = [center];
  for (let i = 0; i < hops; i++) edge = edge.flatMap((x) => [...(adj.get(x) || [])].filter((y) => !seen.has(y) && seen.add(y)));
  return seen;
}
function ancestors(byId, id) {
  const seen = new Set(), todo = [id];
  while (todo.length) for (const a of byId.get(todo.pop())?.after || []) if (!seen.has(a)) { seen.add(a); todo.push(a); }
  return seen;
}
function renderGraph(all) {
  const box = $("graph");
  let tasks = all;
  if ($("g-hidedone").checked) tasks = tasks.filter((t) => t.status !== "done");
  if ($("g-who").value) tasks = tasks.filter((t) => t.assigned === $("g-who").value || t.kind === "milestone");
  if ($("g-focus").value) { const keep = neighbourhood(all, $("g-focus").value); tasks = tasks.filter((t) => keep.has(t.task)); }
  const byId = new Map(tasks.map((t) => [t.task, t]));
  const onPath = $("g-path").value ? ancestors(new Map(all.map((t) => [t.task, t])), $("g-path").value) : new Set();
  if ($("g-path").value) onPath.add($("g-path").value);
  const hasEdge = tasks.some((t) => (t.after || []).some((a) => byId.has(a)) || (t.links || []).some((l) => byId.has(l.to || l.from)));
  if (!hasEdge) {
    box.replaceChildren(el("p", { class: "muted small" }, tasks.length
      ? "No dependencies yet - link tasks with coord task link T3 --after T1 (or the Link form below)." : "No task yet."));
    return;
  }
  const depth = new Map();
  const d = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const v = Math.max(0, ...(byId.get(id).after || []).filter((a) => byId.has(a)).map((a) => d(a, seen) + 1));
    depth.set(id, v);
    return v;
  };
  tasks.forEach((t) => d(t.task));
  const cols = [];
  for (const t of tasks) (cols[depth.get(t.task)] ??= []).push(t);
  const row = new Map();
  const hasNext = new Set(tasks.flatMap((t) => (t.after || []).filter((a) => byId.has(a))));
  cols[0]?.sort((a, b) => Number(hasNext.has(b.task)) - Number(hasNext.has(a.task)));
  cols.forEach((col, c) => {
    if (c) {
      const mean = (t) => { const r = (t.after || []).filter((a) => row.has(a)).map((a) => row.get(a));
                            return r.length ? r.reduce((x, y) => x + y, 0) / r.length : Infinity; };
      col.sort((a, b) => mean(a) - mean(b));
    }
    col.forEach((t, r) => row.set(t.task, r));
  });
  const W = 230, H = 50, GX = 70, GY = 18, P = 12;
  const pos = new Map();
  cols.forEach((col, c) => col.forEach((t, r) => pos.set(t.task, { x: P + c * (W + GX), y: P + r * (H + GY) })));
  const width = P * 2 + cols.length * W + (cols.length - 1) * GX;
  const height = P * 2 + Math.max(...cols.map((c) => c.length)) * (H + GY) - GY;
  const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "task dependency graph" });
  root.append(svg("defs", {}, svg("marker", { id: "arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7",
                                               markerHeight: "7", orient: "auto-start-reverse" },
                                  svg("path", { d: "M0,0 L10,5 L0,10 z", fill: "currentColor", class: "edge-head" }))));
  const curve = (s, e, cls, label) => {
    const x1 = s.x + W, y1 = s.y + H / 2, x2 = e.x - 2, y2 = e.y + H / 2, mx = (x1 + x2) / 2;
    const path = svg("path", { class: cls, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, "marker-end": "url(#arrow)" });
    path.append(svg("title", {}, label));
    root.append(path);
  };
  for (const t of tasks) {
    for (const a of t.after || []) if (byId.has(a)) curve(pos.get(a), pos.get(t.task), `edge${onPath.has(a) && onPath.has(t.task) ? " onpath" : ""}`, `${a} blocks ${t.task}`);
    for (const l of t.links || []) if (l.to && byId.has(l.to)) {
      const [s, e] = l.type === "part_of" ? [t.task, l.to] : [l.to, t.task];
      curve(pos.get(s), pos.get(e), `edge ${l.type === "enables" ? "enables" : "context"}`, `${t.task} ${l.type} ${l.to}${l.reason ? `: ${l.reason}` : ""}`);
    }
  }
  for (const t of tasks) {
    const { x, y } = pos.get(t.task);
    const title = t.title.length > 30 ? t.title.slice(0, 29) + "…" : t.title;
    const sub = t.kind === "milestone" ? (t.reached_at ? `reached ${t.reached_at.slice(0, 10)}` : t.target ? `target ${t.target.slice(0, 10)}` : "milestone")
      : t.blocked_by?.length ? `waits for ${t.blocked_by.join(", ")}` : t.assigned ? `${t.status} · ${t.assigned}` : t.ready ? "ready" : t.status;
    const foreign = t.project !== project;
    const g = svg("g", { class: `node ${taskState(t)}${t.kind === "milestone" ? " milestone" : ""}${foreign ? " foreign" : ""}${onPath.has(t.task) ? " onpath" : ""}`,
                         transform: `translate(${x},${y})`, tabindex: "0", role: "button" },
      svg("title", {}, `${t.task} ${t.title} (${t.status}${foreign ? `, project ${t.project}` : ""}) - click for details`),
      svg("rect", { width: W, height: H, rx: t.kind === "milestone" ? 2 : 8 }),
      svg("text", { x: 10, y: foreign ? 16 : 19 }, svg("tspan", { class: "tid" }, t.task + " "), title),
      svg("text", { x: 10, y: foreign ? 30 : 36, class: "muted-text", opacity: ".75", "font-size": "11" }, sub),
      foreign ? svg("text", { x: 10, y: 43, "font-size": "9", opacity: ".6" }, t.project) : "");
    g.addEventListener("click", act(() => openTask(t.task)));
    g.addEventListener("keydown", (ev) => { if (ev.key === "Enter") act(() => openTask(t.task))(ev); });
    root.append(g);
  }
  box.replaceChildren(root);
}
for (const id of ["g-hidedone", "g-who", "g-focus", "g-path"]) $(id).addEventListener("change", () => renderGraph(tasksCache.filter((t) => t.status !== "cancelled")));

function showText(title, meta, body, extra = []) {
  $("vtitle").textContent = title;
  $("vmeta").textContent = meta || "";
  $("vbody").textContent = body || "";
  $("vextra").replaceChildren(...extra);
  if (!$("viewer").open) $("viewer").showModal();
}

/** A task's card: its exact blockage, its links, its conversation, where it came from - and the graph edits. */
async function openTask(id) {
  const t = await call("task_get", { task: id });
  const lines = [`${t.title} [${t.kind === "milestone" ? "milestone, " : ""}${t.status}${t.ready ? ", ready" : ""}] ${t.assigned ? `- ${t.assigned}` : ""}${t.human_ack ? " - needs a human ack" : ""}`,
    t.description || "", "",
    ...t.prerequisites.map((p) => `waits for ${p.task} [${p.status}] ${p.title}${p.project !== t.project ? ` (${p.project})` : ""}`
      + (p.condition ? ` - condition: ${p.condition}` : "") + (p.waived_by ? ` - WAIVED by ${p.waived_by}: ${p.waive_reason}` : "")),
    ...t.links.map((l) => {       // A --type X --after B reads "A X B", except enables: "B enables A" (like blocks)
      const [a, b] = l.to ? [t.task, l.to] : [l.from, t.task];
      return `${l.type === "enables" ? `${b} enables ${a}` : `${a} ${l.type} ${b}`}${l.reason ? ` - ${l.reason}` : ""}`;
    }),
    t.before.length ? `before: ${t.before.join(", ")} (${t.downstream} downstream)` : "",
    t.milestones.length ? `milestones touched: ${t.milestones.join(", ")}` : "",
    t.source ? `source: ${t.source}` : "",
    ...(t.criteria || []).map((c) => `[${c.met ? "x" : " "}] ${c.n}. ${c.text}`),
    ...t.messages.map((m) => `#${m.id} ${m.from} (${m.kind}): ${m.body}`)].filter((x) => x !== null);
  const buttons = [
    ...t.prerequisites.filter((p) => !p.waived_by && p.status !== "done" && p.status !== "cancelled").map((p) =>
      el("button", { class: "ghost small", type: "button", onclick: act(async () => {
        const why = prompt(`Waive ${t.task}'s wait for ${p.task} - why? (decider)`, "");
        if (why) { await call("task_waive", { task: t.task, after: p.task, reason: why }); await openTask(id); }
      }) }, `Waive ${p.task}`)),
    ...t.prerequisites.map((p) => el("button", { class: "ghost small", type: "button", onclick: act(async () => {
      const why = prompt(`Remove the link ${t.task} after ${p.task} - why?`, "");
      if (why) { await call("task_link", { task: t.task, after: [p.task], remove: true, reason: why }); await openTask(id); }
    }) }, `Unlink ${p.task}`)),
    ...(t.human_ack && t.status !== "done" && t.status !== "cancelled" ? [el("button", { class: "small", type: "button",
      onclick: act(async () => {
        const note = prompt(`Acknowledge and close ${t.task} - note (empty keeps who closed it):`, "");
        if (note === null) return;
        await call("task_ack", { task: t.task, note }); await openTask(id);
      }) }, "Acknowledge & close")] : []),
  ];
  showText(`${t.task} · ${t.project}`, `created by ${t.created_by} · ${t.created_at}`, lines.join("\n"), [el("div", { class: "row" }, ...buttons)]);
}

/** The forecast with its assumptions, or why there is none - never a percentage of completion. */
function projectionLine(pr) {
  if (!pr) return null;
  if (!pr.available) return el("div", { class: "small muted" }, `projection: none - ${pr.why.join("; ")}`);
  if (!pr.remaining) return el("div", { class: "small" }, `projection: ${pr.note}`);
  return el("details", { class: "small proj-line" },
    el("summary", {}, `projection: half the runs finish by ${pr.p50.slice(0, 10)}, 85 % by ${pr.p85 ? pr.p85.slice(0, 10) : "beyond 10 years"}`
      + (pr.target_runs_met ? ` · target met in ${pr.target_runs_met} runs` : "")),
    el("div", { class: "muted" }, `${pr.remaining} task(s) left · ${pr.basis.done} done in the last ${pr.basis.observed_days} day(s)`
      + ` · critical chain of ${pr.basis.critical_chain} · ${pr.method}`),
    el("ul", {}, ...pr.assumptions.map((a) => el("li", {}, a))));
}

function renderMilestones(list) {
  $("milestones").replaceChildren(...(list.length ? list.map((m) => el("div", { class: `ms ${m.status}` },
    el("div", {}, el("a", { class: "link", onclick: act(() => openTask(m.milestone)) }, el("span", { class: "id" }, m.milestone)), el("b", {}, m.title),
      el("span", { class: `tag${m.status === "reached" ? " ok" : ""}` }, m.status === "reached" ? `reached ${m.reached_at.slice(0, 10)}`
        : m.target ? `target ${m.target.slice(0, 10)}` : "no target"),
      el("span", { class: "tag" }, `${m.criteria_met}/${m.criteria.length} criteria`), m.owner ? el("span", { class: "tag" }, m.owner) : null),
    ...m.criteria.map((c) => el("label", { class: "small crit" }, el("input", { type: "checkbox", checked: c.met, disabled: m.status === "reached",
      onchange: act(() => call("milestone_criterion", { milestone: m.milestone, criterion: c.n, met: !c.met })) }), ` ${c.text}`,
      c.met ? el("span", { class: "muted" }, ` (${c.met_by})`) : null)),
    m.remaining.length ? el("div", { class: "small" }, `still before it: ${m.remaining.map((t) => `${t.task} ${t.status}`).join(", ")}`) : null,
    projectionLine(m.projection),
    m.target_history.length > 1 ? el("div", { class: "small muted" }, `target moved: ${m.target_history.map((x) => `${(x.target || "none").slice(0, 10)} (${x.reason})`).join(" → ")}`) : null,
    m.status === "upcoming" ? el("div", { class: "row" },
      el("button", { class: "ghost small", onclick: act(() => {
        const target = prompt("New target (2026-11-01, 30d, or none):", "");
        if (target === null) return;
        const reason = prompt("Why does the target move?", "");
        if (reason) return call("milestone_target", { milestone: m.milestone, target: target === "none" ? null : target, reason });
      }) }, "Revise target"),
      el("button", { class: "small", onclick: act(() => call("milestone_reach", { milestone: m.milestone, note: prompt("Note:", "") || "" })) }, "Reached")) : null))
    : [el("p", { class: "muted small" }, "No milestone yet: a milestone is a verifiable result with criteria.")]));
}

function renderAttention(msgs, tasks, awaiting) {
  const open = msgs.filter((m) => !m.resolved_at && (m.kind === "question" || m.kind === "warning")).slice(-8).reverse();
  const offered = tasks.filter((t) => t.status === "offered" && t.project === project);
  fill($("attention"), [
    ...awaiting.map((m) => el("li", {}, el("span", { class: "id" }, `#${m.id}`), el("b", {}, m.from), ` asks you${m.priority ? ` (${m.priority})` : ""}: `,
      el("span", { class: "small" }, m.body.length > 110 ? m.body.slice(0, 109) + "…" : m.body))),
    ...open.map((m) => el("li", {}, el("span", { class: "id" }, `#${m.id}`), el("b", {}, m.from), ` ${m.kind}: `,
      el("span", { class: "small" }, m.body.length > 110 ? m.body.slice(0, 109) + "…" : m.body))),
    ...offered.map((t) => el("li", {}, el("span", { class: "id" }, t.task), `offered to ${t.assigned}: `, t.title)),
  ], "nothing waiting");
  return open.length + offered.length + awaiting.length;
}

function renderDue(routines) {
  const due = routines.filter((r) => r.due);
  fill($("due"), due.map((r) => el("li", {}, el("span", { class: "id" }, r.routine), r.title, el("span", { class: "tag due" }, r.why))),
    "nothing due");
  return due.length;
}

const badge = (id, n) => { $(id).textContent = n ? String(n) : ""; };

// Project visibility: per-browser display preference (T109). Hiding removes a
// project from the board below; its data is untouched and the project picker
// still lists it, so a hidden project stays one click away.
function hiddenProjects() {
  try { return JSON.parse(localStorage.getItem("coord.hidden_projects") || "[]"); }
  catch { return []; }
}
function setProjectHidden(name, hide) {
  const hidden = new Set(hiddenProjects());
  if (hide) hidden.add(name); else hidden.delete(name);
  try { localStorage.setItem("coord.hidden_projects", JSON.stringify([...hidden])); } catch { /* private window */ }
}

function renderBoard(board) {
  let total = 0;
  const hidden = new Set(hiddenProjects());
  const shown = board.projects.filter((p) => !hidden.has(p.project));
  const missing = board.projects.filter((p) => hidden.has(p.project));
  $("board").replaceChildren(...shown.map((p) => {
    const c = p.counts;
    total += c.attention;
    return el("div", { class: "proj" },
      el("div", {}, el("a", { class: "link", onclick: () => { $("project").value = p.project; enter(p.project).then(() => showTab("now")); } }, el("b", {}, p.project)),
        el("button", { class: "ghost small", title: "hide this project from the board", onclick: act(() => { setProjectHidden(p.project, true); }) }, "Hide"),
        el("span", { class: "muted small" }, ` ${c.agents} agents (${c.active} active, ${c.paused} paused) · ${c.tasks} tasks · ${c.ready} ready · ${c.blocked} blocked · ${c.unowned} unowned · ${c.claims} claims`)),
      el("div", { class: "row" }, ...p.agents.map((a) => el("span", { class: `chip state-${a.state}${a.asleep_with_work ? " asleep" : ""}`, title: a.status || "" }, `${a.name} ${a.state}`))),
      el("ul", { class: "list" }, ...p.attention.map((x) => el("li", { class: `att att-${x.kind}` }, "⚠ ", x.text,
        x.kind === "asleep_with_work" ? el("button", { class: "ghost small", onclick: act(() => wakeDialog(p.agents.find((a) => a.name === x.agent))) }, "Reactivate") : null))),
      ...p.unblock_points.slice(0, 3).map((u) => el("div", { class: "small" }, "unblock point: ", el("span", { class: "id" }, u.task), `${u.title} → ${u.unblocks.join(", ")}`,
        u.milestones.length ? el("span", { class: "muted" }, ` (then ${u.milestones.join(", ")})`) : null)),
      ...p.milestones.map((m) => el("div", { class: "small" }, "next milestone: ", el("span", { class: "id" }, m.milestone), `${m.title} - ${m.criteria_met}/${m.criteria.length} criteria, ${m.remaining.length} task(s) left`,
        m.target ? ` · target ${m.target.slice(0, 10)}` : "",
        m.projection?.available && m.projection.remaining ? ` · projected ${m.projection.p50.slice(0, 10)}–${(m.projection.p85 || "…").slice(0, 10)}` : "")));
  }),
    ...missing.map((p) => el("div", { class: "small muted" }, `hidden: ${p.project} `,
      el("button", { class: "ghost small", onclick: act(() => { setProjectHidden(p.project, false); }) }, "Show"))));
  return total;
}

async function renderActivity() {
  const args = { project: $("act-project").value || null, actor: $("act-actor").value.trim() || null,
                 kind: $("act-kind").value || null, since: $("act-since").value || null, limit: 80 };
  const lines = await call("activity", args);
  fill($("activity"), lines.reverse().map((e) => el("li", {}, el("span", { class: "muted small" }, `${e.at.slice(5, 16).replace("T", " ")} `),
    args.project ? null : el("span", { class: "tag" }, e.project.split("/").pop()), " ", e.text)), "no activity");
}
for (const id of ["act-project", "act-kind", "act-since"]) $(id).addEventListener("change", () => renderActivity().catch((e) => toast(e.message)));
$("act-actor").addEventListener("change", () => renderActivity().catch((e) => toast(e.message)));
$("actfilter").addEventListener("submit", (e) => e.preventDefault());

// --- tabs -----------------------------------------------------------------
function showTab(name) {
  for (const b of document.querySelectorAll("#tabs [role=tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const v of document.querySelectorAll(".view")) v.classList.toggle("hidden", v.id !== `view-${name}`);
  try { localStorage.setItem("coord.tab", name); } catch { /* private window */ }
}
for (const b of document.querySelectorAll("#tabs [role=tab]")) b.addEventListener("click", () => showTab(b.dataset.tab));
showTab((() => { try { return localStorage.getItem("coord.tab") || "now"; } catch { return "now"; } })());

function renderRoutines(list) {
  fill($("routines"), list.map((r) => el("li", {}, el("span", { class: "id" }, r.routine), r.title,
    r.running ? el("span", { class: "tag" }, `running: ${r.running}`) : r.due ? el("span", { class: "tag due" }, `due: ${r.why}`)
      : el("span", { class: "tag" }, r.status !== "active" ? r.status : r.next_due ? `next ${r.next_due.slice(5, 16).replace("T", " ")}` : "on commit"),
    r.last_outcome && r.last_outcome !== "ok" ? el("span", { class: "tag bad" }, r.last_outcome) : null,
    r.last_result ? el("div", { class: "small muted" }, r.last_result) : null)), "no routine");
}

async function openDoc(id) {
  const doc = await call("doc_show", { document: id });
  const comments = doc.comments ? await call("doc_comments", { document: id }) : [];
  const prov = doc.origin === "import"
    ? `deposited by ${doc.deposited_by} · author ${doc.author} · ${doc.context}${doc.written_at ? ` · written ${doc.written_at.slice(0, 10)}` : ""}`
      + ` · AI: ${doc.ai_assisted === null ? "not stated" : doc.ai_assisted ? "yes" : "no"} · ${doc.visibility} · ${doc.fingerprint.slice(0, 19)}…`
      + ` · status ${doc.status} - a source, nothing in it runs`
    : `${doc.kind} · ${doc.status} · by ${doc.created_by}`;
  const selection = () => { const s = window.getSelection()?.toString().trim(); return s && doc.content.includes(s) ? s : null; };
  const extra = [
    comments.length ? el("ul", { class: "list" }, ...comments.map((k) => el("li", { class: "small" }, el("b", {}, k.by), k.quote ? ` on «${k.quote}»` : "", `: ${k.body}`))) : null,
    doc.derived?.length ? el("div", { class: "small" }, "derived: ", doc.derived.map((x) => `${x.suggestion} ${x.target} ${x.status}${x.result ? ` → ${x.result}` : ""}`).join(", ")) : null,
    el("div", { class: "row" },
      el("button", { class: "ghost small", type: "button", onclick: act(async () => {
        const quote = selection();
        const body = prompt(quote ? `Comment on «${quote.slice(0, 60)}»:` : "Comment (select a passage first to cite it):", "");
        if (body) { await call("doc_comment", { document: id, body, quote }); await openDoc(id); }
      }) }, "Comment"),
      el("button", { class: "ghost small", type: "button", onclick: act(async () => {
        const quote = selection();
        if (!quote) { toast("Select the passage the candidate comes from, then click again"); return; }
        await candidateFrom(id, doc.content, quote);
        await openDoc(id);
      }) }, "Propose from selection…"),
      doc.status === "imported" ? el("button", { class: "ghost small", type: "button", onclick: act(async () => {
        await call("doc_reviewed", { document: id, note: prompt("Review note:", "") || "" }); await openDoc(id);
      }) }, "Close review") : null)];
  showText(`${doc.document} r${doc.revision} · ${doc.title}`, prov, doc.content, extra.filter(Boolean));
}

function renderDocs(list) {
  fill($("docs"), list.slice(-25).reverse().map((d) => el("li", {},
    el("a", { class: "link", onclick: act(() => openDoc(d.document)) }, el("span", { class: "id" }, d.document), d.title),
    el("span", { class: `tag${d.status === "imported" ? " due" : ""}` }, d.origin === "import" ? `${d.context} · ${d.status}` : d.kind),
    d.visibility === "private" ? el("span", { class: "tag" }, "private") : null)), "no document");
  return list.filter((d) => d.status === "imported").length;
}

function renderCandidates(list) {
  const pending = list.filter((x) => x.status === "proposed");
  fill($("candidates"), pending.map((x) => el("li", {},
    el("span", { class: "id" }, x.suggestion), el("b", {}, x.title), el("span", { class: "tag" }, x.target), el("span", { class: "tag" }, x.nature),
    el("div", { class: "small muted" }, `from ${x.source}${x.revision ? ` r${x.revision}` : ""} by ${x.proposed_by}: «${x.quote}»`),
    x.body ? el("div", { class: "small" }, x.body) : null,
    el("div", { class: "row" },
      el("button", { class: "small", onclick: act(() => call("suggestion_review", { suggestion: x.suggestion, accept: true, note: "" })) }, "Accept"),
      el("button", { class: "ghost small", onclick: act(() => {
        const title = prompt("Correct the title before accepting:", x.title);
        if (title) return call("suggestion_review", { suggestion: x.suggestion, accept: true, title, note: "corrected" });
      }) }, "Correct & accept"),
      el("button", { class: "ghost small", onclick: act(() => {
        const why = prompt("Reject - why?", "");
        if (why) return call("suggestion_review", { suggestion: x.suggestion, accept: false, note: why });
      }) }, "Reject")))), "nothing waiting for review");
  return pending.length;
}

// One discussion's async chat: its linked messages (plus thread replies) and a composer.
// refresh() rebuilds this panel on every event, so the current draft (and focus) rides
// along through `draft` instead of being wiped while the human types.
function discussionChat(d, msgs, draft) {
  const chat = msgs.filter((m) => m.discussion === d.discussion || m.thread === d.thread);
  const input = el("input", { placeholder: `Talk with the agents in ${d.discussion}…`, maxlength: "10000", autocomplete: "off" });
  if (draft) { input.value = draft.v; if (draft.f) input.focus({ preventScroll: true }); }
  return [el("div", { class: "chat" },
    el("ul", { class: "feed chatlog" }, ...(chat.length ? chat.map((m) => el("li", { class: m.from === me ? "mine" : "" },
      el("div", { class: "head" }, el("span", { class: "from" }, m.from), " · ", ago(m.at)),
      el("div", { class: "body" }, m.body))) : [el("li", { class: "muted small" }, "no messages yet - say hello, the agents read it at their next poll")])),
    el("form", { class: "compose", "data-d": d.discussion, onsubmit: act(async () => {
      const body = input.value.trim();
      if (!body) return;
      await call("post", { body, kind: "info", discussion: d.discussion,
        reply_to: chat.length ? chat[chat.length - 1].id : null });
      input.value = "";
    }) }, input, el("button", { type: "submit" }, "Send")))];
}

function boxScrollBottom() {
  document.querySelectorAll("#discussions .chatlog").forEach((l) => { l.scrollTop = l.scrollHeight; });
}

async function renderDiscussions(list, mandates, msgs) {
  const details = await Promise.all(list.map((d) => call("discussion", { discussion: d.discussion })));
  const holding = mandates.find((m) => m.status === "active" && m.holder === me && m.powers.includes("decide"));
  const box = $("discussions");
  const drafts = {};
  box.querySelectorAll("form[data-d]").forEach((f) => { drafts[f.dataset.d] = { v: f.querySelector("input").value, f: f.contains(document.activeElement) }; });
  box.replaceChildren(...(details.length ? details.map((d) => el("div", { class: "disc" },
    el("div", {}, el("span", { class: "id" }, d.discussion), el("b", {}, d.topic)),
    el("div", { class: "small muted" }, `${d.rule}${d.owner ? ` (owner ${d.owner})` : ""}, by ${d.created_by}`
      + (d.deadline ? ` · closes ${d.deadline.replace("T", " ").slice(0, 16)}` : "")
      + (d.weights ? ` · weights ${Object.entries(d.weights).map(([n, w]) => `${n}=${w}`).join(", ")} · threshold ${d.threshold} · quorum ${d.quorum_weight} of the weight` : "")),
    ...d.proposals.filter((p) => p.status !== "superseded").map((p) => {
      const c = p.consensus || {};
      const stance = (s) => act(() => {
        const why = s === "object" || s === "support-with-reservation" ? prompt(`${s} - why?`, "") : "";
        if (why !== null) return call("react", { proposal: p.proposal, stance: s, comment: why });
      });
      return el("div", { class: "prop" },
        el("div", {}, el("span", { class: "id" }, p.proposal), p.body, " ", el("span", { class: "muted small" }, `- ${p.author}`)),
        c.tally ? el("div", { class: "small" }, `for ${c.tally.for} · against ${c.tally.against} · abstain ${c.tally.abstain} · silent ${c.tally.silent} (silence never counts as support)`) : null,
        c.met ? el("div", { class: "met" }, d.rule === "weighted" ? "vote carried" : "consensus reached") : el("div", { class: "why" }, (c.why || []).join("; ")),
        ...(c.reservations || []).map((x) => el("div", { class: "small muted" }, `reservation from ${x.name}: ${x.comment || "-"}`)),
        el("div", { class: "row" },
          el("button", { class: "ghost small", onclick: stance("support") }, "Support"),
          el("button", { class: "ghost small", onclick: stance("support-with-reservation") }, "Reservation"),
          el("button", { class: "ghost small", onclick: stance("object") }, "Object"),
          el("button", { class: "ghost small", onclick: stance("abstain") }, "Abstain"),
          c.met || (d.rule === "owner" && d.owner === me) || (d.rule === "advisory" && d.created_by === me) ? el("button", { class: "small", onclick: act(() => {
            const text = prompt("Decision:", p.body);
            if (text) return call("decide", { discussion: d.discussion, decision: text, proposal: p.proposal });
          }) }, "Decide") : null,
          holding ? el("button", { class: "small danger", onclick: act(() => {
            const text = prompt(`CRISIS ARBITRATION under ${holding.mandate} - recorded as such, never as consensus. Decision:`, p.body);
            if (!text) return;
            const reason = prompt("Reason (required):", "");
            if (reason) return call("decide", { discussion: d.discussion, decision: text, proposal: p.proposal, crisis: true, reason });
          }) }, "Arbitrate (crisis)") : null));
    }), ...discussionChat(d, msgs || [], drafts[d.discussion]))) : [el("p", { class: "muted small" }, "no open discussion")]));
  $("mandates").replaceChildren(...(mandates.length ? mandates.map((m) => el("div", { class: `disc mandate-${m.status}` },
    el("div", {}, el("span", { class: "id" }, m.mandate), el("b", {}, m.holder), el("span", { class: `tag${m.status === "active" ? " due" : ""}` }, m.status)),
    el("div", { class: "small" }, `${m.powers.join(", ")} · ${m.scope} · until ${m.expires_at.replace("T", " ").slice(0, 16)} · granted by ${m.granted_by.join(", ")}`),
    el("div", { class: "small muted" }, m.reason),
    m.acts.length ? el("div", { class: "small" }, `acts: ${m.acts.map((a) => a.discussion || a.entity).join(", ")}`) : null,
    m.review ? el("div", { class: "small" }, `post-crisis review: ${m.review}`) : null,
    m.status === "active" && (m.holder === me || meta.admin) ? el("button", { class: "ghost small", onclick: act(() => {
      const why = prompt(`End ${m.mandate} now - why?`, "");
      if (why) return call("mandate_revoke", { mandate: m.mandate, reason: why });
    }) }, m.holder === me ? "Hand it back" : "Revoke") : null))
    : [el("p", { class: "muted small" }, "No crisis mandate. Admins grant one with coord mandate grant <person> --reason ... --power decide --for 2d.")]));
}

// --- loading --------------------------------------------------------------
async function refresh() {
  if (!project) return;
  try {
    const [pres, agents, locks, strat, msgs, tasks, discs, routines, docs, ms, cands, mandates, ctx, recent] = await Promise.all([
      call("presence", { project }), call("agents", { project }), call("locks", { project }), call("memory", { project, kind: "strategy" }),
      call("inbox", { project, limit: 80 }), call("tasks", { project }), call("discussions", { project }),
      call("routines", { project }), call("docs", { project }), call("milestones", { project }),
      call("suggestions", { project }), call("mandates", { project }), call("context"), call("tasks", { project, view: "recent" })]);
    recentUnblocked = new Set(recent.map((t) => t.task));
    const members = await call("members", { project }).catch(() => ({ members: [] }));
    meta.admin = !members.members.length || members.members.some((m) => m.name === me && m.role === "admin");
    renderSessions(pres, agents); renderClaims(locks); renderStrategy(strat);
    renderMessages(msgs, new Set(ctx.awaiting.map((m) => m.id)));
    renderTasks(tasks); renderMilestones(ms); renderRoutines(routines);
    badge("b-docs", renderDocs(docs) + renderCandidates(cands));
    await renderDiscussions(discs, mandates, msgs);
    boxScrollBottom();
    badge("b-now", renderAttention(msgs, tasks, ctx.awaiting));
    badge("b-tasks", tasks.filter((t) => t.status === "offered" || (t.blocked_by?.length && t.status !== "done")).length);
    badge("b-discussions", discs.length);
    badge("b-routines", renderDue(routines));
    badge("b-overview", renderBoard(await call("dashboard", {})));
    await renderActivity();
  } catch (e) { toast(e.message); }
}

function listen() {
  stream?.close();
  stream = new EventSource(`/api/events?project=${encodeURIComponent(project)}&after=${state.lastEvent ?? 0}`);
  stream.onopen = () => $("live").classList.add("on");
  stream.onerror = () => $("live").classList.remove("on");
  stream.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    state.lastEvent = e.event;
    if (e.kind === "message.posted" && document.hidden && Notification?.permission === "granted") {
      new Notification("coord", { body: `new ${e.payload?.kind ?? "message"} in ${project}` });
    }
    clearTimeout(pending);
    pending = setTimeout(refresh, 250);        // bursts of events: one refresh
  };
}

function startReply(m) {
  replyTo = m.id;
  $("replying").textContent = `Replying to #${m.id} (${m.from}) - press Esc to cancel`;
  $("replying").classList.remove("hidden");
  $("body").focus();
}

$("compose").addEventListener("submit", act(async () => {
  const body = $("body").value.trim();
  if (!body) return;
  if (replyTo) await call("reply", { message: replyTo, body, kind: $("kind").value });
  else await call("post", { body, kind: $("kind").value, to: $("to").value || null, priority: $("priority").value });
  $("body").value = ""; replyTo = null; $("replying").classList.add("hidden");
}));
$("body").addEventListener("keydown", (e) => { if (e.key === "Escape") { replyTo = null; $("replying").classList.add("hidden"); } });
$("newtask").addEventListener("submit", act(async () => {
  const title = $("tasktitle").value.trim();
  if (!title) return;
  const after = $("taskafter").value.split(/[\s,]+/).filter(Boolean);
  await call("task_create", { title, assign: $("assign").value || null, after: after.length ? after : null });
  $("tasktitle").value = ""; $("taskafter").value = "";
}));
for (const b of document.querySelectorAll("#taskviews button")) b.addEventListener("click", () => { taskView = b.dataset.view; renderTasks(tasksCache); });
$("newlink").addEventListener("submit", act(async () => {
  const [task, other, reason] = [$("lk-task").value.trim(), $("lk-other").value.trim(), $("lk-reason").value.trim()];
  if (!task || !other) return;
  if (!reason) throw new Error("a link needs its reason - it stays in the history");
  await call("task_link", { task, after: [other], type: $("lk-type").value, reason });
  $("lk-task").value = ""; $("lk-other").value = ""; $("lk-reason").value = "";
}));
$("newmilestone").addEventListener("submit", act(async () => {
  const title = $("ms-title").value.trim();
  const criteria = $("ms-criteria").value.split(";").map((x) => x.trim()).filter(Boolean);
  if (!title) return;
  if (!criteria.length) throw new Error("a milestone needs at least one verifiable criterion");
  await call("milestone_create", { title, criteria, target: $("ms-target").value.trim() || null });
  $("ms-title").value = ""; $("ms-criteria").value = ""; $("ms-target").value = "";
}));
$("importform").addEventListener("submit", act(async () => {
  const file = $("imp-file").files?.[0];
  if (!file) throw new Error("choose a .txt or .md file");
  const content = await file.text();
  const readers = $("imp-readers").value.split(",").map((x) => x.trim()).filter(Boolean);
  const r = await call("doc_import", { title: $("imp-title").value.trim() || file.name, content, author: $("imp-author").value.trim(),
    context: $("imp-context").value, ai_assisted: $("imp-ai").value === "" ? null : $("imp-ai").value === "yes", source: file.name,
    written_at: $("imp-written").value.trim() || null, visibility: $("imp-vis").value, readers: readers.length ? readers : null });
  toast(`${r.document} deposited (${r.fingerprint.slice(0, 19)}…) - pending review`);
  $("importform").reset();
}));
$("refresh").addEventListener("click", () => refresh());
async function enter(name) {
  project = name;
  try { localStorage.setItem("coord.project", project); } catch { /* private window */ }
  me = (await call("context").catch(() => ({ me: {} }))).me.name;     // takes this project's session
  $("me").textContent = `you: ${me ?? state.me.name}`;
  await refresh();
  listen();
}
$("project").addEventListener("change", () => enter($("project").value));

(async () => {
  const r = await (await fetch("/api/state")).json();
  state = r.result;
  $("me").textContent = `you: ${state.me.name}`;
  $("version").textContent = `coord ${state.server.version}`;
  const busiest = [...state.projects].sort((x, y) => (y.live_sessions - x.live_sessions) || (y.messages - x.messages));
  const names = busiest.map((p) => p.project).filter((p) => p !== "(all)");
  const saved = (() => { try { return localStorage.getItem("coord.project"); } catch { return null; } })();
  const first = names.includes(saved) ? saved : names[0] || "default";
  $("project").replaceChildren(...names.map((n) => el("option", { value: n }, n)));
  $("act-project").replaceChildren(el("option", { value: "" }, "all projects"), ...names.map((n) => el("option", { value: n }, n)));
  $("project").value = first;
  if (window.Notification && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  state.lastEvent = state.last_event;
  await enter(first);
})();
