#!/usr/bin/env python3
"""Run local logic tests without opening browsers or changing installed apps."""
import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parent
output = root / 'build/tests'
output.mkdir(parents=True, exist_ok=True)
subprocess.run(['node', '--test', 'test_redirects.mjs', 'test_canonical.mjs', 'test_learning.mjs', 'test_bridge.mjs'], cwd=root, check=True)
common = ['BrowserConfiguration.swift', 'OpenRequest.swift', 'URLMatching.swift', 'LearningPolicy.swift']
for test, sources in [('test_url_matching.swift', ['URLMatching.swift']),
                      ('test_open_request.swift', common),
                      ('test_learning.swift', common + ['LearningStore.swift', 'NativeHost.swift'])]:
    executable = output / pathlib.Path(test).stem
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '6', '-module-cache-path', str(root / 'build/module-cache'),
                    *sources, test, '-o', str(executable)], cwd=root, check=True)
    subprocess.run([str(executable)], cwd=root, check=True)
subprocess.run(['python3', '-m', 'py_compile', *map(str, root.glob('*.py'))], check=True)
