#!/usr/bin/env python3
import json
import os
import pathlib
import shutil
import subprocess

root = pathlib.Path(__file__).resolve().parent
app = pathlib.Path.home() / 'Applications/Link Reuse.app'
built = root / 'build/Link Reuse.app'
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(built)], check=True)
if app.exists():
    raise SystemExit(f'Quit Link Reuse and move the previous app aside before installing: {app}')
app.parent.mkdir(exist_ok=True)
shutil.copytree(built, app)
subprocess.run(['/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
                '-f', str(app)], check=True)
resources = app / 'Contents/Resources'
configuration = json.loads((resources / 'configuration.json').read_text())
support = pathlib.Path.home() / 'Library/Application Support'
policy = json.loads((resources / 'extension/learning-policy.json').read_text())
for browser in configuration['browsers']:
    cache = support / 'Link Reuse/Live' / browser['bundleID'] / 'cache.json'
    if cache.exists() and cache.stat().st_size <= policy['maxCacheBytes']:
        snapshot = json.loads(cache.read_text())
        records = [record for session in snapshot.get('sessions', []) for record in session.get('records', [])]
        migration = {'aliases': {}, 'canonicals': {}}
        for record in records[-policy['maxRecords']:]:
            field = {'redirect': 'aliases', 'canonical': 'canonicals'}.get(record['kind'])
            if field and record.get('destination'):
                migration[field][record['source']] = record['destination']
        if any(migration.values()):
            alias_root = support / 'Link Reuse/Aliases'
            alias_root.mkdir(parents=True, exist_ok=True, mode=0o700)
            directory = alias_root / browser['bundleID']
            directory.mkdir(exist_ok=True, mode=0o700)
            file = directory / 'app-upgrade.json'
            with open(file, 'w', opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
                json.dump(migration, output)
    host_dir = support / browser['profilePath'] / 'NativeMessagingHosts'
    host_dir.mkdir(parents=True, exist_ok=True)
    manifest = host_dir / 'me.dichev.link_reuse.json'
    manifest.write_text(json.dumps({
        'name': 'me.dichev.link_reuse', 'description': 'Observe live-tab redirects locally for Link Reuse.',
        'path': str(app / 'Contents/Helpers/LinkReuseHost'), 'type': 'stdio',
        'allowed_origins': [configuration['extensionOrigin']],
    }, indent=2))
    manifest.chmod(0o600)
    print('Registered native messaging for', browser['name'])
shortcut = app.parent / 'Link Reuse Extension'
if not shortcut.exists() and not shortcut.is_symlink():
    shortcut.symlink_to(resources / 'extension', target_is_directory=True)
print('Installed:', app)
print('Load the unpacked extension from:', shortcut)
