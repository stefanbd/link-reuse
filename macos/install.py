#!/usr/bin/env python3
"""Install or replace the Mac app, preserving router settings without retaining update artifacts."""
import argparse
import ctypes
import os
import pathlib
import shutil
import signal
import subprocess
import tempfile
import time
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
APP = pathlib.Path.home() / 'Applications/Link Reuse.app'
# Builds go in a `.noindex` folder: Spotlight would register an indexed copy, and a second registered Safari extension
# makes PlugInKit kill the live one, so Safari reloads every extension mid-request.
BUILT_APP = ROOT / 'build/products.noindex/Link Reuse.app'
REGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
RENAME_SWAP = 0x00000002


def run(*args): subprocess.run(list(map(str, args)), check=True)


def register(app):
    # For a few minutes after a bundle changes, macOS re-registers it on every link opened through CoreServicesUIAgent
    # (OpenIn, /usr/bin/open), restarting the Safari extension each time. Dating the folder back avoids that window.
    past = time.time() - 3600
    os.utime(app, (past, past))
    run(REGISTER, '-f', '-R', '-trusted', app)


def unregister(app):
    result = subprocess.run([REGISTER, '-u', str(app)], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode and '-10814' not in result.stdout:
        raise subprocess.CalledProcessError(result.returncode, result.args, output=result.stdout)


def swap_contents(left, right):
    swap = ctypes.CDLL(None, use_errno=True).renamex_np
    swap.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    swap.restype = ctypes.c_int
    if swap(os.fsencode(left), os.fsencode(right), RENAME_SWAP):
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


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
    parser.add_argument('--app', type=pathlib.Path, default=BUILT_APP)
    args = parser.parse_args()
    run('codesign', '--verify', '--deep', '--strict', args.app)
    APP.parent.mkdir(exist_ok=True)
    temporary = tempfile.TemporaryDirectory(prefix='.link-reuse-', dir=APP.parent)
    transaction = pathlib.Path(temporary.name)
    work = transaction / '.install'
    stage = work / 'Link Reuse.app'
    archive = transaction / 'rollback.zip'
    work.mkdir(parents=True, mode=0o700)
    replacing = APP.exists()
    installed = False
    try:
        shutil.copytree(args.app, stage, symlinks=True)
        run('codesign', '--verify', '--deep', '--strict', stage)
        if replacing:
            run('ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', APP, archive)
            with zipfile.ZipFile(archive) as saved:
                if saved.testzip() is not None: raise RuntimeError('The rollback archive is damaged.')
        stop_owned_processes()
        try:
            if replacing: swap_contents(APP / 'Contents', stage / 'Contents')
            else: stage.rename(APP)
            installed = True
            run('codesign', '--verify', '--deep', '--strict', APP)
            shutil.rmtree(work)
            run(APP / 'Contents/MacOS/LinkReuse', '--install')
            register(APP)
        except BaseException:
            if installed and replacing:
                if not stage.exists():
                    work.mkdir(parents=True, mode=0o700)
                    run('ditto', '-x', '-k', archive, work)
                swap_contents(APP / 'Contents', stage / 'Contents')
                shutil.rmtree(work)
                run(APP / 'Contents/MacOS/LinkReuse', '--install')
                register(APP)
            elif installed:
                unregister(APP)
                work.mkdir(parents=True, exist_ok=True, mode=0o700)
                APP.rename(stage)
            raise
    finally:
        temporary.cleanup()
    shortcut = APP.parent / 'Link Reuse Extension'
    if not shortcut.exists() and not shortcut.is_symlink():
        shortcut.symlink_to(APP / 'Contents/Resources/extension', target_is_directory=True)
    print('Installed:', APP)
    print('Enable Link Reuse in Safari Settings → Extensions. Reload it in Chromium browsers.')


if __name__ == '__main__': main()
