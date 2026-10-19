"""Thirty-second Linux snapshots, bounded JSON, no tokens or torrent names."""
import json
import os
from pathlib import Path
import shutil
import time


class Monitor:
    def __init__(self):
        self.last = None
        self.snapshot = {}

    def sample(self):
        try:
            mem = {line.split(':')[0]: int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith(('MemAvailable:', 'MemTotal:'))}
            cpu = [int(x) for x in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
            net = [line.split(':', 1)[1].split() for line in Path('/proc/net/dev').read_text().splitlines()[2:] if line.split(':')[0].strip() != 'lo']
            rx, tx = sum(int(x[0]) for x in net), sum(int(x[8]) for x in net)
            now = time.monotonic()
            values = dict(mem_available=mem['MemAvailable'], disk_free=shutil.disk_usage('/').free, cpu_busy=None, rx_bytes_per_second=None, tx_bytes_per_second=None)
            for service, label in [('moviesplayer-torrserver', 'engine_memory_bytes'), ('dimovie-player', 'bridge_memory_bytes')]:
                try:
                    values[label] = int(Path('/sys/fs/cgroup/system.slice/' + service + '.service/memory.current').read_text())
                except (OSError, ValueError):
                    values[label] = None
            if self.last:
                previous, old_cpu, old_rx, old_tx = self.last
                elapsed, ticks = now - previous, sum(cpu) - sum(old_cpu)
                if elapsed > 0:
                    values.update(rx_bytes_per_second=max(0, rx-old_rx)/elapsed, tx_bytes_per_second=max(0, tx-old_tx)/elapsed)
                if ticks > 0:
                    values['cpu_busy'] = 1 - (cpu[3] - old_cpu[3]) / ticks
            self.last = (now, cpu, rx, tx)
            self.snapshot = values
        except (OSError, ValueError, IndexError):
            self.snapshot = {}
        return self.snapshot

    def admission_ok(self):
        # Conservative rejection only: never raises configured viewer limits.
        s = self.snapshot
        return (s.get('mem_available', 1024**3) >= 160*1024**2
                and s.get('disk_free', 10*1024**3) >= 2*1024**3
                and (s.get('tx_bytes_per_second') or 0) < 35_000_000/8)

    def write(self, counts, target='/run/dimovie-player/metrics.json'):
        value = dict(timestamp=time.time(), **self.snapshot, **counts)
        path = Path(target)
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps(value))
        os.replace(tmp, path)
