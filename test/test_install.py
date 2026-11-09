#!/usr/bin/env python3
"""Check app replacement and rollback without touching installed apps or processes."""
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'macos'))
import install


class InstallTests(unittest.TestCase):
    def attempt(self, failing=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            destination, source = root / 'Applications/Link Reuse.app', root / 'new.app'
            for folder, value in [(destination, 'old'), (source, 'new')]:
                (folder / 'Contents/Resources/extension').mkdir(parents=True)
                (folder / 'Contents/Resources/version').write_text(value)
            original_inode = destination.stat().st_ino
            calls = []
            def run(*args):
                calls.append(tuple(map(str, args)))
                if failing and failing(*args): raise subprocess.CalledProcessError(1, args)
                if str(args[0]) == 'ditto': subprocess.run(list(map(str, args)), check=True)
            with patch.object(install, 'APP', destination), \
                 patch.object(install, 'stop_owned_processes') as stop, patch.object(install, 'run', side_effect=run), \
                 patch.object(sys, 'argv', ['install.py', '--app', str(source)]):
                if failing:
                    with self.assertRaises(subprocess.CalledProcessError): install.main()
                    self.assertEqual((destination / 'Contents/Resources/version').read_text(), 'old')
                else:
                    install.main()
                    self.assertEqual((destination / 'Contents/Resources/version').read_text(), 'new')
                self.assertEqual(list(destination.parent.glob('.link-reuse-*')), [])
                self.assertEqual(destination.stat().st_ino, original_inode)
                return calls, stop.call_count

    def test_replacement_cleans_transaction_and_stops_owned_processes(self):
        calls, stopped = self.attempt()
        self.assertEqual(calls[0][:4], ('codesign', '--verify', '--deep', '--strict'))
        self.assertEqual(stopped, 1)
        self.assertFalse(any(call[0] == 'pluginkit' for call in calls))
        registrations = [call for call in calls if call[0] == install.REGISTER]
        self.assertEqual(len(registrations), 1)
        self.assertEqual(registrations[0][1:4], ('-f', '-R', '-trusted'))

    def test_registration_failure_restores_previous_app(self):
        calls, stopped = self.attempt(lambda *args: str(args[0]) == install.REGISTER)
        self.assertEqual(stopped, 1)
        self.assertEqual(calls[-1][0], install.REGISTER)
        self.assertEqual(calls[-1][1:4], ('-f', '-R', '-trusted'))

    def test_invalid_signature_never_stops_or_replaces_installed_app(self):
        calls, stopped = self.attempt(lambda *args: str(args[0]) == 'codesign')
        self.assertEqual(stopped, 0)
        self.assertEqual(len(calls), 1)

    def test_first_install_creates_one_app_without_a_live_backup_bundle(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            destination, source = root / 'Applications/Link Reuse.app', root / 'new.app'
            (source / 'Contents/Resources/extension').mkdir(parents=True)
            (source / 'Contents/Resources/version').write_text('new')
            with patch.object(install, 'APP', destination), \
                 patch.object(install, 'stop_owned_processes'), patch.object(install, 'run'), \
                 patch.object(sys, 'argv', ['install.py', '--app', str(source)]):
                install.main()
            self.assertEqual((destination / 'Contents/Resources/version').read_text(), 'new')
            self.assertEqual(list(destination.parent.glob('.link-reuse-*')), [])

    def test_unregistration_tolerates_only_an_absent_registration(self):
        missing = subprocess.CompletedProcess(['lsregister'], 1, 'failed to scan: -10814\n from spotlight')
        denied = subprocess.CompletedProcess(['lsregister'], 1, 'Operation not permitted')
        with patch.object(install.subprocess, 'run', return_value=missing):
            install.unregister(pathlib.Path('/example/absent.app'))
        with patch.object(install.subprocess, 'run', return_value=denied):
            with self.assertRaises(subprocess.CalledProcessError): install.unregister(pathlib.Path('/example/denied.app'))


if __name__ == '__main__': unittest.main()
