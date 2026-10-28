#!/usr/bin/env python3
"""Package an already-published Windows executable and its matching Scoop manifest."""
import argparse
import hashlib
import json
import pathlib
import shutil
import tempfile
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('executable', type=pathlib.Path)
parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'build/windows')
parser.add_argument('--version', default='0.1.3')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
archive = args.output / f'link-reuse-windows-x64-{args.version}.zip'
with tempfile.TemporaryDirectory() as temporary:
    stage = pathlib.Path(temporary)
    shutil.copy2(args.executable, stage / 'LinkReuse.exe')
    shutil.copytree(ROOT / 'extension', stage / 'extension')
    shutil.copy2(ROOT / 'windows/SETUP.html', stage / 'SETUP.html')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as output:
        for path in sorted(stage.rglob('*')):
            if path.is_file(): output.write(path, path.relative_to(stage))
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
manifest = {
    'version': args.version,
    'description': 'Reuse an existing browser tab before opening an external web link.',
    'homepage': 'https://github.com/stefanbd/link-reuse',
    'architecture': {'64bit': {
        'url': f'https://github.com/stefanbd/link-reuse/releases/download/windows-v{args.version}/{archive.name}',
        'hash': digest,
    }},
    'bin': [['LinkReuse.exe', 'link-reuse']],
    'post_install': [
        "if ($global) { throw 'Install Link Reuse for the current user, without --global.' }",
        "$result = Start-Process -FilePath \"$dir\\LinkReuse.exe\" -ArgumentList '--install' -Wait -PassThru",
        "if ($result.ExitCode -ne 0) { throw 'Link Reuse registration failed.' }",
    ],
    'pre_uninstall': [
        "if ($cmd -eq 'uninstall') {",
        "    $result = Start-Process -FilePath \"$dir\\LinkReuse.exe\" -ArgumentList '--uninstall' -Wait -PassThru",
        "    if ($result.ExitCode -ne 0) { throw 'Link Reuse could not remove its browser registration.' }",
        "}",
    ],
    'notes': [
        'Run link-reuse --setup to load the bundled browser extension.',
        'Run link-reuse --defaults to choose Link Reuse for HTTP/HTTPS, or add it to your existing router.',
        'Updates restart the helper and reload the extension automatically after the one-time 0.1.2 transition.',
        'Select your real browser as default before uninstalling.',
    ],
}
(args.output / 'link-reuse.json').write_text(json.dumps(manifest, indent=2) + '\n')
(args.output / (archive.name + '.sha256')).write_text(digest + '  ' + archive.name + '\n')
print(f'{archive.name}: {digest}')
