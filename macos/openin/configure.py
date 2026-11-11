#!/usr/bin/env python3
"""Update only eligible OpenIn browser destinations; preserve rules in one database transaction."""
import os
import json
import pathlib
import select
import signal
import sqlite3
import subprocess
import sys

root = (pathlib.Path.home() / 'Library/Group Containers/4QE86VV38D.app.loshadki.OpenIn'
        / 'Library/Application Support/OpenIn')
database = root / 'local.sqlite'
source_root = pathlib.Path(__file__).resolve().parent
app = pathlib.Path.home() / 'Applications/Link Reuse.app'
configuration = json.loads((app / 'Contents/Resources/configuration.json').read_text())
browsers = configuration['browsers']
template = (source_root / 'rewrite.js').read_text().strip()
scripts = {browser['id']: template.replace('{{browser}}', browser['id']) for browser in browsers}
mapping = {browser['bundleID']: browser['id'] for browser in browsers}
mapping.update({f'me.dichev.LinkReuse.{browser["id"]}': browser['id'] for browser in browsers})

if '--apply' not in sys.argv:
    raise SystemExit('Run with --apply after the installed app passes its browser checks.')

def openin():
    found = subprocess.run(['pgrep', '-x', '-u', str(os.getuid()), 'OpenIn'], capture_output=True, text=True)
    if found.returncode not in (0, 1): found.check_returncode()
    return [int(pid) for pid in found.stdout.split()]


# Stop OpenIn and wait for each process's exit event, so it can't write its settings while they change.
exits, running = select.kqueue(), 0
for pid in openin():
    try: exits.control([select.kevent(pid, select.KQ_FILTER_PROC, select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                                      select.KQ_NOTE_EXIT)], 0)
    except ProcessLookupError: continue
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    running += 1
while running: running -= len(exits.control(None, running))
if openin(): raise SystemExit('OpenIn started again; its settings were not changed.')

connection = sqlite3.connect(database)
connection.row_factory = sqlite3.Row
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
        connection.execute('''
            UPDATE ZOPENINHANDLERAPP
            SET ZBUNDLEIDENTIFIER=?, ZPATH=?, ZLAUNCHACTIVATES=0, ZREWRITEURL=1, ZREWRITEURLTYPE='Script',
                ZREWRITEURLSCRIPTTEXT=?, Z_OPT=Z_OPT+1
            WHERE Z_PK=?
        ''', ('me.dichev.LinkReuse', app.as_uri(), scripts[short], row['Z_PK']))
        print(f'Updated {row["ZNAME"]} destination (id {row["Z_PK"]})')

    rules_after = list(connection.execute('SELECT * FROM Z_6USEDINRULES ORDER BY Z_6SELECTEDAPPS,Z_7USEDINRULES'))
    assert rules_before == rules_after
    assert connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    connection.commit()
except BaseException:
    connection.rollback()
    raise
finally:
    connection.close()
    subprocess.run(['open', '-g', '-a', '/Applications/OpenIn.app'], check=True)
