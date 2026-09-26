import fcntl
import os
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
                os.write(sys.stdout.fileno(), data)
            else:
                line = sys.stdin.readline()
                if not line:
                    stdin_open = False
                    continue
                parts = line.split()
                if len(parts) == 3 and parts[0] == "resize":
                    resize(int(parts[1]), int(parts[2]))
        if not stream_open:
            break
finally:
    stop() if child.poll() is None else None
    child.wait()
    os.close(master)
