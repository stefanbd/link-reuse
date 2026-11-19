#!/usr/bin/env python3
"""Install or replace the Mac app, preserving router settings without retaining update artifacts."""
import argparse
import ctypes
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import time

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


def executable(pid):
    """The path of the file a process runs. macOS resolves it from the file itself, so it follows a rename."""
    proc_pidpath = ctypes.CDLL(None, use_errno=True).proc_pidpath
    proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    buffer = ctypes.create_string_buffer(4096)
    length = proc_pidpath(pid, buffer, ctypes.sizeof(buffer))
    return os.fsdecode(buffer.raw[:length]) if length > 0 else None


def old_processes(contents):
    """This user's processes still running the replaced version, which now lies at `contents`, with their signals.
    Whatever started since the swap runs the new version, so it is not among them. The router and the browser hosts hand
    over to the new version on SIGUSR1; Safari's handler just ends, so Safari starts the new one."""
    signals = {os.path.realpath(contents.parent / path): value for path, value in [
        ('Contents/MacOS/LinkReuse', signal.SIGUSR1), ('Contents/Helpers/LinkReuseHost', signal.SIGUSR1),
        ('Contents/PlugIns/LinkReuseSafari.appex/Contents/MacOS/LinkReuseSafari', signal.SIGTERM)]}
    found = {}
    for line in subprocess.check_output(['ps', '-axo', 'pid=,uid='], text=True).splitlines():
        pid, uid = map(int, line.split())
        path = executable(pid) if uid == os.getuid() else None
        if path in signals: found[pid] = path
    return {pid: (path, signals[path]) for pid, path in found.items()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--app', type=pathlib.Path, default=BUILT_APP)
    args = parser.parse_args()
    run('codesign', '--verify', '--deep', '--strict', args.app)
    APP.parent.mkdir(exist_ok=True)
    # The new version is staged in a folder that isn't an app, so nothing registers it; after the swap the same folder
    # holds the old version until the new one is registered.
    transaction = pathlib.Path(tempfile.mkdtemp(prefix='.link-reuse-', dir=APP.parent))
    stage = transaction / 'stage'
    replacing = APP.exists()
    keep = False
    try:
        shutil.copytree(args.app, stage, symlinks=True)
        if replacing: swap_contents(APP / 'Contents', stage / 'Contents')
        else: stage.rename(APP)
        try:
            run('codesign', '--verify', '--deep', '--strict', APP)
            run(APP / 'Contents/MacOS/LinkReuse', '--install')
            register(APP)
        except BaseException:
            try:
                if replacing:
                    swap_contents(APP / 'Contents', stage / 'Contents')
                    run(APP / 'Contents/MacOS/LinkReuse', '--install')
                    register(APP)
                else:
                    unregister(APP)
                    APP.rename(stage)
            except BaseException:
                keep = True
                print(f'Restoring the previous version failed. {APP} and {stage} hold the two versions; '
                      'nothing was deleted.', file=sys.stderr)
            raise
        # Only now end the replaced version: each part hands over to the new one, so nothing waits for the user.
        if replacing:
            for pid, (path, value) in old_processes(stage / 'Contents').items():
                if executable(pid) == path:
                    try: os.kill(pid, value)
                    except ProcessLookupError: pass
    finally:
        if not keep: shutil.rmtree(transaction, ignore_errors=True)
    shortcut = APP.parent / 'Link Reuse Extension'
    if not shortcut.exists() and not shortcut.is_symlink():
        shortcut.symlink_to(APP / 'Contents/Resources/extension', target_is_directory=True)
    print('Installed:', APP)
    print('Enable Link Reuse in Safari Settings → Extensions.')


if __name__ == '__main__': main()
