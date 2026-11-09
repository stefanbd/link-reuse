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

common = ['BrowserConfiguration.swift', 'OpenRequest.swift', 'WebLink.swift']
for test, sources in [('OpenRequestTests.swift', common),
                      ('MacBridgeTests.swift', common + ['MacBridge.swift', 'BridgeMessage.swift', 'Wire.swift']),
                      ('ExchangeTests.swift', ['BridgeMessage.swift', 'BridgeExchange.swift']),
                      ('SafariBridgeTests.swift', ['BridgeMessage.swift', 'BridgeExchange.swift', 'SafariBridge.swift']),
                      ('SafariBrowserClientTests.swift', ['BridgeMessage.swift', 'BridgeExchange.swift', 'SafariBridge.swift'])]:
    executable = OUTPUT / pathlib.Path(test).stem
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '6', '-module-cache-path', str(ROOT / 'build/module-cache'),
                    *(str(APP / source) for source in sources), str(TEST / test), '-o', str(executable)], cwd=ROOT, check=True)
    print('Running ' + test, flush=True)
    subprocess.run([str(executable)], cwd=ROOT, check=True, timeout=60)

subprocess.run(['python3', '-m', 'unittest', 'test_packaging', 'test_install'], cwd=TEST, check=True)
subprocess.run(['python3', '-m', 'py_compile', *map(str, [*ROOT.glob('macos/**/*.py'), *TEST.glob('*.py'), ROOT / 'windows/package.py'])], check=True)
