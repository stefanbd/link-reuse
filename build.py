#!/usr/bin/env python3
import base64
import hashlib
import json
import pathlib
import plistlib
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
BUILD = ROOT / 'build'
APP = BUILD / 'Link Reuse.app'
BUILD.mkdir(exist_ok=True)
if APP.exists():
    shutil.rmtree(APP)
resources = APP / 'Contents/Resources'
resources.mkdir(parents=True)
main = APP / 'Contents/MacOS/LinkReuse'
host = APP / 'Contents/Helpers/LinkReuseHost'
main.parent.mkdir()
host.parent.mkdir()
subprocess.run([
    'xcrun', 'swiftc', '-swift-version', '6', '-O', '-module-cache-path', str(BUILD / 'module-cache'),
    *[str(ROOT / name) for name in ['main.swift', 'BrowserConfiguration.swift', 'OpenRequest.swift', 'URLMatching.swift',
                                  'LearningPolicy.swift', 'LearningStore.swift', 'NativeHost.swift']], '-o', str(main),
], check=True)
shutil.copy2(main, host)
shutil.copytree(ROOT / 'extension', resources / 'extension')
manifest = json.loads((ROOT / 'extension/manifest.json').read_text())
digest = hashlib.sha256(base64.b64decode(manifest['key'], validate=True)).hexdigest()[:32]
extension_id = ''.join(chr(ord('a') + int(char, 16)) for char in digest)
browsers = [browser for browser in json.loads((ROOT / 'browsers.json').read_text())
            if pathlib.Path(browser['appPath']).is_dir()]
if not browsers:
    raise SystemExit('Install at least one supported browser before building.')
for browser in browsers:
    script = (ROOT / (browser['script'] + '.applescript')).read_text()
    script = script.replace('application "Google Chrome"', f'application "{browser["appPath"]}"')
    subprocess.run(['osacompile', '-o', str(resources / (browser['id'] + '.scpt'))], input=script, text=True, check=True)
(resources / 'configuration.json').write_text(json.dumps({
    'browsers': browsers, 'extensionOrigin': f'chrome-extension://{extension_id}/',
}, indent=2))
info = {
    'CFBundleIdentifier': 'me.dichev.LinkReuse', 'CFBundleName': 'Link Reuse',
    'CFBundleDisplayName': 'Link Reuse', 'CFBundleExecutable': 'LinkReuse',
    'CFBundlePackageType': 'APPL', 'CFBundleVersion': '4', 'CFBundleShortVersionString': '3.0',
    'LSMinimumSystemVersion': '14.0', 'LSUIElement': True,
    'NSAppleEventsUsageDescription': 'Find and select an existing browser tab before opening an external link.',
    'CFBundleURLTypes': [{'CFBundleURLName': 'Link Reuse request', 'CFBundleTypeRole': 'Viewer',
                         'CFBundleURLSchemes': ['linkreuse']}],
}
(APP / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
subprocess.run(['codesign', '--force', '--sign', '-', '--identifier', 'me.dichev.LinkReuse.Host', str(host)], check=True)
subprocess.run(['codesign', '--force', '--sign', '-', str(APP)], check=True)
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(APP)], check=True)
subprocess.run([str(main), '--self-test'], check=True)
print('Built one Link Reuse.app for:', ', '.join(browser['name'] for browser in browsers))
print('Stable extension ID:', extension_id)
