#!/usr/bin/env python3
"""Check app replacement and rollback without touching installed apps or processes."""
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import install


class InstallTests(unittest.TestCase):
    def attempt(self, failing=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            destination, source = root / 'Applications/Link Reuse.app', root / 'new.app'
            for folder, value in [(destination, 'old'), (source, 'new')]:
                (folder / 'Contents/Resources/extension').mkdir(parents=True)
                (folder / 'version').write_text(value)
            calls = []
            def run(*args):
                calls.append(tuple(map(str, args)))
                if failing and failing(*args): raise subprocess.CalledProcessError(1, args)
            with patch.object(install, 'APP', destination), patch.object(install, 'BACKUPS', root / 'Backups'), \
                 patch.object(install, 'stop_owned_processes') as stop, patch.object(install, 'run', side_effect=run), \
                 patch.object(sys, 'argv', ['install.py', '--app', str(source)]):
                if failing:
                    with self.assertRaises(subprocess.CalledProcessError): install.main()
                    self.assertEqual((destination / 'version').read_text(), 'old')
                else:
                    install.main()
                    self.assertEqual((destination / 'version').read_text(), 'new')
                    self.assertEqual(next((root / 'Backups').glob('*/Link Reuse.app/version')).read_text(), 'old')
                self.assertEqual(list(destination.parent.glob('.Link Reuse update*')), [])
                return calls, stop.call_count

    def test_replacement_keeps_rollback_and_stops_owned_processes(self):
        calls, stopped = self.attempt()
        self.assertEqual(calls[0][:4], ('codesign', '--verify', '--deep', '--strict'))
        self.assertEqual(stopped, 1)
        self.assertTrue(any(call[0] == 'pluginkit' for call in calls))

    def test_registration_failure_restores_previous_app(self):
        calls, stopped = self.attempt(lambda *args: str(args[0]) == 'pluginkit')
        self.assertEqual(stopped, 1)
        self.assertEqual(calls[-1][0], install.REGISTER)

    def test_invalid_signature_never_stops_or_replaces_installed_app(self):
        calls, stopped = self.attempt(lambda *args: str(args[0]) == 'codesign')
        self.assertEqual(stopped, 0)
        self.assertEqual(len(calls), 1)


if __name__ == '__main__': unittest.main()
