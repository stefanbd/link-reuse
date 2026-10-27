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
app_root = pathlib.Path.home() / 'Applications/Link Reuse'
source_root = pathlib.Path.home() / 'src/link-reuse'
mapping = {
    'company.thebrowser.Browser': 'Arc',
    'com.google.Chrome': 'Chrome',
    'com.brave.Browser': 'Brave',
    'com.microsoft.edgemac.Beta': 'EdgeBeta',
}

if '--apply' not in sys.argv:
    raise SystemExit('Run with --apply after the installed helpers pass their browser checks.')

for short in mapping.values():
    if not (app_root / f'{short} Reuse.app').exists():
        raise SystemExit(f'Missing installed helper: {short}')

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
added = []
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
        if not short:
            continue
        originals.append({key: row[key] for key in ['Z_PK','ZBUNDLEIDENTIFIER','ZPATH','ZLAUNCHACTIVATES']})
        connection.execute('''
            UPDATE ZOPENINHANDLERAPP
            SET ZBUNDLEIDENTIFIER=?,ZPATH=?,ZLAUNCHACTIVATES=0,Z_OPT=Z_OPT+1 WHERE Z_PK=?
        ''', (f'me.dichev.LinkReuse.{short}', (app_root / f'{short} Reuse.app').as_uri(), row['Z_PK']))
        print(f'Updated {row["ZNAME"]} destination (id {row["Z_PK"]})')

    # Chrome was absent from the active browser list; add it without selecting it in any rule.
    arc = next((row for row in candidates if row['ZBUNDLEIDENTIFIER'] == 'company.thebrowser.Browser'), None)
    if arc and not connection.execute('SELECT 1 FROM ZOPENINHANDLERAPP WHERE ZHANDLER=? AND ZBUNDLEIDENTIFIER=?', (arc['ZHANDLER'], 'me.dichev.LinkReuse.Chrome')).fetchone():
        template = dict(next(row for row in candidates if row['ZBUNDLEIDENTIFIER'] == 'com.brave.Browser' and row['ZHANDLER'] == arc['ZHANDLER']))
        entity = template['Z_ENT']
        maximum = connection.execute('SELECT MAX(Z_PK) FROM ZOPENINHANDLERAPP').fetchone()[0]
        registered = connection.execute('SELECT Z_MAX FROM Z_PRIMARYKEY WHERE Z_ENT=?', (entity,)).fetchone()[0]
        pk = max(maximum, registered) + 1
        order = connection.execute('SELECT MAX(ZAPPORDER) FROM ZOPENINHANDLERAPP WHERE ZHANDLER=?', (arc['ZHANDLER'],)).fetchone()[0] + 1
        template.update(Z_PK=pk, Z_OPT=1, ZAPPORDER=order, ZNAME='Google Chrome', ZBUNDLEIDENTIFIER='me.dichev.LinkReuse.Chrome', ZPATH=(app_root/'Chrome Reuse.app').as_uri(), ZLAUNCHACTIVATES=0, ZLASTUSED=None)
        keys = list(template)
        connection.execute(f'INSERT INTO ZOPENINHANDLERAPP ({",".join(keys)}) VALUES ({",".join("?" for _ in keys)})', [template[key] for key in keys])
        connection.execute('UPDATE Z_PRIMARYKEY SET Z_MAX=? WHERE Z_ENT=?', (pk, entity))
        added.append(pk)
        print('Added Google Chrome to the browser picker; default remains Arc')

    rules_after = list(connection.execute('SELECT * FROM Z_6USEDINRULES ORDER BY Z_6SELECTEDAPPS,Z_7USEDINRULES'))
    assert rules_before == rules_after
    assert connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    (backup_root / 'routing-before.json').write_text(json.dumps({'changed': originals, 'added': added}, indent=2))
    connection.commit()
except BaseException:
    connection.rollback()
    raise
finally:
    connection.close()
    subprocess.run(['open', '-g', '-a', '/Applications/OpenIn.app'], check=True)

print(f'Backup: {backup_root}')
