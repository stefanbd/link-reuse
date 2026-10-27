#!/usr/bin/env python3
import pathlib
import plistlib
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
BUILD = ROOT / 'build'
BROWSERS = [
    ('Arc', 'company.thebrowser.Browser', '/Applications/Arc.app', 'Arc'),
    ('Google Chrome', 'com.google.Chrome', '/Applications/Google Chrome.app', 'Chrome'),
    ('Brave Browser', 'com.brave.Browser', '/Applications/Brave Browser.app', 'Brave'),
    ('Microsoft Edge Beta', 'com.microsoft.edgemac.Beta', '/Applications/Microsoft Edge Beta.app', 'EdgeBeta'),
]

BUILD.mkdir(exist_ok=True)
subprocess.run([
    'xcrun', 'swiftc', '-swift-version', '6', '-O', '-module-cache-path', str(BUILD / 'module-cache'),
    *[str(ROOT / name) for name in ['main.swift', 'URLMatching.swift', 'LearningPolicy.swift', 'LearningStore.swift', 'NativeHost.swift']], '-o', str(BUILD / 'LinkReuse'),
], check=True)

for name, bundle_id, source_path, short_name in BROWSERS:
    app = BUILD / f'{short_name} Reuse.app'
    resources = app / 'Contents/Resources'
    executable = app / 'Contents/MacOS/LinkReuse'
    resources.mkdir(parents=True, exist_ok=True)
    executable.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(BUILD / 'LinkReuse', executable)
    shutil.copy2(ROOT / 'extension/learning-policy.json', resources / 'learning-policy.json')
    template = ROOT / ('Arc.applescript' if short_name == 'Arc' else 'Browser.applescript')
    script = template.read_text().replace('application "Google Chrome"', f'application "{source_path}"')
    subprocess.run(['osacompile', '-o', str(resources / 'Browser.scpt')], input=script, text=True, check=True)
    info = {
        'CFBundleIdentifier': f'me.dichev.LinkReuse.{short_name}',
        'CFBundleName': f'{short_name} Reuse',
        'CFBundleDisplayName': f'{short_name} Reuse',
        'CFBundleExecutable': 'LinkReuse',
        'CFBundlePackageType': 'APPL',
        'CFBundleVersion': '3',
        'CFBundleShortVersionString': '2.0',
        'LSMinimumSystemVersion': '14.0',
        'LSUIElement': True,
        'NSAppleEventsUsageDescription': f'Find and select an existing {name} tab before opening an external link.',
        'ReuseBrowserBundleID': bundle_id,
        'ReuseBrowserName': name,
        'CFBundleURLTypes': [{'CFBundleURLName': 'Web links', 'CFBundleTypeRole': 'Viewer', 'CFBundleURLSchemes': ['http', 'https']}],
    }
    source_app = pathlib.Path(source_path)
    source_info = plistlib.loads((source_app / 'Contents/Info.plist').read_bytes())
    icon = source_info.get('CFBundleIconFile')
    if icon:
        icon_path = source_app / 'Contents/Resources' / icon
        if not icon_path.suffix:
            icon_path = icon_path.with_suffix('.icns')
        if icon_path.exists():
            shutil.copy2(icon_path, resources / 'Browser.icns')
            info['CFBundleIconFile'] = 'Browser.icns'
    (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    subprocess.run(['codesign', '--force', '--sign', '-', str(app)], check=True)
    subprocess.run([str(executable), '--self-test'], check=True)
    print(f'Built {app.name}')
