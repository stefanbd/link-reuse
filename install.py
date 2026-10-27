#!/usr/bin/env python3
import pathlib
import shutil
import subprocess

root = pathlib.Path(__file__).resolve().parent
source = pathlib.Path.home() / 'src/link-reuse'
apps = pathlib.Path.home() / 'Applications/Link Reuse'
source.mkdir(parents=True, exist_ok=True)
apps.mkdir(parents=True, exist_ok=True)
for name in ['main.swift', 'URLMatching.swift', 'LearningPolicy.swift', 'LearningStore.swift', 'NativeHost.swift', 'Browser.applescript', 'Arc.applescript', 'build.py', 'install.py', 'configure_openin.py', 'README.md']:
    if root != source:
        shutil.copy2(root / name, source / name)
for short in ['Arc', 'Chrome', 'Brave', 'EdgeBeta']:
    built = root / 'build' / f'{short} Reuse.app'
    target = apps / built.name
    if target.exists():
        raise SystemExit(f'Refusing to overwrite an existing app: {target}')
    shutil.copytree(built, target)
    subprocess.run(['/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', '-f', str(target)], check=True)
    subprocess.run(['codesign', '--verify', '--strict', str(target)], check=True)
    print(f'Installed {target}')
