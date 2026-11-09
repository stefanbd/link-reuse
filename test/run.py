#!/usr/bin/env python3
"""Run every local check (JavaScript, Swift, Python) without opening browsers or changing installed apps."""
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
TEST = ROOT / 'test'
APP = ROOT / 'macos/App'
OUTPUT = ROOT / 'build/tests'
OUTPUT.mkdir(parents=True, exist_ok=True)

subprocess.run(['node', '--test', *sorted(map(str, TEST.glob('*.test.mjs')))], cwd=ROOT, check=True)

# Each Swift test compiles with just the app sources it exercises.
requests = ['BrowserConfiguration.swift', 'OpenRequest.swift', 'WebLink.swift']
exchange = ['BridgeMessage.swift', 'BridgeExchange.swift']
for test, sources in [('OpenRequestTests.swift', requests),
                      ('MacBridgeTests.swift', requests + ['MacBridge.swift', 'BridgeMessage.swift', 'Wire.swift']),
                      ('ExchangeTests.swift', exchange),
                      ('SafariBridgeTests.swift', exchange + ['SafariBridge.swift']),
                      ('SafariBrowserClientTests.swift', exchange + ['SafariBridge.swift'])]:
    executable = OUTPUT / pathlib.Path(test).stem
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '6', '-module-cache-path', str(ROOT / 'build/module-cache'),
                    *(str(APP / source) for source in sources), str(TEST / test), '-o', str(executable)],
                   cwd=ROOT, check=True)
    print('Running ' + test, flush=True)
    subprocess.run([str(executable)], cwd=ROOT, check=True, timeout=60)

subprocess.run(['python3', '-m', 'unittest', 'test_packaging', 'test_install'], cwd=TEST, check=True)
scripts = [*ROOT.glob('macos/**/*.py'), *TEST.glob('*.py'), ROOT / 'windows/package.py']
subprocess.run(['python3', '-m', 'py_compile', *map(str, scripts)], check=True)
