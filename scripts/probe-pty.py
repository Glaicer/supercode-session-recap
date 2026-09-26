import fcntl
import os
import re
import select
import signal
import struct
import subprocess
import sys
import termios

master, slave = os.openpty()
child = subprocess.Popen(
    sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True
)
os.close(slave)


def resize(rows, cols):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    try:
        os.killpg(child.pid, signal.SIGWINCH)
    except ProcessLookupError:
        pass


resize(45, 160)

# The TUI asks the terminal for its theme colors (OSC 10/11) and reacts to the
# theme-change notification (CSI ?997). Answering those queries here makes a
# live light/dark switch scriptable from the probe.
THEMES = {
    "dark": {"10": "#e6e6e6", "11": "#14141a"},
    "light": {"10": "#24292e", "11": "#f5f5f0"},
}
theme = "dark"
osc_query = re.compile(rb"\x1b\](10|11);\?(?:\x07|\x1b\\)")
osc_pending = b""


def answer_osc(data):
    global osc_pending
    osc_pending += data
    while True:
        match = osc_query.search(osc_pending)
        if not match:
            # Keep a tail that may hold the beginning of a split query.
            osc_pending = osc_pending[-16:]
            return
        number = match.group(1).decode()
        os.write(master, f"\x1b]{number};{THEMES[theme][number]}\x07".encode())
        osc_pending = osc_pending[match.end() :]


def stop(*_):
    os.killpg(child.pid, signal.SIGINT)


signal.signal(signal.SIGTERM, stop)
stdin_open = True
stream_open = True
try:
    while child.poll() is None:
        fds = [master] + ([sys.stdin] if stdin_open else [])
        readable, _, _ = select.select(fds, [], [], 0.2)
        for source in readable:
            if source is master:
                try:
                    data = os.read(master, 16384)
                except OSError:
                    data = b""
                if not data:
                    stream_open = False
                    break
                answer_osc(data)
                os.write(sys.stdout.fileno(), data)
            else:
                line = sys.stdin.readline()
                if not line:
                    stdin_open = False
                    continue
                parts = line.split()
                if len(parts) == 3 and parts[0] == "resize":
                    resize(int(parts[1]), int(parts[2]))
                elif len(parts) == 2 and parts[0] == "theme":
                    if parts[1] in THEMES:
                        theme = parts[1]
                        # Terminal-side theme change notification.
                        os.write(master, b"\x1b[?997;1n")
                elif len(parts) == 3 and parts[0] == "mouse":
                    col, row = int(parts[1]), int(parts[2])
                    # SGR mouse: motion without buttons, then press and release.
                    os.write(master, f"\x1b[<35;{col};{row}M".encode())
                    os.write(master, f"\x1b[<0;{col};{row}M".encode())
                    os.write(master, f"\x1b[<0;{col};{row}m".encode())
        if not stream_open:
            break
finally:
    stop() if child.poll() is None else None
    child.wait()
    os.close(master)
