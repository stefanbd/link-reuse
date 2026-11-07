#!/usr/bin/env python3
"""Run local logic tests without opening browsers or changing installed apps."""
import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parent
output = root / 'build/tests'
output.mkdir(parents=True, exist_ok=True)
subprocess.run(['node', '--test', 'test_redirects.mjs', 'test_canonical.mjs', 'test_learning.mjs', 'test_page_links.mjs', 'test_windows.mjs', 'test_identity.mjs', 'test_safari.mjs'], cwd=root, check=True)
common = ['BrowserConfiguration.swift', 'OpenRequest.swift', 'WebLink.swift']
for test, sources in [('test_open_request.swift', common),
                      ('test_mac_bridge.swift', common + ['MacBridge.swift', 'BridgeMessage.swift', 'Wire.swift']),
                      ('test_exchange.swift', ['BridgeMessage.swift', 'BridgeExchange.swift']),
                      ('test_safari_bridge.swift', common + ['BridgeMessage.swift', 'BridgeExchange.swift', 'Wire.swift', 'MacBridge.swift', 'SafariIPC.swift', 'SafariBridge.swift'])]:
    executable = output / pathlib.Path(test).stem
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '6', '-module-cache-path', str(root / 'build/module-cache'),
                    *sources, test, '-o', str(executable)], cwd=root, check=True)
    subprocess.run([str(executable)], cwd=root, check=True)
subprocess.run(['python3', '-m', 'unittest', 'test_packaging', 'test_install'], cwd=root, check=True)
subprocess.run(['python3', '-m', 'py_compile', *map(str, root.glob('*.py'))], check=True)
