#!/usr/bin/env python3
"""Check browser packages use the same engine, permissions, policy and version."""
import json
import pathlib
import plistlib
import tempfile
import unittest
import build


class PackagingTests(unittest.TestCase):
    def test_one_source_for_both_browser_packages(self):
        previous = build.BUILD
        with tempfile.TemporaryDirectory() as temporary:
            build.BUILD = pathlib.Path(temporary)
            try:
                extension_id = build.prepare('group.example.LinkReuse')
                self.assertEqual(extension_id, 'dkkfdmgdgomngkkoaaolokhechagdlfl')
                chromium = build.BUILD / 'app-resources/extension'
                safari = build.BUILD / 'safari-resources'
                original = json.loads((build.ROOT / 'extension/manifest.json').read_text())
                manifests = [json.loads((folder / 'manifest.json').read_text()) for folder in [chromium, safari]]
                for manifest in manifests:
                    for key in ['version', 'permissions', 'host_permissions', 'content_scripts', 'action']:
                        self.assertEqual(manifest[key], original[key])
                for source in (build.ROOT / 'extension').iterdir():
                    if source.is_file() and source.name != 'manifest.json':
                        self.assertEqual((chromium / source.name).read_bytes(), source.read_bytes())
                        self.assertEqual((safari / source.name).read_bytes(), source.read_bytes())
                self.assertNotIn('key', manifests[1])
                self.assertNotIn('incognito', manifests[1])
                self.assertEqual(manifests[0]['background'], original['background'])
                self.assertEqual(manifests[1]['background']['page'], 'background.html')
                self.assertFalse(manifests[1]['background']['persistent'])
                infos = [plistlib.loads((build.BUILD / (name + '-info.plist')).read_bytes()) for name in ['app', 'safari']]
                self.assertEqual(infos[0]['CFBundleShortVersionString'], infos[1]['CFBundleShortVersionString'])
                self.assertEqual(infos[0]['LinkReuseAppGroup'], infos[1]['LinkReuseAppGroup'])
                self.assertTrue(infos[1]['CFBundleIdentifier'].startswith(infos[0]['CFBundleIdentifier'] + '.'))
            finally: build.BUILD = previous


if __name__ == '__main__': unittest.main()
