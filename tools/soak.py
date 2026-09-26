"""24 h soak: a server with renewals and SSE, kept working while time passes (T35).

    uv run tools/soak.py --minutes 5              # prove the harness before believing it
    uv run tools/soak.py --hours 24 --out docs/SOAK.md
    uv run tools/soak.py --hours 24 --json        # machine-readable samples only

A soak is not a load test (tools/load_test.py): this one runs *slowly*, for as long as it takes
for the things that only happen with time to happen. What it exercises:

- **client certificate renewal**, with `--renew-after-days` shortened so a renewal is due every
  few minutes instead of every 15 days - the client re-installs the certificate the server hands
  back, so the loop is the real one;
- **SSE across reconnects**: `/events/stream` closes itself after STREAM_MAX_SECONDS and the
  client comes back with Last-Event-ID, which is what a window or a following agent does;
- a steady trickle of writes, so the WAL, the checkpoint and the event log are in use the whole
  time.

It reports drift - latency, errors, WAL growth, the server's memory - rather than asserting a
number. Exit code 1 means something errored.
"""

import argparse
import contextlib
import json
import os
import shutil
import ssl
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from coordination.client import RemoteCoord  # noqa: E402
from coordination.pki import main as pki_main  # noqa: E402
from coordination.service import CoordError  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
STATE = Path(os.environ.get("COORD_SOAK_DIR") or (Path(os.environ.get("TEMP") or "/tmp") / "coord-soak"))


def free_port() -> int:
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def start_server(db: Path, pki_dir: Path, port: int, renew_days: float) -> subprocess.Popen:
    env = {k: v for k, v in os.environ.items() if not k.startswith("COORD_")}
    env["PYTHONPATH"] = str(REPO)
    # the server's output goes to a file, never a pipe: nobody drains a pipe, so its
    # logs would be lost - and a full pipe would wedge every request that logs
    logf = open(db.parent / "server.log", "w", encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, "-m", "coordination.server", "--port", str(port), "--db", str(db),
         "--pki", str(pki_dir), "--renew-after-days", str(renew_days)],
        cwd=str(REPO), env=env, stdout=logf, stderr=subprocess.STDOUT)
    deadline = time.time() + 60
    while time.time() < deadline:
        time.sleep(0.5)
        if proc.poll() is not None:
            raise SystemExit(f"server exited (see {logf.name})")
        if "coord-server on" in Path(logf.name).read_text(encoding="utf-8", errors="replace"):
            return proc
    raise SystemExit("server did not start")


def rss_bytes(pid: int) -> int | None:
    """Working set of the server, without adding a dependency: ctypes on Windows, /proc or ps
    elsewhere. Returns None where neither exists - the report says so instead of guessing."""
    if sys.platform == "win32":
        import ctypes
        import ctypes.wintypes as wt

        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD),
                        ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        h = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return None
        try:
            counters = PROCESS_MEMORY_COUNTERS()
            counters.cb = ctypes.sizeof(counters)
            ok = ctypes.windll.psapi.GetProcessMemoryInfo(h, ctypes.byref(counters), counters.cb)
            return int(counters.WorkingSetSize) if ok else None
        finally:
            ctypes.windll.kernel32.CloseHandle(h)
    try:
        with open(f"/proc/{pid}/statm") as f:                  # Linux: second field, in pages
            return int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    except (OSError, IndexError, ValueError):
        pass
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True)
        return int(out.stdout.strip()) * 1024 if out.stdout.strip() else None
    except Exception:
        return None


