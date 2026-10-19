import importlib.util
from pathlib import Path
import tempfile
import json
import unittest

spec=importlib.util.spec_from_file_location('monitor',Path(__file__).with_name('monitor.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class MonitorTest(unittest.TestCase):
    def test_pressure_rejects_new_work_without_increasing_limits(self):
        monitor=module.Monitor()
        self.assertTrue(monitor.admission_ok())
        for sample in [dict(mem_available=100*1024**2),dict(disk_free=1024**3),dict(tx_bytes_per_second=5_000_000)]:
            monitor.snapshot=sample;self.assertFalse(monitor.admission_ok())

    def test_snapshot_is_small_atomic_and_contains_no_session_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            monitor=module.Monitor();monitor.snapshot={'mem_available':123}
            target=Path(directory)/'metrics.json';monitor.write({'viewers':1},target)
            data=json.loads(target.read_text());self.assertEqual(data['viewers'],1)
            self.assertLess(target.stat().st_size,2048)
            self.assertFalse(target.with_suffix('.tmp').exists())
