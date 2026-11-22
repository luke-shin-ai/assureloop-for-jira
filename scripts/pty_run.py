#!/usr/bin/env python3
"""Run a command in a pseudo-terminal and answer prompts from a queue.

Forge CLI renders interactive prompts only on a TTY, so registration steps that
ask for a name cannot run through a plain pipe. This helper keeps the pty and
sends one queued answer whenever the child goes quiet waiting for input.

usage: pty_run.py <answer> [<answer> ...] -- <command ...>
"""
import os
import pty
import select
import sys
import time

args = sys.argv[1:]
try:
    split = args.index('--')
    answers = args[:split]
    command = args[split + 1:]
except ValueError:
    print('usage: pty_run.py <answer> [<answer> ...] -- <command ...>', file=sys.stderr)
    raise SystemExit(2)

pid, fd = pty.fork()
if pid == 0:  # child
    os.execvp(command[0], command)

output = bytearray()
pending = list(answers)
deadline = time.time() + 300
quiet_since = time.time()

while True:
    if time.time() > deadline:
        os.kill(pid, 9)
        break
    try:
        ready, _, _ = select.select([fd], [], [], 0.3)
    except OSError:
        break
    if ready:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
        quiet_since = time.time()
        continue
    # Nothing arrived: if the child has been quiet for a moment, treat it as a
    # prompt and answer it.
    if pending and time.time() - quiet_since > 0.8:
        answer = pending.pop(0)
        os.write(fd, (answer + '\n').encode())
        quiet_since = time.time()

_, status = os.waitpid(pid, 0)
sys.stdout.write(output.decode('utf-8', 'replace'))
sys.stdout.write('\n[exit status %d]\n' % (status >> 8))
raise SystemExit(status >> 8)