def sse_listener(url: str, project: str, ca: str, crt: str, key: str, stop: threading.Event,
                 stats: dict, lock: threading.Lock) -> None:
    """Follow /events/stream across its own reconnects: the server closes it after
    STREAM_MAX_SECONDS, and a real client comes back with Last-Event-ID. With --pki every request
    is mTLS, so this needs the client certificate too - not just the CA."""
    last_id, reconnects, opened = None, 0, 0
    ctx = ssl.create_default_context(cafile=ca)
    ctx.load_cert_chain(crt, key)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                         urllib.request.HTTPSHandler(context=ctx))
    while not stop.is_set():
        headers = {"Last-Event-ID": str(last_id)} if last_id is not None else {}
        req = urllib.request.Request(f"{url}/events/stream?project={project}", headers=headers)
        try:
            with opener.open(req, timeout=30) as r:
                opened += 1
                if r.headers.get("Content-Type") != "text/event-stream":
                    with lock:
                        stats["sse_error"] = "not text/event-stream"
                    return
                while not stop.is_set():
                    try:
                        line = r.readline()
                    except (TimeoutError, OSError):
                        continue
                    if not line:
                        break                                # the server closed: reconnect below
                    if line.startswith(b"id: "):
                        last_id = line[3:].strip().decode()
                    if line.startswith(b"data: "):
                        with lock:
                            stats["sse_events"] = stats.get("sse_events", 0) + 1
        except Exception as e:
            with lock:
                stats["sse_error"] = f"{type(e).__name__}: {e}"
            time.sleep(1)
            continue
        reconnects += 1
        with lock:
            stats["sse_reconnects"] = reconnects
            stats["sse_opens"] = opened
        if stop.is_set():
            return
        time.sleep(1)


def worker(i: int, url: str, ca: str, crt: str, key: str, stop: threading.Event,
           stats: dict, lock: threading.Lock) -> None:
    rc = RemoteCoord(url, ca=ca, cert=crt, key=key)
    try:
        sid = rc.whoami(family=f"soak{i}", project="soak")["session_id"]
    except Exception as e:                      # a client that cannot join must be reported, not lost
        with lock:
            stats["startup_error"] = f"agent{i} whoami: {type(e).__name__}: {e}"
        return
    n = 0
    last_hb = 0.0
    while not stop.is_set():
        # a session dies after 30 min without a heartbeat (SESSION_TTL): a real agent polls
        # about every 5 min, so do the same - otherwise every op fails past t+1800s and the
        # run measures a dead fleet instead of a working one
        if time.monotonic() - last_hb > 240:
            try:
                rc.heartbeat(session=sid, status=f"soak {i} tick {n}")
            except CoordError as e:
                err = e.code
            except Exception as e:
                err = type(e).__name__
            else:
                err = None
            with lock:
                s = stats.setdefault("heartbeat", {"n": 0, "ms": [], "err": {}})
                s["n"] += 1
                if err:
                    s["err"][err] = s["err"].get(err, 0) + 1
                    stats["errors"] = stats.get("errors", 0) + 1
            last_hb = time.monotonic()
        for op in ("claim", "post", "locks"):
            t0 = time.perf_counter()
            err = None
            try:
                if op == "claim":
                    rc.claim(session=sid, scope=f"src/soak/{i}/{n}.py", ttl=120)
                elif op == "post":
                    rc.post(session=sid, body=f"soak {i} tick {n}")
                else:
                    rc.locks(project="soak")
            except CoordError as e:
                err = e.code
            except Exception as e:
                err = type(e).__name__
            dt = (time.perf_counter() - t0) * 1000
            with lock:
                s = stats.setdefault(op, {"n": 0, "ms": [], "err": {}})
                s["n"] += 1
                if err:
                    s["err"][err] = s["err"].get(err, 0) + 1
                    stats["errors"] = stats.get("errors", 0) + 1
                else:
                    s["ms"].append(dt)
        n += 1
        time.sleep(1)                                        # a soak runs slowly, on purpose


