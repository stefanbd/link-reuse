#!/usr/bin/env python3
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
subprocess.run([str(app / 'Contents/MacOS/LinkReuse'), '--install'], check=True)
shortcut = app.parent / 'Link Reuse Extension'
if not shortcut.exists() and not shortcut.is_symlink():
    shortcut.symlink_to(resources / 'extension', target_is_directory=True)
print('Installed:', app)
print('Load the unpacked extension from:', shortcut)
