import fcntl
import os
import select
import signal
import struct
import subprocess
import sys
import termios

master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 160, 0, 0))
child = subprocess.Popen(
    sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True
)
os.close(slave)


def stop(*_):
    os.killpg(child.pid, signal.SIGINT)


signal.signal(signal.SIGTERM, stop)
try:
    while child.poll() is None:
        readable, _, _ = select.select([master], [], [], 0.2)
        if readable:
            try:
                data = os.read(master, 16384)
            except OSError:
                break
            if not data:
                break
            os.write(sys.stdout.fileno(), data)
finally:
    stop() if child.poll() is None else None
    child.wait()
    os.close(master)
