#!/usr/bin/env python3
import hashlib
import json
import pathlib
import shutil
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parent
source = pathlib.Path.home() / 'src/link-reuse'
extension = source / 'extension'
if root != source:
    shutil.copytree(root / 'extension', extension, dirs_exist_ok=True)
    for name in ['install_redirects.py', 'test_redirects.mjs', 'test_canonical.mjs', 'test_learning.mjs', 'test_bridge.mjs', 'test_learning.swift', 'test_latency.py', 'test_routing.py', 'test_redirect_integration.py', 'test_resource_integration.py']:
        shutil.copy2(root / name, source / name)

digest = hashlib.sha256(str(extension.resolve()).encode()).hexdigest()[:32]
extension_id = ''.join(chr(ord('a') + int(char, 16)) for char in digest)
print('Expected extension ID:', extension_id)

browsers = {
    'Arc': 'Arc/User Data',
    'Chrome': 'Google/Chrome',
    'Brave': 'BraveSoftware/Brave-Browser',
    'EdgeBeta': 'Microsoft Edge Beta',
}
executable = source / 'native-host'
with tempfile.TemporaryDirectory(prefix='.native-host-install-', dir=source) as staging:
    staged_executable = pathlib.Path(staging) / 'native-host'
    shutil.copy2(pathlib.Path.home() / 'Applications/Link Reuse/Arc Reuse.app/Contents/MacOS/LinkReuse', staged_executable)
    staged_executable.chmod(0o700)
    subprocess.run(['codesign', '--force', '--sign', '-', '--identifier', 'me.dichev.link_reuse', str(staged_executable)], check=True)
    subprocess.run(['codesign', '--verify', '--strict', str(staged_executable)], check=True)
    staged_executable.replace(executable)
for short, profile_path in browsers.items():
    host_dir = pathlib.Path.home() / 'Library/Application Support' / profile_path / 'NativeMessagingHosts'
    host_dir.mkdir(parents=True, exist_ok=True)
    manifest = host_dir / 'me.dichev.link_reuse.json'
    manifest.write_text(json.dumps({
        'name': 'me.dichev.link_reuse',
        'description': 'Store observed redirect URLs locally for Link Reuse.',
        'path': str(executable),
        'type': 'stdio',
        'allowed_origins': [f'chrome-extension://{extension_id}/'],
    }, indent=2))
    manifest.chmod(0o600)
    (source / ('native-host-' + short)).unlink(missing_ok=True)
    print('Registered local redirect recorder for', short)

for name in ['native_host.py', 'test_native_host.py']:
    (source / name).unlink(missing_ok=True)
