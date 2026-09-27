import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse, run, versionSkew } from "../dist/cli.js";
import { CoordClient } from "../dist/client.js";
import { hostMarker, loadConfig } from "../dist/config.js";
import { canonicalProject } from "../dist/git.js";
import { OPS } from "../dist/ops.generated.js";
import { bypassProxy } from "../dist/transport.js";
import { REPO, cleanEnv, serverDbEnv, tmp } from "./helpers.mjs";

test("startServer: a test that forgets COORD_DB gets a temp file, never the checkout's", () => {
  const clean = cleanEnv();
  const def = serverDbEnv([], clean);
  assert.ok(def.COORD_DB, "a database is always set");
  assert.ok(def.COORD_DB.includes("coordts-"), def.COORD_DB);            // a tmp() directory
  assert.notEqual(def.COORD_DB, join(REPO, "coord2.db"));
  assert.ok(!def.COORD_DB.startsWith(REPO), def.COORD_DB);               // not state_home()
  assert.equal(serverDbEnv([], cleanEnv({ COORD_DB: "/x/y.db" })).COORD_DB, "/x/y.db");  // explicit wins
  assert.ok(!("COORD_DB" in serverDbEnv(["--db", "/z/w.db"], clean)), "--db in args wins too");
});

test("project ids match the shared vectors (same as the Python server)", () => {
  const { vectors } = JSON.parse(readFileSync(join(REPO, "schema/project-vectors.json"), "utf8"));
  for (const [url, id] of vectors) assert.equal(canonicalProject(url), id, url);
});

test("config: env wins, only COORD_*, relative paths from the file's real dir, pointer file", () => {
  const home = tmp();
  const dir = join(home, "coord", "alice");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "env"), "# comment\nexport COORD_SERVER=https://localhost:1337\nCOORD_CA=ca.crt\nCOORD_KEY='~/k.key'\nCOORD_PROJECT=from-file\nOTHER=x\n");
  const env = { XDG_CONFIG_HOME: home, COORD_PROJECT: "from-env" };
  try {
    symlinkSync(join("alice", "env"), join(home, "coord", "env"));                     // default = symlink
  } catch {                                                                            // Windows w/o privilege
    writeFileSync(join(home, "coord", "env"), "COORD_IDENTITY=alice\n");
  }
  assert.equal(loadConfig(env), realpathSync(join(dir, "env")));                      // Windows: 8.3 temp names
  assert.equal(env.COORD_SERVER, "https://localhost:1337");
  assert.equal(env.COORD_CA, join(realpathSync(dir), "ca.crt"));                       // real dir, not the link's
  assert.equal(env.COORD_KEY, join(homedir(), "k.key"));
  assert.equal(env.COORD_PROJECT, "from-env");
  assert.equal(env.OTHER, undefined);
  const home2 = tmp();                                                                 // default = pointer file
  mkdirSync(join(home2, "coord", "bob"), { recursive: true });
  writeFileSync(join(home2, "coord", "bob", "env"), "COORD_SERVER=https://b\n");
  writeFileSync(join(home2, "coord", "env"), "# default identity\nCOORD_IDENTITY=bob\n");
  const env2 = { XDG_CONFIG_HOME: home2 };
  loadConfig(env2);
  assert.equal(env2.COORD_SERVER, "https://b");
  assert.throws(() => loadConfig({ XDG_CONFIG_HOME: home2, COORD_IDENTITY: "ghost" }), /coord-admin enroll/);
});

test("config: an enrolled identity named after the host CLI wins over the default", () => {
  const home = tmp();
  for (const name of ["bob", "muse"]) {
    mkdirSync(join(home, "coord", name), { recursive: true });
    writeFileSync(join(home, "coord", name, "env"), `COORD_SERVER=https://${name}\n`);
  }
  writeFileSync(join(home, "coord", "env"), "COORD_IDENTITY=bob\n");
  const muse = { XDG_CONFIG_HOME: home, MUSE_SESSION_ID: "s1" };
  loadConfig(muse);
  assert.equal(muse.COORD_SERVER, "https://muse");
  const opencode = { XDG_CONFIG_HOME: home, OPENCODE: "1" };                          // not enrolled: default
  loadConfig(opencode);
  assert.equal(opencode.COORD_SERVER, "https://bob");
  const pinned = { XDG_CONFIG_HOME: home, MUSE_SESSION_ID: "s1", COORD_IDENTITY: "bob" };   // explicit wins
  loadConfig(pinned);
  assert.equal(pinned.COORD_SERVER, "https://bob");
});

