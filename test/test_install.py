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
    def attempt(self, failing=None, rollback_fails=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            destination, source = root / 'Applications/Link Reuse.app', root / 'new.app'
            for folder, value in [(destination, 'old'), (source, 'new')]:
                (folder / 'Contents/Resources/extension').mkdir(parents=True)
                (folder / 'Contents/Resources/version').write_text(value)
            original_inode = destination.stat().st_ino
            calls, swaps = [], []
            # After the swap: the old router, still running from the retained copy; a host started since runs the new
            # version and is not reported.
            def old_processes(contents):
                calls.append(('find', (contents / 'Resources/version').read_text()))
                return {102: ('/old/LinkReuse', install.signal.SIGUSR1)}
            def run(*args):
                calls.append(tuple(map(str, args)))
                if failing and failing(*args): raise subprocess.CalledProcessError(1, args)
            swap = install.swap_contents
            def swap_contents(left, right):
                swaps.append(left)
                if rollback_fails and len(swaps) == 2: raise OSError('swap failed')
                swap(left, right)
            with patch.object(install, 'APP', destination), \
                 patch.object(install, 'old_processes', side_effect=old_processes), \
                 patch.object(install, 'executable', return_value='/old/LinkReuse'), \
                 patch.object(install, 'swap_contents', side_effect=swap_contents), \
                 patch.object(install.os, 'kill', side_effect=lambda *args: calls.append(('kill', *args))), \
                 patch.object(install, 'run', side_effect=run), \
                 patch.object(sys, 'argv', ['install.py', '--app', str(source)]):
                if failing:
                    with self.assertRaises(subprocess.CalledProcessError): install.main()
                    installed = 'new' if rollback_fails else 'old'
                    self.assertEqual((destination / 'Contents/Resources/version').read_text(), installed)
                else:
                    install.main()
                    self.assertEqual((destination / 'Contents/Resources/version').read_text(), 'new')
                kept = list(destination.parent.glob('.link-reuse-*'))
                if rollback_fails:
                    self.assertEqual((kept[0] / 'stage/Contents/Resources/version').read_text(), 'old')
                else:
                    self.assertEqual(kept, [])
                self.assertEqual(destination.stat().st_ino, original_inode)
                return calls

    def test_replacement_ends_the_old_version_only_once_the_new_one_is_installed(self):
        calls = self.attempt()
        self.assertEqual(calls[0][:4], ('codesign', '--verify', '--deep', '--strict'))
        registrations = [call for call in calls if call[0] == install.REGISTER]
        self.assertEqual(len(registrations), 1)
        self.assertEqual(registrations[0][1:4], ('-f', '-R', '-trusted'))
        # The old version is found in the copy the swap retained, after registration, and told to hand over.
        self.assertEqual(calls[-3:], [registrations[0], ('find', 'old'), ('kill', 102, install.signal.SIGUSR1)])

    def test_registration_failure_restores_previous_app_and_keeps_it_running(self):
        registrations = []
        def failing(*args):
            if str(args[0]) != install.REGISTER: return False
            registrations.append(args)
            return len(registrations) == 1
        calls = self.attempt(failing)
        # The new version's registration failed; the restored one is registered again.
        self.assertEqual(len(registrations), 2)
        self.assertFalse(any(call[0] in ('kill', 'find') for call in calls))

    def test_a_failed_restore_keeps_both_versions(self):
        calls = self.attempt(lambda *args: str(args[0]) == install.REGISTER, rollback_fails=True)
        self.assertFalse(any(call[0] in ('kill', 'find') for call in calls))

    def test_invalid_signature_never_stops_or_replaces_installed_app(self):
        calls = self.attempt(lambda *args: str(args[0]) == 'codesign')
        self.assertEqual(len(calls), 1)

    def test_first_install_creates_one_app_without_a_live_backup_bundle(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            destination, source = root / 'Applications/Link Reuse.app', root / 'new.app'
            (source / 'Contents/Resources/extension').mkdir(parents=True)
            (source / 'Contents/Resources/version').write_text('new')
            with patch.object(install, 'APP', destination), \
                 patch.object(install, 'old_processes', return_value={}), patch.object(install, 'run'), \
                 patch.object(sys, 'argv', ['install.py', '--app', str(source)]):
                install.main()
            self.assertEqual((destination / 'Contents/Resources/version').read_text(), 'new')
            self.assertEqual(list(destination.parent.glob('.link-reuse-*')), [])

    def test_a_process_of_the_old_version_is_found_in_the_copy_the_swap_retained(self):
        # macOS reports a process's executable from the file itself, so its path follows the swap; one started after the
        # swap runs the new version and is left alone.
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            installed, stage = root / 'Link Reuse.app', root / 'stage'
            source = root / 'wait.c'
            source.write_text('#include <unistd.h>\nint main(void) { pause(); }\n')
            for folder in (installed, stage):
                (folder / 'Contents/MacOS').mkdir(parents=True)
                subprocess.run(['xcrun', 'cc', '-o', str(folder / 'Contents/MacOS/LinkReuse'), str(source)], check=True)
            old = subprocess.Popen([installed / 'Contents/MacOS/LinkReuse'])
            try:
                install.swap_contents(installed / 'Contents', stage / 'Contents')
                new = subprocess.Popen([installed / 'Contents/MacOS/LinkReuse'])
                try:
                    self.assertEqual(install.old_processes(stage / 'Contents'),
                                     {old.pid: (str(stage / 'Contents/MacOS/LinkReuse'), install.signal.SIGUSR1)})
                finally: new.kill(); new.wait()
            finally: old.kill(); old.wait()

    def test_unregistration_tolerates_only_an_absent_registration(self):
        missing = subprocess.CompletedProcess(['lsregister'], 1, 'failed to scan: -10814\n from spotlight')
        denied = subprocess.CompletedProcess(['lsregister'], 1, 'Operation not permitted')
        with patch.object(install.subprocess, 'run', return_value=missing):
            install.unregister(pathlib.Path('/example/absent.app'))
        with patch.object(install.subprocess, 'run', return_value=denied):
            with self.assertRaises(subprocess.CalledProcessError): install.unregister(pathlib.Path('/example/denied.app'))


if __name__ == '__main__': unittest.main()