def pct(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    v = sorted(values)
    return v[min(len(v) - 1, max(0, int(round(q / 100 * (len(v) - 1)))))]


def file_size(path: Path) -> int:
    """Size of a database file that may not be there. SQLite deletes the -wal and -shm files when
    its last connection closes, and this server opens a connection per request, so under light load
    they vanish between two samples. That is a fact about the files, not an error - a `exists()`
    then `stat()` here is a race, and losing the run to it is a monitor killing the experiment."""
    try:
        return path.stat().st_size
    except OSError:
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--hours", type=float, default=24)
    g.add_argument("--minutes", type=float)
    ap.add_argument("--agents", type=int, default=3)
    ap.add_argument("--renew-after-days", type=float, default=0.02,      # ~29 min: many renewals in a day
                    help="client certificates become due this often, so renewal is exercised")
    ap.add_argument("--out", help="write a markdown report here")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    duration = (a.minutes / 60) if a.minutes else a.hours

    if STATE.exists():
        shutil.rmtree(STATE)
    pki_dir, db = STATE / "pki", STATE / "soak.db"
    pki_dir.mkdir(parents=True)
    def run_pki(*args: str) -> None:
        with open(os.devnull, "w") as devnull, contextlib.redirect_stdout(devnull):
            rc = pki_main(["--dir", str(pki_dir), *args])
        if rc:
            raise SystemExit(f"pki {' '.join(args)} failed: {rc}")

    run_pki("init")
    run_pki("server-cert")
    # One identity per owner - never a shared bundle: Authority.confirm revokes the certificates a
    # renewed one supersedes, so two agents holding the same file would have one agent's renewal
    # revoke the certificate the other is still presenting. That is what real coord does too: one
    # certificate per CLI.
    def enroll(name: str) -> tuple[str, str, str]:
        b = STATE / name
        run_pki("enroll", name, "--out", str(b))
        return tuple(str(b / n) for n in ("ca.crt", "agent.crt", "agent.key"))  # type: ignore[return-value]

    identities = [enroll(f"soak{i}") for i in range(a.agents)]
    sse_id = enroll("soak-sse")

    port = free_port()
    proc = start_server(db, pki_dir, port, a.renew_after_days)
    # the certificate carries both SANs (DNS:localhost and IP:127.0.0.1), but localhost resolves to
    # ::1 first here and the server binds IPv4 only - every request would pay the fallback
    url = f"https://127.0.0.1:{port}"
    print(f"soak: {a.agents} agents, {duration:.2f} h against {url} "
          f"(renewal due every {a.renew_after_days * 1440:.0f} min)")

    stats: dict = {}
    lock = threading.Lock()
    stop = threading.Event()
    threads = [threading.Thread(target=worker,
                                args=(i, url, *identities[i], stop, stats, lock), daemon=True)
               for i in range(a.agents)]
    threads.append(threading.Thread(target=sse_listener,
                                    args=(url, "soak", *sse_id, stop, stats, lock), daemon=True))
    time.sleep(1)
    for t in threads:
        t.start()

    started = time.time()
    end = started + duration * 3600
    samples: list[dict] = []
    wal = Path(str(db) + "-wal")
    while time.time() < end:
        time.sleep(min(30, max(1, duration * 60)))
        try:
            with lock:
                snap = {"at": round(time.time() - started, 1),
                        "errors": stats.get("errors", 0),
                        "sse_events": stats.get("sse_events", 0),
                        "sse_reconnects": stats.get("sse_reconnects", 0),
                        **{op: stats[op]["n"] for op in ("claim", "post", "locks") if op in stats}}
            snap["rss"] = rss_bytes(proc.pid)
            snap["wal"] = file_size(wal)
            snap["db"] = file_size(db)
            samples.append(snap)
            if not a.json:
                print(f"  t+{snap['at']:7.0f}s  ops={sum(snap.get(k, 0) for k in ('claim','post','locks')):<7} "
                      f"errors={snap['errors']}  sse={snap['sse_events']} (reconnects {snap['sse_reconnects']})  "
                      f"rss={(snap['rss'] or 0)//1024//1024}MB  wal={snap['wal']//1024}KB", flush=True)
        except Exception as e:              # a monitor must never end the run it is watching
            with lock:
                stats["monitor_error"] = f"{type(e).__name__}: {e}"

    stop.set()
    for t in threads:
        t.join(timeout=40)

    with lock:
        elapsed = time.time() - started
        final = {"duration_s": round(elapsed, 1), "duration_h": round(elapsed / 3600, 3),
                 "startup_error": stats.get("startup_error"),
                 "monitor_error": stats.get("monitor_error"), "agents": a.agents,
                 "renew_after_days": a.renew_after_days,
                 "errors": stats.get("errors", 0),
                 "sse_events": stats.get("sse_events", 0),
                 "sse_reconnects": stats.get("sse_reconnects", 0),
                 "sse_opens": stats.get("sse_opens", 0),
                 "sse_error": stats.get("sse_error"),
                 "ops": {op: {"n": s["n"], "p50_ms": round(pct(s["ms"], 50), 2),
                              "p95_ms": round(pct(s["ms"], 95), 2),
                              "max_ms": round(max(s["ms"]), 2) if s["ms"] else 0,
                              "errors": s["err"]} for op, s in stats.items() if op in ("claim", "post", "locks")}}
    (STATE / "samples.json").write_text(json.dumps(samples, indent=1), encoding="utf-8")

    listing = subprocess.run([sys.executable, "-m", "coordination.pki", "--dir", str(pki_dir), "list"],
                             cwd=str(REPO), env={**os.environ, "PYTHONPATH": str(REPO)},
                             capture_output=True, text=True).stdout
    final["certificates"] = len([ln for ln in listing.splitlines() if "soak" in ln])
    (STATE / "summary.json").write_text(json.dumps(final, indent=1), encoding="utf-8")

    proc.terminate()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()

    if a.json:
        print(json.dumps(final, indent=1))
    else:
        print(f"\n{final['duration_h']:.2f} h, {final['errors']} errors, "
              f"{final['sse_events']} SSE events over {final['sse_opens']} opens "
              f"({final['sse_reconnects']} reconnects), {final['certificates']} certificates for 'soak'")
        for what in ("startup_error", "sse_error", "monitor_error"):
            if final.get(what):
                print(f"  !! {what}: {final[what]}")
        for op, s in final["ops"].items():
            print(f"  {op:<7} n={s['n']:<6} p50={s['p50_ms']:7.2f}ms p95={s['p95_ms']:8.2f}ms "
                  f"max={s['max_ms']:9.2f}ms errors={s['errors'] or '-'}")
        if samples:
            first, last = samples[0], samples[-1]
            print(f"  rss {first['rss']} -> {last['rss']} bytes; "
                  f"wal {first['wal']} -> {last['wal']}; db {first['db']} -> {last['db']}")
        print(f"  state: {STATE}")
    if a.out:
        Path(a.out).write_text(render(final, samples), encoding="utf-8")
        print(f"  report: {a.out}")
    if final.get("startup_error") or final.get("sse_error") or final.get("monitor_error"):
        return 1
    return 1 if final["errors"] else 0


def render(final: dict, samples: list[dict]) -> str:
    """The report the task asks for - what ran, what moved, what it means."""
    head = ["# Soak test - 24 h with renewals and SSE", "",
            f"*{final['duration_h']:.2f} h, {final['agents']} agents, generated by "
            f"`tools/soak.py`.*", "",
            "```", f"duration        {final['duration_h']} h",
            f"errors          {final['errors']}",
            f"SSE events      {final['sse_events']} over {final['sse_opens']} opens "
            f"({final['sse_reconnects']} reconnects)",
            f"certificates    {final['certificates']} issued to the soak client "
            f"(renewal due every {final['renew_after_days'] * 1440:.0f} min)", "```", ""]
    head.append("| op | n | p50 | p95 | max | errors |")
    head.append("|---|---|---|---|---|---|")
    for op, s in final["ops"].items():
        head.append(f"| {op} | {s['n']} | {s['p50_ms']} ms | {s['p95_ms']} ms | {s['max_ms']} ms | "
                    f"{s['errors'] or '-'} |")
    head.append("")
    if samples:
        head += ["| t | ops | errors | sse | rss | wal |", "|---|---|---|---|---|---|"]
        step = max(1, len(samples) // 20)
        for s in samples[::step]:
            head.append(f"| {s['at']:.0f}s | {sum(s.get(k, 0) for k in ('claim', 'post', 'locks'))} | "
                        f"{s['errors']} | {s['sse_events']} | {s['rss']} | {s['wal']} |")
    return "\n".join(head) + "\n"


if __name__ == "__main__":
    sys.exit(main())
