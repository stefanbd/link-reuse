#!/usr/bin/env python3
"""Install or replace the Mac app, preserving a rollback copy and router settings."""
import argparse
import datetime
import os
import pathlib
import shutil
import signal
import subprocess
import time
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent
APP = pathlib.Path.home() / 'Applications/Link Reuse.app'
BACKUPS = pathlib.Path.home() / 'Library/Application Support/Link Reuse/Backups'
REGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'


def run(*args): subprocess.run(list(map(str, args)), check=True)


def stop_owned_processes():
    paths = {str(APP / path) for path in ['Contents/MacOS/LinkReuse', 'Contents/Helpers/LinkReuseHost',
                                         'Contents/PlugIns/LinkReuseSafari.appex/Contents/MacOS/LinkReuseSafari']}
    for _ in range(30):
        found = []
        for line in subprocess.check_output(['ps', '-axo', 'pid=,uid=,comm='], text=True).splitlines():
            values = line.strip().split(None, 2)
            if len(values) == 3 and int(values[1]) == os.getuid() and values[2] in paths:
                found.append(int(values[0]))
        if not found: return
        for pid in found:
            try: os.kill(pid, signal.SIGTERM)
            except ProcessLookupError: pass
        time.sleep(0.1)
    raise RuntimeError('Link Reuse is still running. Disable its extension briefly, then run the installer again.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--app', type=pathlib.Path, default=ROOT / 'build/Link Reuse.app')
    args = parser.parse_args()
    run('codesign', '--verify', '--deep', '--strict', args.app)
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    APP.parent.mkdir(exist_ok=True)
    stage = APP.parent / ('.Link Reuse update ' + stamp + '.app')
    backup = BACKUPS / stamp
    old = backup / 'Link Reuse.app'
    shutil.copytree(args.app, stage, symlinks=True)
    try:
        run('codesign', '--verify', '--deep', '--strict', stage)
        stop_owned_processes()
        if APP.exists():
            backup.mkdir(parents=True, mode=0o700)
            APP.rename(old)
        try:
            stage.rename(APP)
            run(APP / 'Contents/MacOS/LinkReuse', '--install')
            run(REGISTER, '-f', APP)
            run('pluginkit', '-a', APP / 'Contents/PlugIns/LinkReuseSafari.appex')
            run('codesign', '--verify', '--deep', '--strict', APP)
            if old.exists():
                archive = backup / 'Link Reuse.zip'
                run('ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', old, archive)
                with zipfile.ZipFile(archive) as saved:
                    if saved.testzip() is not None: raise RuntimeError('The rollback archive is damaged.')
                shutil.rmtree(old)
        except BaseException:
            backup.mkdir(parents=True, exist_ok=True)
            if APP.exists(): APP.rename(backup / 'Failed update.app')
            if old.exists():
                old.rename(APP)
                run(APP / 'Contents/MacOS/LinkReuse', '--install')
                run(REGISTER, '-f', APP)
            raise
    finally:
        if stage.exists(): shutil.rmtree(stage)
    shortcut = APP.parent / 'Link Reuse Extension'
    if not shortcut.exists() and not shortcut.is_symlink(): shortcut.symlink_to(APP / 'Contents/Resources/extension', target_is_directory=True)
    print('Installed:', APP)
    if backup.exists(): print('Rollback copy:', backup / 'Link Reuse.zip')
    print('Enable Link Reuse in Safari Settings → Extensions. Reload it in Chromium browsers.')


if __name__ == '__main__': main()
