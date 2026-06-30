#!/usr/bin/env python3
"""Drive the forgeax-core TUI in a real PTY and dump the rendered screen.

Usage: ttydrive.py <rows> <cols> <step.json>
  step.json = {"cmd": ["bun","src/cli/main.ts","--demo"], "env": {...},
               "steps": [{"send":"hello","then_ms":400}, {"send":"<CR>","then_ms":600}, ...],
               "boot_ms": 900, "settle_ms": 700}

The PTY mechanics use only the Python stdlib (`pty`), so this runs anywhere
python3 exists. Screen rendering has two fidelity tiers (graceful degradation,
architecture-principles §9):
  - **pyte installed** → a real terminal emulator interprets ANSI into a 2D
    `rows x cols` screen (catches cursor placement / overwrites / soft-wrap).
  - **pyte missing**  → fall back to raw byte capture, ANSI-stripped to visible
    text lines. Good enough for "type → enter → see reply" interaction smokes.

Either way the visible text is printed between `==== SCREEN ====` and
`==== END ====` so a single wrapper can parse both tiers. Keys: see TOKENS
below (e.g. <CR> Enter, <ESC> Esc, <C-c> Ctrl+C, <UP>/<DOWN> arrows, <BS>
backspace) — or send the literal control bytes directly.
"""
import json, os, pty, re, select, struct, sys, time

rows, cols = int(sys.argv[1]), int(sys.argv[2])
spec = json.load(open(sys.argv[3]))

# ── rendering tier: pyte (2D screen) if available, else raw+ANSI-strip ────────
try:
    import pyte  # type: ignore

    _screen = pyte.Screen(cols, rows)
    _stream = pyte.ByteStream(_screen)
    USING_PYTE = True

    def feed(data: bytes) -> None:
        _stream.feed(data)

    def render_lines():
        return [line.rstrip() for line in _screen.display]

except ImportError:
    # pyte absent *or* installed-but-broken → degrade rather than abort (§9).
    USING_PYTE = False
    _raw = bytearray()
    _ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][AB0]|\x1b[=>]|\r")

    def feed(data: bytes) -> None:
        _raw.extend(data)

    def render_lines():
        text = _ANSI.sub(b"", bytes(_raw)).decode("utf-8", "replace")
        # collapse runs of blank lines so the visible content stays readable
        out, blank = [], 0
        for ln in text.split("\n"):
            ln = ln.rstrip()
            if ln == "":
                blank += 1
                if blank > 1:
                    continue
            else:
                blank = 0
            out.append(ln)
        return out

env = dict(os.environ)
env.update(spec.get("env", {}))
env["TERM"] = "xterm-256color"
env["COLUMNS"] = str(cols)
env["LINES"] = str(rows)

pid, fd = pty.fork()
if pid == 0:  # child
    try:
        os.execvpe(spec["cmd"][0], spec["cmd"], env)
    except Exception as e:
        sys.stderr.write(f"exec failed: {e}\n")
        os._exit(127)

# parent: set window size so Ink lays out to rows x cols
import fcntl, termios
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def pump(duration_ms):
    end = time.time() + duration_ms / 1000.0
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            feed(data)
    return True


TOKENS = {
    "<BS>": "\x7f", "<DEL>": "\x7f", "<BS8>": "\x08",
    "<ESC>": "\x1b", "<CR>": "\r", "<LF>": "\n", "<TAB>": "\t",
    "<C-c>": "\x03", "<C-o>": "\x0f", "<C-a>": "\x01", "<C-e>": "\x05",
    "<UP>": "\x1b[A", "<DOWN>": "\x1b[B", "<LEFT>": "\x1b[D", "<RIGHT>": "\x1b[C",
}


def expand(s):
    for k, v in TOKENS.items():
        s = s.replace(k, v)
    return s


pump(spec.get("boot_ms", 900))
for st in spec.get("steps", []):
    s = expand(st.get("send", ""))
    if s:
        os.write(fd, s.encode())
    pump(st.get("then_ms", 400))
pump(spec.get("settle_ms", 500))

# dump visible screen (uniform markers across both fidelity tiers)
tier = "pyte" if USING_PYTE else "raw"
print("==== SCREEN (%dx%d %s) ====" % (rows, cols, tier))
for line in render_lines():
    print(line)
print("==== END ====")

# Teardown: ask the child to quit, then *actually reap it* so no zombie/orphan
# `bun` TUI survives the run (a WNOHANG poll would return before a slow child
# exits). close(fd) is its own try so a failed write can't skip the fd close.
import signal

try:
    os.write(fd, b"\x03\x03")  # ctrl-c twice to exit cleanly
    time.sleep(0.2)
except OSError:
    pass
try:
    os.close(fd)
except OSError:
    pass
try:
    for _ in range(20):  # up to ~1s for a clean SIGINT exit
        if os.waitpid(pid, os.WNOHANG)[0]:
            break
        time.sleep(0.05)
    else:  # ignored Ctrl-C → force it down and reap for real
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
except (ChildProcessError, OSError):
    pass
