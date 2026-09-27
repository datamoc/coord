#!/usr/bin/env node
/**
 * coord - the agents' coordination CLI (TypeScript). Same commands, output and config as coord 0.2.1.
 *
 * Remote: COORD_SERVER (+ mTLS bundle or Keycloak, from ~/.config/coord/env or COORD_IDENTITY).
 * Local:  no COORD_SERVER - ops run on the repo's coord2.db through `coord-local` (no server).
 * Session: `coord whoami <family>` prints the id; pass it as COORD_SESSION (or .coord-session).
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CoordClient, tokenSource, transportFromEnv } from "./client.js";
import { ConfigError, hostIdentity, hostMarker, loadConfig } from "./config.js";
import { CoordError } from "./errors.js";
import { unifiedDiff } from "./diff.js";
import { userInfo } from "node:os";
import { fmtEvent, human } from "./format.js";
import { pollEvents } from "./transport.js";
import { detectProject, git, rel, repoRoot } from "./git.js";
import { CLIENT_VERSION, ENUMS } from "./ops.generated.js";
import { TokenProvider } from "./oidc.js";
class UsageError extends Error {
}
const K = ENUMS;
const s = (flag, extra = {}) => ({ flag, kind: "str", ...extra });
const i = (flag, extra = {}) => ({ flag, kind: "int", ...extra });
const b = (flag) => ({ flag, kind: "bool", default: false });
const kind = (def) => s("--kind", { default: def, choices: K.message_kinds });
/** The family to join as when the command did not name one: the identity of the CLI running us
 *  (COORD_IDENTITY, else the one named after the agent CLI that launched this process). One
 *  command file is shared by every CLI, so the agent must not pick the family itself - a Muse
 *  session was joining as `claude` because the shared text mentioned it. No marker, no guess. */
/** An explicit family must not name another CLI than the one running us: `coord whoami claude` from
 *  Muse would resume Claude's session and act as it. COORD_IDENTITY set by the human overrides. */
function checkFamily(family) {
    const host = hostMarker();
    if (family && host && family !== host && !process.env.COORD_IDENTITY) {
        throw new UsageError(`whoami: family '${family}' but this is the ${host} CLI - joining as another agent's `
            + `session would impersonate it. Run \`coord whoami\` with no family, or set COORD_IDENTITY`);
    }
}
/** A session run by a recognised agent CLI (Muse, opencode) must carry a model name, free-form
 *  (`--model spark-1.3`, `luna-6`): a bare user/family name is what let one CLI resume another's. */
