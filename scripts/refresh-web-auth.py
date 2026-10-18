#!/usr/bin/env python3
"""Refresh the private Nginx launch-token bridge after Harness starts."""
import os
import re
import socket
import subprocess
import time
from pathlib import Path

target = Path('/Vibecoding/Dowork/.local/web/nginx-auth.inc')
for attempt in range(100):
    # Only accept the current process token; an older launch can still be in the journal.
    pid = subprocess.check_output(['systemctl', 'show', 'dowork-web.service', '--property=MainPID', '--value'], text=True).strip()
    log = subprocess.check_output(['journalctl', '-u', 'dowork-web.service', '_PID=' + pid, '-n', '120', '--no-pager'], text=True) if pid.isdigit() and int(pid) > 0 else ''
    tokens = re.findall(r'dsh web: https://dsh\.draftgo\.cn/\?token=([A-Za-z0-9_-]+)', log)
    try:
        with socket.create_connection(('127.0.0.1', 3080), .3):
            if tokens:
                token = tokens[-1]
                break
    except OSError:
        pass
    time.sleep(.3)
else:
    raise SystemExit('Harness authentication bridge: startup not ready')
temporary = target.with_suffix('.tmp')
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as stream:
    stream.write('set $dsh_launch_token "' + token + '";\n')
os.chmod(temporary, 0o600)
os.replace(temporary, target)
for args in (['/www/server/nginx/sbin/nginx', '-t'], ['/www/server/nginx/sbin/nginx', '-s', 'reload']):
    result = subprocess.run(args, capture_output=True)
    if result.returncode:
        raise SystemExit('Harness authentication bridge: Nginx validation/reload failed')
print('Harness private authentication bridge refreshed')