test("no server and no coord-local: the error names the identity file it looked for", async () => {
  const cfg = join(tmp(), "nowhere", "env");
  const env = { COORD_CONFIG: cfg, COORD_LOCAL: "coord-local-that-does-not-exist", COORD_DB: join(tmp(), "x.db") };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  delete process.env.COORD_SERVER;
  try {
    await assert.rejects(CoordClient.fromEnv(env).call("locks", {}),
      (e) => e.code === "local_unavailable" && e.message.includes(cfg) && e.message.includes("coord-admin enroll"));
  } finally {
    for (const k of Object.keys(env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("argument parsing: defaults, ints, choices, required, --json anywhere, aliases", () => {
  const p = parse(["claim", "src/", "--tree", "--note=why", "--json"]);
  assert.deepEqual(p.path, ["claim"]);
  assert.equal(p.json, true);
  assert.equal(p.ns.tree, true);
  assert.equal(p.ns.note, "why");
  assert.equal(p.ns.ttl, 7200);
  assert.equal(parse(["reply", "12", "ok"]).ns.message, 12);
  assert.equal(parse(["doc", "edit", "DOC1", "--base-revision", "3", "-m", "msg", "--content", "x"]).ns.message, "msg");
  assert.deepEqual(parse(["profile", "--capability", "a", "--capability", "b"]).ns.capability, ["a", "b"]);
  assert.throws(() => parse(["post", "hi", "--kind", "nope"]), /invalid choice/);
  assert.throws(() => parse(["ask", "hi", "--to", "x"]), /required: --claim/);
  assert.throws(() => parse(["reply", "x", "y"]), /invalid int/);
  assert.throws(() => parse(["claim", "a", "b"]), /unrecognized/);
});

test("every CLI command sends a known op with only known params and all required ones", async () => {
  const EMPTY = join(tmp(), "empty.diff");                              // not /dev/null: Windows has none
  writeFileSync(EMPTY, "");
  const sent = [];
  const fake = new CoordClient({ async send(op, args) { sent.push([op, args]); return { ok: true, result: fakeResult(op) }; } });
  const fakeResult = (op) => ({ whoami: { session_id: "s", name: "x-01", generation: 1, project: "p" }, check: { ok: true, conflicts: [] } })[op] ?? {};
  const samples = [
    ["whoami", "x"], ["heartbeat", "busy"], ["end"], ["presence", "--all"], ["post", "hi", "--to", "b-01", "--kind", "question", "--claim", "C1"],
    ["reply", "3", "ok"], ["inbox", "--after", "2", "--to-me", "--from", "b-01", "--unresolved", "--all"], ["thread", "3"], ["resolve", "3", "done"],
    ["poll"], ["claim", "src/", "--tree", "--release-on-commit"], ["renew", "C1"], ["release", "--all"], ["locks", "--all"],
    ["fence-check", "C1", "4"], ["grant", "C1", "b-01", "delegate"], ["revoke", "C1", "b-01", "delegate"], ["roles", "C1"],
    ["ask", "why?", "--claim", "C1", "--to", "b-01"], ["check", "a.py"], ["post-commit", "--sha", "abc"], ["discuss", "topic", "--with", "b-01,c-01", "--rule", "majority", "--quorum", "3", "--deadline", "48h"],
    ["propose", "D1", "idea"], ["react", "P1", "support", "+1"], ["discussion", "D1"], ["discussions"], ["decide", "D1", "go", "--proposal", "P1", "--no-consensus", "deadline"],
    ["doc", "create", "T", "--content", "x"], ["doc", "show", "DOC1"], ["doc", "edit", "DOC1", "--base-revision", "1", "--content", "y"],
    ["doc", "history", "DOC1"], ["doc", "patch", "DOC1", "--base-revision", "1", "--file", EMPTY], ["doc", "list"], ["tasks", "--status", "open"], ["task", "create", "T", "--assign", "b-01"], ["task", "create", "T", "--human-ack"],
    ["task", "accept", "T1"], ["task", "create", "T", "--after", "T1,T2"], ["task", "link", "T3", "--after", "T1", "--remove"],
    ["tasks", "--graph"], ["task", "done", "T1", "note"], ["task", "ack", "T1", "thanks"], ["task", "show", "T1"], ["task", "cancel", "T1"], ["task", "decline", "T1", "busy"],
    ["task", "update", "T1", "--title", "Renamed", "--priority", "3", "--category", "tests"],
    ["role", "accept", "C1", "delegate"], ["role", "decline", "C1", "coeditor", "not mine"], ["memory", "show"], ["memory", "search", "q"],
    ["memory", "add", "pitfall", "T", "--content", "c"], ["memory", "edit", "M1", "--base-revision", "1", "--content", "c", "--archive"],
    ["context"], ["profile", "--category", "reasoning", "--capability", "debugging"], ["suggest", "--prefer-category", "reasoning"],
    ["projects"], ["status"], ["events"], ["strategy"], ["routines", "--due", "--all"],
    ["routine", "create", "Sec", "--every", "1d", "--on-commit", "--path", "src/", "--instructions", "audit"], ["routine", "show", "R1"],
    ["routine", "start", "R1"], ["routine", "done", "R1", "clean", "--outcome", "issues"], ["routine", "edit", "R1", "--every", "6h"],
    ["routine", "pause", "R1"], ["routine", "resume", "R1"], ["routine", "retire", "R1"], ["server"],
    ["delegate", "C1", "--to", "b-01", "--scope", "src/x/"], ["grant", "C1", "b-01", "delegate", "--scope", "src/x/"],
    ["propose", "D1", "better idea", "--supersedes", "P1"], ["react", "P1", "support-with-reservation", "small doubt"],
    ["members"], ["member", "set", "b-01", "--role", "viewer"], ["member", "remove", "b-01"],
    ["doc", "import", EMPTY, "--title", "Retro", "--author", "alice", "--context", "meeting", "--ai", "yes",
     "--written", "2026-09-20", "--visibility", "private", "--reader", "b-01", "--project", "other"],
    ["post", "look", "--to", "a-01,b-01", "--priority", "urgent", "--task", "T1", "--doc", "DOC1", "--discussion", "D1"],
    ["post", "ts folks", "--group", "typescript"], ["ack", "3", "declined", "busy"], ["receipts", "3"],
    ["contacts"], ["contact", "policy", "contacts_only"], ["contact", "accept", "b-01"], ["contact", "block", "c-01"],
    ["claim", "gpu:0", "--resource", "gpu"], ["whoami", "ui", "--human"],
    ["discuss", "vote", "--with", "b-01", "--rule", "weighted", "--deadline", "2h", "--weight", "b-01=2", "--threshold", "0.6",
     "--quorum-weight", "0.5", "--domain", "architecture"], ["discuss", "style", "--rule", "owner", "--owner", "b-01"],
    ["decide", "D1", "go", "--crisis", "--reason", "deadlock"], ["weight", "b-01", "2.5", "--domain", "arch"], ["weights"],
    ["mandate", "grant", "alice/ui", "--reason", "deadlock", "--power", "decide", "--for", "2d"], ["mandate", "revoke", "A1", "over"],
    ["mandates"], ["crisis", "reassign", "T1", "overloaded", "--to", "b-01"], ["crisis", "release", "C1", "blocks"],
    ["doc", "comment", "DOC1", "which?", "--quote", "the boss"], ["doc", "comments", "DOC1"], ["doc", "reviewed", "DOC1"],
    ["tasks", "--view", "ready", "--assigned", "b-01"], ["task", "link", "T3", "--after", "T1", "--type", "enables", "--reason", "ctx"],
    ["task", "link", "T3", "--after", "T1", "--condition", "tests pass"], ["task", "waive", "T3", "stubbed", "--after", "T1"],
    ["milestones"], ["milestone", "create", "Playable", "--criterion", "a full game", "--target", "30d", "--after", "T1"],
    ["milestone", "criterion", "T5", "1", "--note", "3 runs"], ["milestone", "target", "T5", "none", "slipped"], ["milestone", "reach", "T5"],
    ["unblock-points"], ["candidates", "--source", "DOC1"], ["candidate", "add", "DOC1", "task", "Fix it", "--quote", "boss"],
    ["candidate", "accept", "S1", "ok", "--title", "Fix"], ["candidate", "reject", "S2", "not an order"],
    ["pause", "quota"], ["agents"], ["wake", "request", "q-01", "--reason", "unblocked", "--ref", "T3"], ["wake", "answer", "W1", "refuse", "quota"],
    ["wake", "list", "--open"], ["wake", "hook", "qwen", "--url", "http://127.0.0.1:9/w"], ["setting", "wake_auto", "request"], ["settings"],
    ["dashboard"], ["activity", "--actor", "b-01", "--kind", "task", "--since", "2h"], ["audit", "T1"],
  ];
  process.env.COORD_SESSION = "s";
  process.env.COORD_PROJECT = "p";
  try {
    for (const argv of samples) {
      const { path, ns } = parse(argv);
      await run(path, ns, fake);
    }
  } finally {
    delete process.env.COORD_SESSION;
    delete process.env.COORD_PROJECT;
  }
  const schema = JSON.parse(readFileSync(join(REPO, "schema/ops.json"), "utf8")).ops;
  for (const [op, args] of sent) {
    assert.ok(OPS[op], `unknown op ${op}`);
    const names = schema[op].params.map((p) => p.name);
    for (const k of Object.keys(args)) assert.ok(names.includes(k), `${op}: unknown param ${k}`);
    for (const p of schema[op].params) if (p.required) assert.ok(args[p.name] !== undefined && args[p.name] !== null, `${op}: missing ${p.name}`);
  }
  const used = new Set(sent.map(([op]) => op));
  assert.deepEqual(Object.keys(OPS).filter((op) => !used.has(op)), [], "every server op is reachable from the CLI");
});

test("whoami joins as the CLI running it, never as another CLI's family", async () => {
  // One command file is shared by every CLI, so the family cannot be the agent's guess: a Muse
  // session was joining as `claude`. It comes from the identity of the CLI that launched us.
  const home = tmp();
  mkdirSync(join(home, "coord", "muse"), { recursive: true });
  writeFileSync(join(home, "coord", "muse", "env"), "COORD_SERVER=https://localhost:1337\n");
  const keys = ["XDG_CONFIG_HOME", "MUSE_SESSION_ID", "COORD_IDENTITY", "COORD_SESSION", "COORD_PROJECT"];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  const sent = [];
  const fake = new CoordClient({ async send(op, args) {
    sent.push([op, args]);
    return { ok: true, result: { session_id: "s", name: "muse-01", generation: 1, project: "p" } };
  } });
  try {
    process.env.XDG_CONFIG_HOME = home;
    process.env.MUSE_SESSION_ID = "muse-01";
    delete process.env.COORD_IDENTITY;
    process.env.COORD_SESSION = "s";
    process.env.COORD_PROJECT = "p";

    let p = parse(["whoami"]);                       // under Muse a model name is required
    await assert.rejects(() => run(p.path, p.ns, fake), /name this session's model/);
    p = parse(["whoami", "claude", "--model", "spark-1.3"]);   // and never another CLI's family
    await assert.rejects(() => run(p.path, p.ns, fake), /would impersonate/);
    p = parse(["whoami", "--model", "spark-1.3"]);   // no family at all
    await run(p.path, p.ns, fake);
    assert.equal(sent.at(-1)[1].family, "muse");
    assert.equal(sent.at(-1)[1].model, "spark-1.3");

    process.env.COORD_IDENTITY = "gemini";           // an explicit identity wins over the marker
    p = parse(["whoami", "--model", "luna-6"]);
    await run(p.path, p.ns, fake);
    assert.equal(sent.at(-1)[1].family, "gemini");

    p = parse(["whoami", "explicit", "--model", "luna-6"]);               // and an argument wins over both
    await run(p.path, p.ns, fake);
    assert.equal(sent.at(-1)[1].family, "explicit");

    delete process.env.COORD_IDENTITY;
    delete process.env.MUSE_SESSION_ID;
    p = parse(["whoami"]);
    await assert.rejects(() => run(p.path, p.ns, fake), /could not be identified/);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("check --mode warn/fail: exit code, not the sent op (T22)", async () => {
  const fake = new CoordClient({ async send(op, args) {
    assert.equal(op, "check"); assert.deepEqual(Object.keys(args).sort(), ["files", "session"].sort());
    return { ok: true, result: { ok: false, conflicts: [{ file: "a.py", claim: "C1", owner: "b-01", scope: "a.py" }] } };
  } });
  process.env.COORD_SESSION = "s"; process.env.COORD_PROJECT = "p";
  try {
    const { path: p1, ns: n1 } = parse(["check", "a.py"]);
    const [, r1, code1] = await run(p1, n1, fake);
    assert.equal(code1, 1); assert.equal(r1.mode, "fail");
    const { path: p2, ns: n2 } = parse(["check", "a.py", "--mode", "warn"]);
    const [, r2, code2] = await run(p2, n2, fake);
    assert.equal(code2, 0); assert.equal(r2.mode, "warn");
    process.env.COORD_CHECK_MODE = "warn";
    const { path: p3, ns: n3 } = parse(["check", "a.py"]);
    const [, , code3] = await run(p3, n3, fake);
    assert.equal(code3, 0);
  } finally {
    delete process.env.COORD_SESSION; delete process.env.COORD_PROJECT; delete process.env.COORD_CHECK_MODE;
  }
  assert.throws(() => parse(["check", "a.py", "--mode", "nope"]), /invalid choice/);
});

test("NO_PROXY handling", () => {
  const env = { NO_PROXY: "localhost,.dci.local,exact.example" };
  assert.ok(bypassProxy("127.0.0.1", env));
  assert.ok(bypassProxy("gitlab.dci.local", env));
  assert.ok(bypassProxy("dci.local", env));
  assert.ok(bypassProxy("exact.example", env));
  assert.ok(!bypassProxy("other.example", env));
  assert.ok(bypassProxy("anything", { no_proxy: "*" }));
});

test("whoami warns when the server and this client are on different versions", () => {
  assert.equal(versionSkew("0.5.0", "0.5.0"), null);
  assert.equal(versionSkew(undefined, "0.5.0"), null);
  assert.match(versionSkew("0.6.0", "0.5.0"), /server 0\.6\.0 is newer than this client 0\.5\.0: update the coord plugin/);
  assert.match(versionSkew("0.4.0", "0.5.0"), /server 0\.4\.0 is older than this client 0\.5\.0: .*bad_op/);
  assert.match(versionSkew("0.10.0", "0.9.9"), /newer/);                     // numeric, not string, order
});

test("pollEvents: in order, resumes after the last id, stops on abort", async () => {
  const { pollEvents } = await import("../dist/transport.js");
  const { fmtEvent } = await import("../dist/format.js");
  const log = [{ event: 5, kind: "claim.acquired", entity: "claim", id: "3", payload: { scope: "src/" }, at: "t" },
               { event: 6, kind: "message.posted", entity: "message", id: "9", payload: {}, at: "t" }];
  const asked = [];
  const fake = { async send(op, args) { asked.push(args.after); return { ok: true, result: log.filter((e) => e.event > args.after) }; } };
  const stop = new AbortController(), seen = [];
  await pollEvents(fake, "p", 4, (e) => { seen.push(e.event); if (seen.length === 2) stop.abort(); }, stop.signal, 5);
  assert.deepEqual(seen, [5, 6]);
  assert.equal(asked[0], 4);
  assert.equal(fmtEvent(log[0]), '#5 t claim.acquired claim 3 {"scope":"src/"}');
});

test("the project is read from .git/config when git refuses the checkout (sandbox: dubious ownership)", async () => {
  const { originFromConfig, findCheckout, canonicalProject } = await import("../dist/git.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const root = tmp(), sub = join(root, "src", "deep");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(root, ".git", "config"), '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/other/x.git\n'
    + '[remote "origin"]\n\turl = https://github.com/datamoc/mwg-pixel-dungeon.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n');
  assert.equal(findCheckout(sub).root, root);
  assert.equal(canonicalProject(originFromConfig(sub)), "github.com/datamoc/mwg-pixel-dungeon");
  const wt = tmp();                                                     // a worktree: .git is a file
  writeFileSync(join(wt, ".git"), `gitdir: ${join(root, ".git", "worktrees", "w")}\n`);
  mkdirSync(join(root, ".git", "worktrees", "w"), { recursive: true });
  writeFileSync(join(root, ".git", "worktrees", "w", "commondir"), "../..\n");
  assert.equal(canonicalProject(originFromConfig(wt)), "github.com/datamoc/mwg-pixel-dungeon");
});

test("hostMarker names the CLI running us, enrolled or not", () => {
  assert.equal(hostMarker({ MUSE_SESSION_ID: "x" }), "muse");
  assert.equal(hostMarker({ OPENCODE: "1" }), "opencode");
  assert.equal(hostMarker({}), null);
});