function checkModel(model) {
    if (hostMarker() && !model && !process.env.COORD_MODEL) {
        throw new UsageError(`whoami: name this session's model - \`coord whoami --model spark-1.3\` (any short name, `
            + "e.g. luna-6), or set COORD_MODEL");
    }
}
function hostFamily() {
    const id = process.env.COORD_IDENTITY || hostIdentity();
    if (id)
        return id;
    throw new UsageError("whoami: no family given, and the agent CLI running this could not be "
        + "identified - pass one (coord whoami claude) or set COORD_IDENTITY");
}
const COMMANDS = {
    whoami: { help: "take (or resume) your session: user/family/model, e.g. michel/claude/sonnet; without a family it is the CLI running this",
        pos: [{ name: "family", nargs: "?" }], opts: [s("--model"), s("--user"), s("--project"), b("--human")] },
    heartbeat: { pos: [{ name: "status", nargs: "?", default: "" }] },
    end: { help: "end this session (its claims lapse)" },
    login: { help: "SSO device login (Keycloak): sign in once in a browser; tokens refresh by themselves" },
    logout: { help: "forget the stored SSO tokens" },
    presence: { opts: [b("--all"), s("--project")] },
    post: { help: "write to the project, to sessions (--to a,b) or a group (--group typescript); --priority high|urgent asks for an ack",
        pos: [{ name: "body" }], opts: [s("--to"), kind("info"), s("--claim"), s("--client-id"),
            s("--priority", { default: "normal", choices: K.message_priorities }), s("--group"),
            s("--task"), s("--doc"), s("--discussion")] },
    ack: { help: "say what you did with a message addressed to you: read, taken, done, declined \"why\"",
        pos: [{ name: "message", type: "int" }, { name: "state", nargs: "?", default: "taken", choices: K.ack_states },
            { name: "note", nargs: "?", default: "" }] },
    receipts: { help: "who a message went to and what each recipient did with it", pos: [{ name: "message", type: "int" }] },
    contacts: { help: "your contact policy and contacts in this project" },
    contact: { help: "who may write to you directly: policy open|auto|contacts_only|block_all; accept/block/remove a peer", sub: {
            policy: { pos: [{ name: "policy", choices: K.contact_policies }] },
            accept: { pos: [{ name: "peer" }] },
            block: { pos: [{ name: "peer" }] },
            remove: { pos: [{ name: "peer" }] },
        } },
    reply: { pos: [{ name: "message", type: "int" }, { name: "body" }], opts: [kind("info"), s("--client-id")] },
    inbox: { opts: [i("--after"), b("--to-me"), s("--from", { dest: "sender" }), s("--kind"), i("--limit", { default: 20 }),
            b("--all"), b("--unresolved"), s("--project")] },
    thread: { pos: [{ name: "message", type: "int" }] },
    resolve: { pos: [{ name: "message", type: "int" }, { name: "resolution", nargs: "?", default: "" }] },
    poll: { help: "new messages, your claims, tasks and discussions since the last poll" },
    claim: { help: "claim a file scope, or a shared resource: claim gpu:0 --resource gpu",
        pos: [{ name: "scope" }], opts: [b("--tree"), s("--note", { default: "" }), i("--ttl", { default: 7200 }),
            b("--release-on-commit"), s("--resource"), s("--client-id")] },
    renew: { pos: [{ name: "claim" }], opts: [i("--ttl", { default: 7200 })] },
    release: { pos: [{ name: "claim", nargs: "?" }], opts: [b("--all")] },
    locks: { opts: [b("--all"), s("--project")] },
    "fence-check": { pos: [{ name: "claim" }, { name: "fence", type: "int" }] },
    grant: { pos: [{ name: "claim" }, { name: "to" }, { name: "role", choices: K.roles }], opts: [s("--scope")] },
    delegate: { help: "hand part of your claim to another session (it claims and commits inside it; you keep the rest)",
        pos: [{ name: "claim" }], opts: [s("--to", { required: true }), s("--scope")] },
    revoke: { pos: [{ name: "claim" }, { name: "to" }, { name: "role", choices: K.roles }] },
    roles: { pos: [{ name: "claim" }] },
    role: { help: "answer a coeditor/delegate role offered on someone's claim", sub: {
            accept: { pos: [{ name: "claim" }, { name: "role", choices: K.roles }] },
            decline: { pos: [{ name: "claim" }, { name: "role", choices: K.roles }, { name: "reason", nargs: "?", default: "" }] },
        } },
    ask: { pos: [{ name: "body" }], opts: [s("--claim", { required: true }), s("--to", { required: true }),
            s("--role", { default: "advisor", choices: K.roles }), kind("question")] },
    members: { help: "who may view, participate, decide or administer a project (a roster makes it restricted)",
        opts: [s("--project")] },
    member: { help: "grant or remove a project role; in an open project the first member is yourself", sub: {
            set: { pos: [{ name: "name" }], opts: [s("--role", { required: true, choices: K.project_roles }),
                    s("--project"), s("--client-id")] },
            remove: { pos: [{ name: "name" }], opts: [s("--project"), s("--client-id")] },
        } },
    check: { pos: [{ name: "files", nargs: "*" }], opts: [s("--mode", { choices: ["fail", "warn"] })] },
    "post-commit": { opts: [s("--sha")] },
    "install-hooks": { help: "git pre-commit (coord check) and post-commit hooks",
        opts: [s("--mode", { default: "fail", choices: ["fail", "warn"] })] },
    discuss: { help: "open a discussion; consensus is computed from the participants' stances",
        pos: [{ name: "topic" }], opts: [s("--claim"), s("--with", { dest: "with_" }),
            s("--rule", { default: "unanimous", choices: K.consensus_rules }), i("--quorum"),
            s("--deadline"), { flag: "--weight", kind: "append", dest: "weights" },
            s("--threshold"), s("--quorum-weight"), s("--owner"), s("--domain")] },
    propose: { pos: [{ name: "discussion" }, { name: "body" }], opts: [s("--supersedes")] },
    react: { pos: [{ name: "proposal" }, { name: "stance", choices: K.stances }, { name: "comment", nargs: "?", default: "" }] },
    discussion: { pos: [{ name: "discussion" }] },
    discussions: { opts: [s("--project")] },
    decide: { help: "close a discussion; refused without consensus unless the opener passes --no-consensus \"reason\"",
        pos: [{ name: "discussion" }, { name: "decision" }], opts: [s("--proposal"), s("--no-consensus"), s("--reason", { default: "" }),
            b("--crisis")] },
    weight: { help: "a voting weight in this project, per domain (admins); no weight removes it",
        pos: [{ name: "name" }, { name: "weight", nargs: "?" }], opts: [s("--domain", { default: "" })] },
    weights: { help: "the project's voting weights" },
    mandate: { help: "crisis authority: a bounded, revocable mandate for a human (admins grant it, never to themselves)", sub: {
            grant: { pos: [{ name: "holder" }], opts: [s("--reason", { required: true }), { flag: "--power", kind: "append", dest: "powers" },
                    s("--for", { required: true, dest: "duration" }), s("--scope", { default: "" })] },
            revoke: { pos: [{ name: "mandate" }, { name: "reason" }] },
        } },
    mandates: { help: "crisis mandates, the acts taken under each and their post-crisis review" },
    crisis: { help: "acts under a crisis mandate: reassign a task, release a claim", sub: {
            reassign: { pos: [{ name: "task" }, { name: "reason" }], opts: [s("--to", { required: true })] },
            release: { pos: [{ name: "claim" }, { name: "reason" }] },
        } },
    doc: { help: "collaborative documents", sub: {
            create: { pos: [{ name: "title" }], opts: [s("--kind", { default: "note", choices: K.doc_kinds }), s("--file"), s("--content", { default: "" })] },
            import: { help: "deposit a .txt/.md note: a source document pending review, with its provenance - nothing in it runs",
                pos: [{ name: "file" }], opts: [s("--title"), s("--author"), s("--source"),
                    s("--context", { default: "reflection", choices: K.note_contexts }),
                    s("--ai", { default: "unknown", choices: ["yes", "no", "unknown"] }),
                    s("--written"), s("--visibility", { default: "project", choices: K.doc_visibility }),
                    { flag: "--reader", kind: "append", dest: "readers" }, s("--project")] },
            comment: { help: "comment on a document, optionally on a passage (--quote)", pos: [{ name: "document" }, { name: "body" }],
                opts: [s("--quote")] },
            comments: { pos: [{ name: "document" }] },
            reviewed: { help: "close the review of an imported note (decider)", pos: [{ name: "document" }, { name: "note", nargs: "?", default: "" }] },
            show: { pos: [{ name: "document" }], opts: [i("--revision")] },
            edit: { pos: [{ name: "document" }], opts: [i("--base-revision", { required: true }), s("--file"), s("--content"),
                    s("--message", { alias: "-m", default: "" })] },
            patch: { help: "edit with a unified diff - only the change is sent; non-overlapping concurrent edits merge",
                pos: [{ name: "document" }], opts: [i("--base-revision", { required: true }), s("--file"), s("--from"),
                    s("--message", { alias: "-m", default: "" })] },
            history: { pos: [{ name: "document" }] },
            list: { opts: [s("--kind")] },
        } },
    tasks: { help: "tasks; --graph draws them under their prerequisites; --view ready|blocked|unowned|recent|milestones",
        opts: [s("--status"), s("--project"), b("--graph"), s("--view", { choices: ["ready", "blocked", "unowned", "recent", "milestones"] }),
            s("--assigned")] },
    task: { sub: {
            create: { pos: [{ name: "title" }], opts: [s("--description", { default: "" }), i("--priority", { default: 0 }), s("--claim"),
                    s("--assign"), s("--category"), s("--after"), b("--human-ack")] },
            update: { help: "edit what a task says - title, description, priority, category (creator, assignee or decider); status keeps its own path: accept, done, decline, cancel",
                pos: [{ name: "task" }], opts: [s("--title"), s("--description"), i("--priority"), s("--category")] },
            link: { help: "T3 after T1,T2: T3 cannot be accepted until they are done (--remove to unlink); context without blocking: --type enables (T1 enables T3), related_to, duplicates, part_of (T3 part_of T1)",
                pos: [{ name: "task" }], opts: [s("--after", { required: true }), b("--remove"),
                    s("--type", { default: "blocks", choices: K.link_types }), s("--condition"), s("--reason", { default: "" })] },
            waive: { help: "lift one blocking prerequisite explicitly, with its reason (decider)",
                pos: [{ name: "task" }, { name: "reason" }], opts: [s("--after", { required: true })] },
            accept: { pos: [{ name: "task" }] },
            done: { pos: [{ name: "task" }, { name: "note", nargs: "?", default: "" }] },
            ack: { help: "close a task created with --human-ack in one step (any participant; the UI button calls this)",
                pos: [{ name: "task" }, { name: "note", nargs: "?", default: "" }] },
            decline: { pos: [{ name: "task" }, { name: "reason", nargs: "?", default: "" }] },
            show: { pos: [{ name: "task" }] },
            cancel: { pos: [{ name: "task" }, { name: "note", nargs: "?", default: "" }] },
            notify: { pos: [{ name: "task" }], opts: [s("--url", { required: true }), s("--token"), s("--auth-scheme"), s("--auth-credentials")] },
        } },
    milestones: { help: "the timeline: milestones reached and upcoming, criteria met, what blocks them, target history" },
    milestone: { help: "a verifiable result: criteria, owner, a target date whose revisions are kept", sub: {
            create: { pos: [{ name: "title" }], opts: [{ flag: "--criterion", kind: "append", dest: "criteria" }, s("--target"), s("--owner"),
                    s("--scope", { default: "" }), s("--after")] },
            criterion: { pos: [{ name: "milestone" }, { name: "n", type: "int" }], opts: [b("--unmet"), s("--note", { default: "" })] },
            target: { help: "revise the target (a date, 30d, or none) - the previous ones stay, with this reason",
                pos: [{ name: "milestone" }, { name: "target" }, { name: "reason" }] },
            reach: { pos: [{ name: "milestone" }, { name: "note", nargs: "?", default: "" }] },
        } },
    "unblock-points": { help: "unfinished tasks whose completion would make others ready now" },
    candidates: { help: "candidates drawn from notes and messages, and their review", opts: [s("--source"), s("--status")] },
    candidate: { help: "propose a task/decision/memory/question/summary from a source (DOC3 or #12), citing its passage; a decider accepts or rejects", sub: {
            add: { pos: [{ name: "source" }, { name: "target", choices: K.suggestion_targets }, { name: "title" }],
                opts: [s("--quote"), s("--body", { default: "" }), s("--nature", { default: "fact", choices: K.suggestion_natures }),
                    s("--memory-kind", { choices: K.memory_kinds })] },
            accept: { pos: [{ name: "suggestion" }, { name: "note", nargs: "?", default: "" }], opts: [s("--title"), s("--body")] },
            reject: { pos: [{ name: "suggestion" }, { name: "reason" }] },
        } },
    pause: { help: "say you pause (your work stays assigned; a wake-up request can bring you back)",
        pos: [{ name: "reason", nargs: "?", default: "" }] },
    agents: { help: "who took part: session state (active/idle/paused/ended/unreachable) apart from their pending work",
        opts: [s("--project")] },
    wake: { help: "ask an agent to resume (why: task/message/question/unblocked/review), follow it, answer it", sub: {
            request: { pos: [{ name: "agent" }], opts: [s("--reason", { default: "task", choices: K.wake_reasons }), s("--ref"),
                    s("--note", { default: "" })] },
            answer: { pos: [{ name: "wake" }, { name: "answer", choices: ["accept", "refuse"] }, { name: "note", nargs: "?", default: "" }] },
            list: { opts: [s("--agent"), b("--open")] },
            hook: { help: "the webhook that wakes an agent, a family or * (admins); no --url removes it",
                pos: [{ name: "target" }], opts: [s("--url"), s("--token")] },
        } },
    setting: { help: "a project rule (admins): wake_auto off|propose|request, mandate_max_days N",
        pos: [{ name: "key" }, { name: "value" }] },
    settings: {},
    dashboard: { help: "what needs a human's attention, per project: agents, sleeping work, waiting answers, blocked votes...",
        opts: [s("--project")] },
    activity: { help: "the activity stream as readable lines; filter by --actor, --kind (task, wake...), --since 2h",
        opts: [s("--project"), s("--actor"), s("--kind"), s("--since"), i("--limit", { default: 50 })] },
    audit: { help: "the history of one object: T12, D4, DOC3, S2, W5, A1, C9", pos: [{ name: "entity" }] },
    memory: { sub: {
            show: { opts: [s("--kind", { choices: K.memory_kinds })] },
            search: { pos: [{ name: "query" }] },
            add: { pos: [{ name: "kind", choices: K.memory_kinds }, { name: "title" }], opts: [s("--file"), s("--content"), s("--source", { default: "" })] },
            edit: { pos: [{ name: "memory" }], opts: [i("--base-revision", { required: true }), s("--file"), s("--content"), b("--archive")] },
        } },
    strategy: { help: "the project's common strategy (memory kind strategy): goals and ways of working every agent follows" },
    routines: { help: "recurring work (security review, docs...): what is due, running, last result",
        opts: [b("--due"), b("--all")] },
    routine: { help: "a routine comes back every interval and/or after commits touching its paths", sub: {
            create: { pos: [{ name: "title" }], opts: [s("--every"), b("--on-commit"), { flag: "--path", kind: "append", dest: "paths" },
                    s("--instructions"), s("--file")] },
            show: { pos: [{ name: "routine" }] },
            start: { help: "take this run (one runner at a time; the lease frees itself after an hour)", pos: [{ name: "routine" }] },
            done: { pos: [{ name: "routine" }, { name: "result", nargs: "?", default: "" }],
                opts: [s("--outcome", { default: "ok", choices: K.routine_outcomes })] },
            edit: { pos: [{ name: "routine" }], opts: [s("--title"), s("--every"), s("--instructions"), s("--file"),
                    { flag: "--path", kind: "append", dest: "paths" }] },
            pause: { pos: [{ name: "routine" }] },
            resume: { pos: [{ name: "routine" }] },
            retire: { pos: [{ name: "routine" }] },
        } },
    server: { help: "the server's version, features, what is new, ops and limits - and this client's version" },
    context: { help: "start-of-session view: strategy, overview, memory, due routines, my claims, tasks, discussions, unread" },
    profile: { opts: [s("--provider"), s("--model"), s("--family"), s("--category"), s("--reasoning"), { flag: "--capability", kind: "append" }] },
    suggest: { help: "suggest agents for a task (hint only; you choose)",
        opts: [s("--task"), s("--prefer-category"), { flag: "--capability", kind: "append" }, s("--reasoning")] },
    "agent-card": { help: "the server's A2A Agent Card (skills, security schemes, endpoint)" },
    projects: {},
    status: { opts: [s("--project")] },
    events: { help: "the project's event log; --follow streams it live (server-sent events) until Ctrl-C",
        opts: [i("--after", { default: 0 }), b("--follow"), s("--project")] },
};
const dest = (o) => o.dest ?? o.flag.replace(/^--/, "").replace(/-/g, "_");
function usage(path, c) {
    if (c.sub)
        return `usage: coord ${path.join(" ")} {${Object.keys(c.sub).join(",")}} ...`;
    const opts = (c.opts ?? []).map((o) => (o.required ? "" : "[") + o.flag + (o.kind === "bool" ? "" : ` ${dest(o).toUpperCase()}`) + (o.required ? "" : "]"));
    const pos = (c.pos ?? []).map((p) => (p.nargs === "?" ? `[${p.name}]` : p.nargs === "*" ? `[${p.name} ...]` : p.name));
    return `usage: coord ${path.join(" ")} ${[...opts, ...pos].join(" ")}`.trimEnd() + (c.help ? `\n\n${c.help}` : "");
}
function topUsage() {
    return "usage: coord [--json] <command> ...\n\ncommands:\n"
        + Object.entries(COMMANDS).map(([n, c]) => `  ${n.padEnd(14)}${c.help ?? ""}`).join("\n")
        + "\n\nRun `coord <command> --help` for its arguments.";
}
function convert(v, type, choices, what) {
    if (choices && !choices.includes(v))
        throw new UsageError(`argument ${what}: invalid choice: '${v}' (choose from ${choices.join(", ")})`);
    if (type === "int") {
        if (!/^-?\d+$/.test(v))
            throw new UsageError(`argument ${what}: invalid int value: '${v}'`);
        return Number(v);
    }
    return v;
}
export function parse(argv) {
    let json = false;
    const tokens = argv.filter((t) => (t === "--json" ? ((json = true), false) : true));
    const path = [];
    let spec = { sub: COMMANDS };
    while (spec.sub) {
        const name = tokens.shift();
        if (!name || name === "-h" || name === "--help")
            throw new UsageError(path.length ? usage(path, spec) : topUsage());
        if (!spec.sub[name])
            throw new UsageError(`${path.length ? usage(path, spec) : "usage: coord [--json] <command> ..."}\ncoord: invalid choice: '${name}'`);
        path.push(name);
        spec = spec.sub[name];
    }
    const ns = {};
    for (const o of spec.opts ?? [])
        ns[dest(o)] = o.kind === "append" ? null : o.default ?? null;
    for (const p of spec.pos ?? [])
        ns[p.name] = p.nargs === "*" ? [] : p.default ?? null;
    const positionals = [];
    const seen = new Set();
    while (tokens.length) {
        const t = tokens.shift();
        if (t === "-h" || t === "--help")
            throw new UsageError(usage(path, spec));
        if (t === "--") {
            positionals.push(...tokens.splice(0));
            break;
        }
        if (t.startsWith("-") && t.length > 1 && !/^-\d/.test(t)) {
            const [flag, inline] = t.includes("=") ? [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1)] : [t, undefined];
            const o = (spec.opts ?? []).find((x) => x.flag === flag || x.alias === flag);
            if (!o)
                throw new UsageError(`${usage(path, spec)}\ncoord: unrecognized arguments: ${t}`);
            seen.add(o.flag);
            if (o.kind === "bool") {
                ns[dest(o)] = true;
                continue;
            }
            const v = inline ?? tokens.shift();
            if (v === undefined)
                throw new UsageError(`argument ${o.flag}: expected one argument`);
            if (o.kind === "append")
                (ns[dest(o)] ??= []).push(v);
            else
                ns[dest(o)] = convert(v, o.kind === "int" ? "int" : "str", o.choices, o.flag);
            continue;
        }
        positionals.push(t);
    }
    for (const o of spec.opts ?? [])
        if (o.required && !seen.has(o.flag))
            throw new UsageError(`${usage(path, spec)}\ncoord: the following arguments are required: ${o.flag}`);
    const pos = spec.pos ?? [];
    for (const p of pos) {
        if (p.nargs === "*") {
            ns[p.name] = positionals.splice(0).map((v) => convert(v, p.type, p.choices, p.name));
            continue;
        }
        const v = positionals.shift();
        if (v === undefined) {
            if (p.nargs === "?")
                continue;
            throw new UsageError(`${usage(path, spec)}\ncoord: the following arguments are required: ${pos.filter((x) => !x.nargs).map((x) => x.name).join(", ")}`);
        }
        ns[p.name] = convert(v, p.type, p.choices, p.name);
    }
    if (positionals.length)
        throw new UsageError(`${usage(path, spec)}\ncoord: unrecognized arguments: ${positionals.join(" ")}`);
    return { path, ns, json };
}
// --- commands --------------------------------------------------------------
const sessionFile = () => join(repoRoot(), ".coord-session");
function loadSession() {
    if (process.env.COORD_SESSION)
        return process.env.COORD_SESSION;
    const f = sessionFile();
    return existsSync(f) ? readFileSync(f, "utf8").trim() : null;
}
function readContent(a) {
    if (a.file)
        return readFileSync(a.file, "utf8");
    if (a.content !== null && a.content !== undefined)
        return a.content;
    return readFileSync(0, "utf8"); // stdin
}
const uuid = () => randomUUID();
/** "0.6" -> 0.6; nothing -> null; anything else is a usage error. */
const num = (v, what) => {
    if (v === null || v === undefined || v === "")
        return null;
    const n = Number(v);
    if (!Number.isFinite(n))
        throw new UsageError(`argument ${what}: invalid number: '${v}'`);
    return n;
};
/** "T1,T2" / "T1 T2" -> ["T1", "T2"]; nothing -> undefined. */
const list = (v) => (v ? v.split(/[\s,]+/).filter(Boolean) : undefined);
/** The user part of a session (michel/claude/sonnet): COORD_USER, else the OS user; COORD_USER="" drops it. */
function sessionUser() {
    if (process.env.COORD_USER !== undefined)
        return process.env.COORD_USER || null;
    try {
        return userInfo().username;
    }
    catch {
        return null;
    }
}
const vkey = (v) => v.split(".").map((x) => parseInt(x, 10) || 0);
/** A server newer than this client has features with no command here; an older one lacks newer commands. */
export function versionSkew(server, client = CLIENT_VERSION) {
    if (!server || server === "0" || server === client)
        return null;
    const [s, c] = [vkey(server), vkey(client)];
    const cmp = s.map((x, i) => x - (c[i] ?? 0)).find((d) => d !== 0) ?? 0;
    if (cmp > 0)
        return `coord server ${server} is newer than this client ${client}: update the coord plugin (coord server lists what is new)`;
    if (cmp < 0)
        return `coord server ${server} is older than this client ${client}: commands added since answer bad_op - tell the human`;
    return null;
}
const gitLines = (...args) => git(...args).split("\n").filter(Boolean);
export async function run(path, a, c) {
    const S = loadSession;
    /** Reads go further with a session (a restricted project needs one) but must keep working before whoami. */
    const maybeS = () => { try {
        return S();
    }
    catch {
        return null;
    } };
    const call = (op, args) => c.call(op, args);
    const cmd = path[0];
    switch (cmd) {
        case "whoami": {
            checkFamily(a.family);
            checkModel(a.model);
            const r = await call("whoami", { family: a.family || hostFamily(), project: a.project || detectProject(), client_id: uuid(),
                user: a.user ?? sessionUser(), model: a.model || process.env.COORD_MODEL || null,
                ...(a.human ? { human: true } : {}) });
            // .coord-session is shared by every session in this checkout: never overwrite one that still
            // belongs to a live session, or that session would silently start acting as this one.
            let old = process.env.COORD_SESSION ? null : loadSession();
            if (old) {
                try {
                    await call("context", { session: old });
                }
                catch (e) {
                    //only a gone session frees the file: `forbidden` is a live session under another identity (another CLI)
                    if (e instanceof CoordError && ["dead_session", "unknown_session", "no_session"].includes(e.code))
                        old = null;
                    else if (!(e instanceof CoordError))
                        throw e;
                }
            }
            if (old)
                r.warning = `${sessionFile()} belongs to another live session; left as is - prefix your commands with COORD_SESSION=${r.session_id}`;
            else if (!process.env.COORD_SESSION) {
                try {
                    writeFileSync(sessionFile(), r.session_id + "\n");
                }
                catch { /* read-only */ }
            }
            const skew = versionSkew(r.server?.version);
            if (skew)
                r.server_warning = skew;
            return [cmd, r, 0];
        }
        case "heartbeat": return [cmd, await call("heartbeat", { session: S(), status: a.status }), 0];
        case "end": return [cmd, await call("end", { session: S() }), 0];
        case "presence": return [cmd, await call("presence", { project: a.project, include_dead: a.all, session: maybeS() }), 0];
        case "post": return [cmd, await call("post", { session: S(), body: a.body, kind: a.kind, to: a.to, claim: a.claim, priority: a.priority,
                to_group: a.group, task: a.task, document: a.doc, discussion: a.discussion,
                client_id: a.client_id || uuid() }), 0];
        case "ack": return [cmd, await call("ack", { session: S(), message: a.message, state: a.state, note: a.note }), 0];
        case "receipts": return [cmd, await call("receipts", { message: a.message, session: maybeS() }), 0];
        case "contacts": return [cmd, await call("contacts", { session: S() }), 0];
        case "contact": return [cmd, path[1] === "policy" ? await call("contact_policy", { session: S(), policy: a.policy })
                : await call("contact", { session: S(), peer: a.peer, action: path[1] }), 0];
        case "reply": return [cmd, await call("reply", { session: S(), message: a.message, body: a.body, kind: a.kind, client_id: a.client_id || uuid() }), 0];
        case "inbox": return [cmd, await call("inbox", { session: S(), after: a.after, to_me: a.to_me, sender: a.sender, kind: a.kind,
                project: a.project, limit: a.all ? null : a.limit, unresolved: a.unresolved }), 0];
        case "thread": return [cmd, await call("thread", { message: a.message, session: S() }), 0];
        case "resolve": return [cmd, await call("resolve", { session: S(), message: a.message, resolution: a.resolution }), 0];
        case "poll": return [cmd, await call("poll", { session: S() }), 0];
        case "claim": return [cmd, await call("claim", { session: S(), scope: a.resource ? a.scope : rel(a.scope), tree: a.tree || null, note: a.note,
                ttl: a.ttl, release_on_commit: a.release_on_commit, resource: a.resource ?? null,
                client_id: a.client_id || uuid() }), 0];
        case "renew": return [cmd, await call("renew", { session: S(), claim: a.claim, ttl: a.ttl }), 0];
        case "release": return [cmd, await call("release", { session: S(), claim: a.claim, all: a.all }), 0];
        case "locks": return [cmd, await call("locks", { project: a.project || detectProject(), all: a.all, session: maybeS() }), 0];
        case "fence-check": return [cmd, await call("fence_check", { claim: a.claim, fence: a.fence, session: maybeS() }), 0];
        case "grant": return [cmd, await call("grant", { session: S(), claim: a.claim, to: a.to, role: a.role,
                ...(a.scope ? { scope: rel(a.scope) } : {}) }), 0];
        case "delegate": return ["grant", await call("grant", { session: S(), claim: a.claim, to: a.to, role: "delegate",
                ...(a.scope ? { scope: rel(a.scope) } : {}) }), 0];
        case "revoke": return [cmd, await call(cmd, { session: S(), claim: a.claim, to: a.to, role: a.role }), 0];
        case "roles": return [cmd, await call("roles", { claim: a.claim, session: maybeS() }), 0];
        case "role": return [cmd, path[1] === "accept" ? await call("role_accept", { session: S(), claim: a.claim, role: a.role })
                : await call("role_decline", { session: S(), claim: a.claim, role: a.role, reason: a.reason }), 0];
        case "ask": return [cmd, await call("ask", { session: S(), claim: a.claim, to: a.to, body: a.body, role: a.role, kind: a.kind, client_id: uuid() }), 0];
        case "check": {
            const files = a.files.length ? a.files.map(rel) : gitLines("diff", "--cached", "--name-only");
            const r = await call("check", { session: S(), files });
            const mode = a.mode || process.env.COORD_CHECK_MODE || "fail";
            if (mode !== "fail" && mode !== "warn")
                throw new UsageError(`--mode must be fail or warn, not ${mode}`);
            return [cmd, { ...r, mode }, r.ok || mode === "warn" ? 0 : 1];
        }
        case "post-commit": {
            const sha = a.sha || git("rev-parse", "HEAD");
            return [cmd, await call("post_commit", { session: S(), sha, files: gitLines("diff-tree", "--no-commit-id", "--name-only", "-r", sha) }), 0];
        }
        case "install-hooks": {
            const hooks = join(repoRoot(), ".git", "hooks");
            const exe = `"${process.execPath}" "${fileURLToPath(import.meta.url)}"`;
            const guard = '[ -z "$COORD_SESSION" ] && [ ! -f .coord-session ] && exit 0';
            writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\n${guard}\n${exe} check --mode ${a.mode}\n`);
            writeFileSync(join(hooks, "post-commit"), `#!/bin/sh\n${guard}\n${exe} post-commit || true\n`);
            for (const h of ["pre-commit", "post-commit"]) {
                try {
                    chmodSync(join(hooks, h), 0o755);
                }
                catch { /* not POSIX */ }
            }
            return [cmd, { installed: [join(hooks, "pre-commit"), join(hooks, "post-commit")] }, 0];
        }
        case "members": return [cmd, await call("members", { session: maybeS(), project: a.project || detectProject() }), 0];
        case "member": return [cmd, path[1] === "remove"
                ? await call("member_remove", { session: S(), name: a.name, project: a.project, client_id: a.client_id || uuid() })
                : await call("member_set", { session: S(), name: a.name, role: a.role, project: a.project, client_id: a.client_id || uuid() }), 0];
        case "discuss": return [cmd, await call("discuss", { session: S(), topic: a.topic, claim: a.claim, rule: a.rule, quorum: a.quorum,
                deadline: a.deadline,
                participants: a.with_ ? String(a.with_).split(",").map((x) => x.trim()).filter(Boolean) : null,
                weights: a.weights, threshold: num(a.threshold, "--threshold"),
                quorum_weight: num(a.quorum_weight, "--quorum-weight"), owner: a.owner, domain: a.domain,
                client_id: uuid() }), 0];
        case "propose": return [cmd, await call("propose", { session: S(), discussion: a.discussion, body: a.body,
                supersedes: a.supersedes, client_id: uuid() }), 0];
        case "react": return [cmd, await call("react", { session: S(), proposal: a.proposal, stance: a.stance, comment: a.comment }), 0];
        case "discussion": return [cmd, await call("discussion", { discussion: a.discussion, session: maybeS() }), 0];
        case "discussions": return [cmd, await call("discussions", { project: a.project || detectProject(), session: maybeS() }), 0];
        case "decide": return [cmd, await call("decide", { session: S(), discussion: a.discussion, decision: a.decision, proposal: a.proposal,
                consensus: a.no_consensus === null,
                reason: a.no_consensus ?? a.reason, crisis: a.crisis }), 0];
        case "weight": return [cmd, await call("weight_set", { session: S(), name: a.name, weight: num(a.weight, "weight"), domain: a.domain }), 0];
        case "weights": return [cmd, await call("weights", { project: detectProject(), session: maybeS() }), 0];
        case "mandate": return [cmd, path[1] === "grant"
                ? await call("mandate_grant", { session: S(), holder: a.holder, reason: a.reason, powers: a.powers ?? [], duration: a.duration,
                    scope: a.scope, client_id: uuid() })
                : await call("mandate_revoke", { session: S(), mandate: a.mandate, reason: a.reason }), 0];
        case "mandates": return [cmd, await call("mandates", { project: detectProject(), session: maybeS() }), 0];
        case "crisis": return [cmd, path[1] === "reassign"
                ? await call("crisis_reassign", { session: S(), task: a.task, to: a.to, reason: a.reason })
                : await call("crisis_release", { session: S(), claim: a.claim, reason: a.reason }), 0];
        case "doc": {
            switch (path[1]) {
                case "create": return ["doc", await call("doc_create", { session: S(), title: a.title, kind: a.kind, content: a.file ? readContent(a) : a.content, client_id: uuid() }), 0];
                case "import": return ["doc-import", await call("doc_import", { session: S(), title: a.title || basename(a.file),
                        content: readContent(a), author: a.author || "",
                        context: a.context,
                        ai_assisted: a.ai === "unknown" ? null : a.ai === "yes",
                        source: a.source || a.file, written_at: a.written ?? null,
                        visibility: a.visibility, readers: a.readers,
                        project: a.project ?? null, client_id: uuid() }), 0];
                case "comment": return ["doc", await call("doc_comment", { session: S(), document: a.document, body: a.body, quote: a.quote }), 0];
                case "comments": return ["doc-comments", await call("doc_comments", { document: a.document, session: maybeS() }), 0];
                case "reviewed": return ["doc", await call("doc_reviewed", { session: S(), document: a.document, note: a.note }), 0];
                case "show": return ["doc-show", await call("doc_show", { document: a.document, revision: a.revision, session: maybeS() }), 0];
                case "edit": return ["doc", await call("doc_edit", { session: S(), document: a.document, base_revision: a.base_revision, content: readContent(a), message: a.message, client_id: uuid() }), 0];
                case "patch": { // --from: diff the edited file against that revision here, send only the diff
                    let patch;
                    if (a.from) {
                        const base = await call("doc_show", { document: a.document, revision: a.base_revision, session: maybeS() });
                        patch = unifiedDiff(base.content, readFileSync(a.from, "utf8"), 3, [`${a.document}@r${a.base_revision}`, a.from]);
                        if (!patch)
                            throw new CoordError("no_change", `${a.from} is identical to ${a.document} revision ${a.base_revision}`);
                    }
                    else {
                        patch = a.file ? readFileSync(a.file, "utf8") : readFileSync(0, "utf8");
                    }
                    return ["doc", await call("doc_patch", { session: S(), document: a.document, base_revision: a.base_revision,
                            patch, message: a.message, client_id: uuid() }), 0];
                }
                case "history": return ["doc", await call("doc_history", { document: a.document, session: maybeS() }), 0];
                default: return ["doc", await call("docs", { project: detectProject(), kind: a.kind, session: maybeS() }), 0];
            }
        }
        case "tasks": return [a.graph ? "tasks-graph" : cmd, await call("tasks", { project: a.project || detectProject(), status: a.status,
                view: a.view, assigned: a.assigned, session: maybeS() }), 0];
        case "task": {
            switch (path[1]) {
                case "create": return ["task", await call("task_create", { session: S(), title: a.title, description: a.description, priority: a.priority,
                        claim: a.claim, assign: a.assign, category: a.category,
                        after: list(a.after), human_ack: a.human_ack,
                        client_id: uuid() }), 0];
                case "update": return ["task", await call("task_update", { session: S(), task: a.task, title: a.title,
                        description: a.description, priority: a.priority,
                        category: a.category }), 0];
                case "link": return ["task", await call("task_link", { session: S(), task: a.task, after: list(a.after) ?? [], remove: a.remove,
                        type: a.type, condition: a.condition, reason: a.reason }), 0];
                case "waive": return ["task", await call("task_waive", { session: S(), task: a.task, after: a.after, reason: a.reason }), 0];
                case "accept": return ["task", await call("task_accept", { session: S(), task: a.task }), 0];
                case "ack": return ["task", await call("task_ack", { session: S(), task: a.task, note: a.note }), 0];
                case "show": return ["task", await call("task_get", { task: a.task, session: maybeS() }), 0];
                case "decline": return ["task", await call("task_decline", { session: S(), task: a.task, reason: a.reason }), 0];
                case "cancel": return ["task", await call("task_cancel", { session: S(), task: a.task, note: a.note }), 0];
                case "notify": { // A2A push notifications: the server POSTs status updates to --url
                    const auth = a.auth_scheme ? { authentication: { scheme: a.auth_scheme, credentials: a.auth_credentials ?? "" } } : {};
                    return ["task", await c.a2a("CreateTaskPushNotificationConfig", { taskId: a.task, url: a.url, ...(a.token ? { token: a.token } : {}), ...auth }), 0];
                }
                default: return ["task", await call("task_done", { session: S(), task: a.task, note: a.note }), 0];
            }
        }
        case "milestones": return [cmd, await call("milestones", { project: detectProject(), session: maybeS() }), 0];
        case "milestone": {
            switch (path[1]) {
                case "create": return ["milestone", await call("milestone_create", { session: S(), title: a.title, criteria: a.criteria ?? [],
                        target: a.target, owner: a.owner, scope: a.scope,
                        after: list(a.after), client_id: uuid() }), 0];
                case "criterion": return ["milestone", await call("milestone_criterion", { session: S(), milestone: a.milestone, criterion: a.n,
                        met: !a.unmet, note: a.note }), 0];
                case "target": return ["milestone", await call("milestone_target", { session: S(), milestone: a.milestone,
                        target: a.target === "none" ? null : a.target, reason: a.reason }), 0];
                default: return ["milestone", await call("milestone_reach", { session: S(), milestone: a.milestone, note: a.note }), 0];
            }
        }
        case "unblock-points": return [cmd, await call("unblock_points", { project: detectProject(), session: maybeS() }), 0];
        case "candidates": return [cmd, await call("suggestions", { project: detectProject(), source: a.source, status: a.status, session: maybeS() }), 0];
        case "candidate": {
            switch (path[1]) {
                case "add": return ["candidate", await call("suggestion_add", { session: S(), source: a.source, target: a.target, title: a.title,
                        quote: a.quote, body: a.body, nature: a.nature,
                        memory_kind: a.memory_kind, client_id: uuid() }), 0];
                case "accept": return ["candidate", await call("suggestion_review", { session: S(), suggestion: a.suggestion, accept: true,
                        note: a.note, title: a.title, body: a.body }), 0];
                default: return ["candidate", await call("suggestion_review", { session: S(), suggestion: a.suggestion, accept: false,
                        note: a.reason }), 0];
            }
        }
        case "pause": return [cmd, await call("pause", { session: S(), reason: a.reason }), 0];
        case "agents": return [cmd, await call("agents", { project: a.project || detectProject(), session: maybeS() }), 0];
        case "wake": {
            switch (path[1]) {
                case "request": return ["wake", await call("wake_request", { session: S(), agent: a.agent, reason: a.reason, ref: a.ref,
                        note: a.note, client_id: uuid() }), 0];
                case "answer": return ["wake", await call("wake_answer", { session: S(), wake: a.wake, accept: a.answer === "accept", note: a.note }), 0];
                case "hook": return ["wake", await call("wake_hook_set", { session: S(), target: a.target, url: a.url, token: a.token }), 0];
                default: return ["wake-list", await call("wake_requests", { project: detectProject(), target: a.agent, open_only: a.open,
                        session: maybeS() }), 0];
            }
        }
        case "setting": return [cmd, await call("setting_set", { session: S(), key: a.key, value: a.value }), 0];
        case "settings": return [cmd, await call("settings", { project: detectProject(), session: maybeS() }), 0];
        case "dashboard": return [cmd, await call("dashboard", { project: a.project, session: maybeS() }), 0];
        case "activity": return [cmd, await call("activity", { project: a.project || detectProject(), actor: a.actor, kind: a.kind,
                since: a.since, limit: a.limit, session: maybeS() }), 0];
        case "audit": return ["activity", await call("audit", { entity: a.entity, session: maybeS() }), 0];
        case "memory": {
            switch (path[1]) {
                case "show": return ["memory", await call("memory", { project: detectProject(), kind: a.kind, session: maybeS() }), 0];
                case "search": return ["memory", await call("memory", { project: detectProject(), query: a.query, session: maybeS() }), 0];
                case "add": return ["memory-add", await call("memory_add", { session: S(), kind: a.kind, title: a.title, content: readContent(a), source: a.source, client_id: uuid() }), 0];
                default: return ["memory-edit", await call("memory_edit", { session: S(), memory: a.memory, base_revision: a.base_revision, content: readContent(a),
                        status: a.archive ? "archived" : null }), 0];
            }
        }
        case "strategy": return ["memory", await call("memory", { project: detectProject(), kind: "strategy", session: maybeS() }), 0];
        case "routines": {
            const r = await call("routines", { project: detectProject(), due: a.due, include_retired: a.all, session: maybeS() });
            return [cmd, r, 0];
        }
        case "routine": {
            const text = () => (a.file ? readFileSync(a.file, "utf8") : a.instructions);
            switch (path[1]) {
                case "create": return ["routine-new", await call("routine_create", { session: S(), title: a.title, instructions: text() ?? "",
                        every: a.every, on_commit: a.on_commit, paths: a.paths, client_id: uuid() }), 0];
                case "show": return ["routine", await call("routine_get", { routine: a.routine, session: maybeS() }), 0];
                case "start": return ["routine-start", await call("routine_start", { session: S(), routine: a.routine }), 0];
                case "done": return ["routine-done", await call("routine_done", { session: S(), routine: a.routine, result: a.result, outcome: a.outcome }), 0];
                case "edit": return ["routine", await call("routine_update", { session: S(), routine: a.routine, title: a.title, every: a.every,
                        instructions: text(), paths: a.paths }), 0];
                default: {
                    const status = { pause: "paused", resume: "active", retire: "retired" }[path[1]];
                    return ["routine", await call("routine_update", { session: S(), routine: a.routine, status }), 0];
                }
            }
        }
        case "server": return [cmd, { ...(await call("server_info", {})), client_version: CLIENT_VERSION }, 0];
        case "context": return [cmd, await call("context", { session: S() }), 0];
        case "profile": return [cmd, await call("profile_set", { session: S(), provider: a.provider, model_id: a.model, model_family: a.family,
                category: a.category, reasoning_level: a.reasoning, capabilities: a.capability }), 0];
        case "suggest": return [cmd, await call("suggest", { project: detectProject(), category: a.prefer_category, capability: a.capability,
                reasoning_level: a.reasoning, exclude_session: S(), session: maybeS() }), 0];
        case "agent-card": return [cmd, await c.agentCard(), 0];
        case "projects": return [cmd, await call("projects", { session: maybeS() }), 0];
        case "status": return [cmd, await call("status", { project: a.project, session: maybeS() }), 0];
        case "events": {
            const project = a.project || detectProject();
            if (!a.follow)
                return [cmd, await call("events", { after: a.after, project, session: maybeS() }), 0];
            const stop = new AbortController();
            process.once("SIGINT", () => stop.abort());
            const t = c.transport;
            const follow = t.follow ? t.follow.bind(t) : (p, af, on, s) => pollEvents(t, p, af, on, s, 2000, maybeS());
            await follow(project, a.after, (e) => process.stdout.write((process.argv.includes("--json") ? JSON.stringify(e) : fmtEvent(e)) + "\n"), stop.signal, maybeS());
            return ["events-followed", null, 0];
        }
    }
    throw new UsageError(`unhandled command ${cmd}`);
}
export async function main(argv = process.argv.slice(2)) {
    let parsed;
    try {
        parsed = parse(argv);
    }
    catch (e) {
        if (e instanceof UsageError) {
            const help = argv.includes("-h") || argv.includes("--help") || !argv.filter((x) => x !== "--json").length;
            (help ? process.stdout : process.stderr).write(e.message + "\n");
            return help ? 0 : 2;
        }
        throw e;
    }
    const { path, ns, json } = parsed;
    let cmd, r, code;
    try {
        loadConfig(process.env);
        if (path[0] === "login" || path[0] === "logout") {
            const tp = tokenSource(process.env);
            if (!(tp instanceof TokenProvider)) {
                throw new CoordError("oidc_config", "set COORD_OIDC_ISSUER and COORD_OIDC_CLIENT_ID (and unset COORD_TOKEN) to use SSO login");
            }
            [cmd, r, code] = [path[0], path[0] === "login" ? await tp.login() : await tp.logout(), 0];
        }
        else {
            [cmd, r, code] = await run(path, ns, new CoordClient(transportFromEnv(process.env)));
        }
    }
    catch (e) {
        if (e instanceof ConfigError) {
            process.stderr.write(`coord: ${e.message}\n`);
            return 1;
        }
        if (!(e instanceof CoordError))
            throw e;
        if (json)
            process.stdout.write(JSON.stringify({ ok: false, error: e.code, message: e.message, data: e.data }) + "\n");
        else
            process.stderr.write(`error (${e.code}): ${e.message}\n`);
        return 1;
    }
    if (cmd === "events-followed")
        return code;
    if (json)
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    else {
        if (cmd === "whoami")
            process.stdout.write(`you are ${r.name} (gen ${r.generation}, project ${r.project})\nexport COORD_SESSION=${r.session_id}\n`);
        else
            process.stdout.write(human(cmd, r) + "\n");
        if (r && typeof r === "object" && !Array.isArray(r) && r.warning)
            process.stderr.write(`warning: ${r.warning}\n`);
    }
    return code;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === (await import("node:fs")).realpathSync(process.argv[1])) {
    main().then((c) => process.exit(c), (e) => { process.stderr.write(`coord: ${e?.stack ?? e}\n`); process.exit(1); });
}
