"""Exercise app lifetime with two temporary stand-in browsers; leave real browsers alone."""
import json
import os
import pathlib
import plistlib
import shutil
import signal
import subprocess
import tempfile
import time

root = pathlib.Path(__file__).resolve().parent

def pid(executable):
    for line in subprocess.check_output(['ps', '-axo', 'pid=,comm='], text=True).splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2: continue
        process, command = parts
        if pathlib.Path(command).resolve() == executable.resolve(): return int(process)
    return None

def wait(check):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        value = check()
        if value: return value
        time.sleep(.05)
    raise AssertionError('Lifetime check timed out')

with tempfile.TemporaryDirectory(dir='/private/tmp', prefix='link-reuse-lifetime-') as directory:
    temporary = pathlib.Path(directory)
    try:
        swift = temporary / 'browser.swift'
        # Workspace termination notifications exclude background-only apps.
        swift.write_text('import AppKit\nlet app = NSApplication.shared\napp.setActivationPolicy(.regular)\napp.run()\n')
        compiled = temporary / 'Browser'
        subprocess.run(['xcrun', 'swiftc', '-module-cache-path', str(root / 'build/module-cache'), str(swift), '-o', str(compiled)], check=True)
        browsers = []
        for number in [1, 2]:
            app = temporary / f'Browser{number}.app'
            executable = app / 'Contents/MacOS/Browser'
            executable.parent.mkdir(parents=True)
            shutil.copy2(compiled, executable)
            identifier = f'me.dichev.LinkReuse.LifetimeBrowser{number}'
            (app / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': identifier,
                'CFBundleExecutable': 'Browser', 'CFBundlePackageType': 'APPL'}))
            subprocess.run(['codesign', '--force', '--sign', '-', str(app)], check=True)
            browsers.append({'id': str(number), 'name': 'Lifetime Browser', 'bundleID': identifier,
                'appPath': str(app), 'profilePath': 'unused', 'script': 'unused'})
            subprocess.run(['open', '-g', '-a', str(app)], check=True)
            wait(lambda: pid(executable))
        app = temporary / 'Router.app'
        shutil.copytree(root / 'build/Link Reuse.app', app)
        info = app / 'Contents/Info.plist'
        values = plistlib.loads(info.read_bytes())
        values['CFBundleIdentifier'] = 'me.dichev.LinkReuse.LifetimeRouter'
        values['CFBundleURLTypes'] = []
        info.write_bytes(plistlib.dumps(values))
        config = app / 'Contents/Resources/configuration.json'
        values = json.loads(config.read_text()); values['browsers'] = browsers
        config.write_text(json.dumps(values))
        subprocess.run(['codesign', '--force', '--sign', '-', str(app)], check=True)
        subprocess.run(['open', '-g', '-a', str(app)], check=True)
        router = app / 'Contents/MacOS/LinkReuse'
        router_pid = wait(lambda: pid(router))
        subprocess.run(['osascript', '-e', 'tell application id "me.dichev.LinkReuse.LifetimeBrowser1" to quit'], check=True, timeout=10)
        wait(lambda: pid(temporary / 'Browser1.app/Contents/MacOS/Browser') is None)
        time.sleep(.2)
        assert pid(router) == router_pid, 'Router exited while the other browser was running'
        subprocess.run(['osascript', '-e', 'tell application id "me.dichev.LinkReuse.LifetimeBrowser2" to quit'], check=True, timeout=10)
        wait(lambda: pid(router) is None)
        print('Router stays warm with another browser running and exits when the last browser closes')
    finally:
        for executable in temporary.glob('*.app/Contents/MacOS/*'):
            process = pid(executable)
            if process:
                try: os.kill(process, signal.SIGTERM)
                except ProcessLookupError: pass
