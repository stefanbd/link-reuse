#!/usr/bin/env python3
"""Update only eligible OpenIn browser destinations; preserve rules and a rollback record."""
import datetime
import json
import pathlib
import sqlite3
import subprocess
import sys
import time

root = pathlib.Path.home() / 'Library/Group Containers/4QE86VV38D.app.loshadki.OpenIn/Library/Application Support/OpenIn'
database = root / 'local.sqlite'
source_root = pathlib.Path(__file__).resolve().parent
app = pathlib.Path.home() / 'Applications/Link Reuse.app'
configuration = json.loads((app / 'Contents/Resources/configuration.json').read_text())
browsers = configuration['browsers']
template = (source_root / 'openin-rewrite.js').read_text().strip()
scripts = {browser['id']: template.replace('{{browser}}', browser['id']) for browser in browsers}
mapping = {browser['bundleID']: browser['id'] for browser in browsers}
mapping.update({f'me.dichev.LinkReuse.{browser["id"]}': browser['id'] for browser in browsers})

if '--apply' not in sys.argv:
    raise SystemExit('Run with --apply after the installed app passes its browser checks.')

subprocess.run(['osascript', '-e', 'tell application id "app.loshadki.OpenIn.v4" to quit'], check=True)
for _ in range(50):
    if subprocess.run(['pgrep', '-x', 'OpenIn'], capture_output=True).returncode != 0:
        break
    time.sleep(0.1)
else:
    raise SystemExit('OpenIn is still running; its settings were not changed.')

stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
backup_root = source_root / 'backups' / stamp
backup_root.mkdir(parents=True, mode=0o700)
connection = sqlite3.connect(database)
connection.row_factory = sqlite3.Row
with sqlite3.connect(backup_root / 'local.sqlite') as backup:
    connection.backup(backup)
(backup_root / 'local.sqlite').chmod(0o600)

originals = []
try:
    connection.execute('BEGIN IMMEDIATE')
    rules_before = list(connection.execute('SELECT * FROM Z_6USEDINRULES ORDER BY Z_6SELECTEDAPPS,Z_7USEDINRULES'))
    candidates = list(connection.execute('''
        SELECT a.* FROM ZOPENINHANDLERAPP a JOIN ZOPENINHANDLER h ON a.ZHANDLER=h.Z_PK
        WHERE h.ZSCHEME IN ('http','https') AND COALESCE(a.ZBROWSERUSEPROFILES,0)=0
          AND COALESCE(a.ZBROWSERPROFILEPRIVATE,0)=0
    '''))
    for row in candidates:
        short = mapping.get(row['ZBUNDLEIDENTIFIER'])
        if row['ZBUNDLEIDENTIFIER'] == 'me.dichev.LinkReuse':
            short = next((key for key, script in scripts.items() if row['ZREWRITEURLSCRIPTTEXT'] == script), None)
            if short is None:
                raise RuntimeError('An existing Link Reuse destination has an unknown rewrite; settings were not changed.')
        if not short:
            continue
        if row['ZREWRITEURL'] and row['ZREWRITEURLSCRIPTTEXT'] != scripts[short]:
            raise RuntimeError('A selected browser already has a custom rewrite; settings were not changed.')
        originals.append({key: row[key] for key in ['Z_PK','ZBUNDLEIDENTIFIER','ZPATH','ZLAUNCHACTIVATES','ZREWRITEURL','ZREWRITEURLTYPE','ZREWRITEURLSCRIPTTEXT']})
        connection.execute('''
            UPDATE ZOPENINHANDLERAPP
            SET ZBUNDLEIDENTIFIER=?,ZPATH=?,ZLAUNCHACTIVATES=0,ZREWRITEURL=1,ZREWRITEURLTYPE='Script',ZREWRITEURLSCRIPTTEXT=?,Z_OPT=Z_OPT+1 WHERE Z_PK=?
        ''', ('me.dichev.LinkReuse', app.as_uri(), scripts[short], row['Z_PK']))
        print(f'Updated {row["ZNAME"]} destination (id {row["Z_PK"]})')

    rules_after = list(connection.execute('SELECT * FROM Z_6USEDINRULES ORDER BY Z_6SELECTEDAPPS,Z_7USEDINRULES'))
    assert rules_before == rules_after
    assert connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    (backup_root / 'routing-before.json').write_text(json.dumps({'changed': originals}, indent=2))
    (backup_root / 'routing-before.json').chmod(0o600)
    connection.commit()
except BaseException:
    connection.rollback()
    raise
finally:
    connection.close()
    subprocess.run(['open', '-g', '-a', '/Applications/OpenIn.app'], check=True)

print(f'Backup: {backup_root}')
