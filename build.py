#!/usr/bin/env python3
"""Build one universal Mac app containing Safari and Chromium connections."""
import argparse
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


def prepare(group):
    BUILD.mkdir(exist_ok=True)
    manifest = json.loads((ROOT / 'extension/manifest.json').read_text())
    digest = hashlib.sha256(base64.b64decode(manifest['key'], validate=True)).hexdigest()[:32]
    extension_id = ''.join(chr(ord('a') + int(char, 16)) for char in digest)
    for name in ['app', 'safari']:
        resources = BUILD / (name + '-resources')
        if resources.exists(): shutil.rmtree(resources)
        if name == 'app':
            shutil.copytree(ROOT / 'extension', resources / 'extension')
            (resources / 'configuration.json').write_text(json.dumps({
                'browsers': json.loads((ROOT / 'browsers.json').read_text()),
                'extensionOrigin': f'chrome-extension://{extension_id}/',
            }, indent=2))
        else:
            shutil.copytree(ROOT / 'extension', resources)
            safari_manifest = manifest.copy()
            for key in ['key', 'incognito']: safari_manifest.pop(key, None)
            safari_manifest['manifest_version'] = 2
            safari_manifest['browser_action'] = safari_manifest.pop('action')
            safari_manifest['permissions'] = manifest['permissions'] + safari_manifest.pop('host_permissions')
            safari_manifest['background'] = {'page': 'background.html', 'persistent': True}
            safari_manifest['content_security_policy'] = "script-src 'self'; object-src 'none'"
            safari_manifest['browser_specific_settings'] = {'safari': {'strict_min_version': '18.4'}}
            (resources / 'manifest.json').write_text(json.dumps(safari_manifest, indent=2) + '\n')
        info = {
            'CFBundleIdentifier': 'me.dichev.LinkReuse' + ('.Safari' if name == 'safari' else ''),
            'CFBundleName': 'Link Reuse', 'CFBundleDisplayName': 'Link Reuse',
            'CFBundleExecutable': 'LinkReuseSafari' if name == 'safari' else 'LinkReuse',
            'CFBundlePackageType': 'XPC!' if name == 'safari' else 'APPL',
            'CFBundleVersion': manifest['version'], 'CFBundleShortVersionString': manifest['version'],
            'LSMinimumSystemVersion': '14.0', 'LinkReuseAppGroup': group,
        }
        if name == 'app':
            info['LSUIElement'] = True
            info['CFBundleURLTypes'] = [{'CFBundleURLName': 'Link Reuse request', 'CFBundleTypeRole': 'Viewer', 'CFBundleURLSchemes': ['linkreuse']}]
        else:
            info['NSExtension'] = {'NSExtensionPointIdentifier': 'com.apple.Safari.web-extension',
                                  'NSExtensionPrincipalClass': 'LinkReuseSafari.SafariWebExtensionHandler'}
            info['NSHumanReadableCopyright'] = 'Link Reuse'
        (BUILD / (name + '-info.plist')).write_bytes(plistlib.dumps(info))
        entitlements = {'com.apple.security.application-groups': [group]}
        if name == 'safari': entitlements.update({'com.apple.security.app-sandbox': True, 'com.apple.security.network.client': True})
        (BUILD / (name + '.entitlements')).write_bytes(plistlib.dumps(entitlements))
    return extension_id


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--sign', default='-', help='Code-signing identity; defaults to ad-hoc development signing.')
    parser.add_argument('--team', help='Apple team identifier for the shared Mac app group.')
    args = parser.parse_args()
    if args.sign != '-' and not args.team: parser.error('--team is required with --sign')
    group = args.team + '.me.dichev.LinkReuse' if args.team else 'group.me.dichev.LinkReuse'
    extension_id = prepare(group)
    for product in [APP, BUILD / 'LinkReuseSafari.appex']:
        if product.exists(): shutil.rmtree(product)
    subprocess.run(['xcodebuild', '-project', str(ROOT / 'LinkReuse.xcodeproj'), '-scheme', 'Link Reuse',
                    '-configuration', 'Release', '-destination', 'generic/platform=macOS', '-derivedDataPath', str(BUILD / 'derived'),
                    'ARCHS=arm64 x86_64', 'ONLY_ACTIVE_ARCH=NO', 'CODE_SIGNING_ALLOWED=NO',
                    'CONFIGURATION_BUILD_DIR=' + str(BUILD), '-quiet', 'build'], check=True, cwd=ROOT)
    for name, destination in [('app', APP / 'Contents/Resources'),
                              ('safari', APP / 'Contents/PlugIns/LinkReuseSafari.appex/Contents/Resources')]:
        expected = {p.relative_to(BUILD / (name + '-resources')): p.read_bytes() for p in (BUILD / (name + '-resources')).rglob('*') if p.is_file()}
        actual = {p.relative_to(destination): p.read_bytes() for p in destination.rglob('*') if p.is_file()}
        if expected != actual: raise RuntimeError(name + ' extension resources differ from the prepared shared source')
    main_binary = APP / 'Contents/MacOS/LinkReuse'
    host = APP / 'Contents/Helpers/LinkReuseHost'
    host.parent.mkdir(exist_ok=True)
    shutil.copy2(main_binary, host)
    signing = ['codesign', '--force', '--sign', args.sign, '--timestamp=none']
    subprocess.run([*signing, '--identifier', 'me.dichev.LinkReuse.Host', str(host)], check=True)
    extension = APP / 'Contents/PlugIns/LinkReuseSafari.appex'
    subprocess.run([*signing, '--entitlements', str(BUILD / 'safari.entitlements'), str(extension)], check=True)
    subprocess.run([*signing, '--entitlements', str(BUILD / 'app.entitlements'), str(APP)], check=True)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(APP)], check=True)
    subprocess.run([str(host), '--self-test'], check=True)
    print('Built one Link Reuse.app with Safari and Chromium support.')
    print('Stable Chromium extension ID:', extension_id)


if __name__ == '__main__': main()
