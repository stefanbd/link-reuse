import collections
import http.server
import json
import pathlib
import subprocess
import threading
import time
import uuid
import sys

requests = collections.Counter()
prefix = '/link-reuse-redirect-' + uuid.uuid4().hex

class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        requests[self.path] += 1
        suffix = self.path.removeprefix(prefix + '/')
        if suffix == 'start-http':
            self.send_response(302)
            self.send_header('Location', prefix + '/final-http')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            return
        script = ''
        if suffix == 'start-js':
            script = f'<script>setTimeout(() => location.replace("{prefix}/final-js"), 100)</script>'
        elif suffix == 'start-spa':
            script = f'<script>setTimeout(() => history.replaceState(null, "", "{prefix}/final-spa"), 100)</script>'
        body = ('<!doctype html><title>Link Reuse redirect verification</title><p>Temporary redirect check.</p>' + script).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args): pass

server = http.server.ThreadingHTTPServer(('127.0.0.1',0),Page)
threading.Thread(target=server.serve_forever,daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'
alias_root = pathlib.Path.home()/'Library/Application Support/Link Reuse/Live/company.thebrowser.Browser'

def apple(script):
    return subprocess.run(['osascript','-e',script],capture_output=True,text=True,check=True,timeout=20).stdout.strip()

def state(url):
    return apple(f'''tell application "Arc"
        set allIDs to id of every tab of every window
        set allURLs to URL of every tab of every window
        set totalTabs to 0
        set matchingIDs to {{}}
        repeat with wi from 1 to count of allURLs
            set tabURLs to item wi of allURLs
            set tabIDs to item wi of allIDs
            set totalTabs to totalTabs + (count of tabURLs)
            repeat with ti from 1 to count of tabURLs
                if item ti of tabURLs is "{url}" then set end of matchingIDs to (item ti of tabIDs as text)
            end repeat
        end repeat
        set activeID to ""
        try
            set activeID to id of active tab of front window
        end try
        set AppleScript's text item delimiters to "|"
        return (totalTabs as text) & ";" & (matchingIDs as text) & ";" & (activeID as text)
    end tell''').split(';')

def learned(source, destination):
    for file in alias_root.glob('*.json'):
        records = [record for session in json.loads(file.read_text()).get('sessions', []) for record in session.get('records', [])]
        if any(record['source'] == source and record.get('destination') == destination for record in records):
            return True
    return False

def wait_for(check, label):
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        value=check()
        if value: return value
        time.sleep(.1)
    raise RuntimeError('Timed out: '+label)

original_id=apple('''tell application "Arc"
    try
        return id of active tab of front window
    on error
        return ""
    end try
end tell''')
try:
    for kind in ([] if '--sensitive-only' in sys.argv else ['http','js','spa']):
        source=base+prefix+'/start-'+kind
        destination=base+prefix+'/final-'+kind
        print(f'{kind}: observing initial redirect',flush=True)
        subprocess.run(['open',source],check=True)
        wait_for(lambda: learned(source,destination),f'{kind} redirect learned by the extension')
        before=state(destination)
        assert before[1] and '|' not in before[1],before
        hits=requests[prefix+'/start-'+kind]
        destination_hits=requests[prefix+'/final-'+kind]
        subprocess.run(['open',source],check=True)
        time.sleep(.6)
        after=state(destination)
        assert after[0]==before[0],(before,after)
        assert after[1]==before[1] and after[2]==before[1],(before,after)
        assert requests[prefix+'/start-'+kind]==hits==1,requests
        assert requests[prefix+'/final-'+kind]==destination_hits,requests
        print(f'{kind}: automatically learned; reopened through OpenIn into the same tab; no new source or destination request',flush=True)
        apple(f'tell application "Arc" to close tab id "{after[1]}" of front window')
        wait_for(lambda: not learned(source, destination), f'{kind} mapping removed after closing its last destination tab')
        print(f'{kind}: learned mapping removed after its destination tab closed', flush=True)
    sensitive = base + prefix + '/account-check?token=link-reuse-test-secret'
    sensitive_path = prefix + '/account-check?token=link-reuse-test-secret'
    initial = state(sensitive)
    for count in [1, 2]:
        if count == 2:
            neutral = base + prefix + '/between-sensitive-opens'
            subprocess.run(['open', neutral], check=True)
            wait_for(lambda: requests[prefix + '/between-sensitive-opens'] == 1, 'neutral page between sensitive opens')
        subprocess.run(['open', sensitive], check=True)
        wait_for(lambda: requests[sensitive_path] == count, f'sensitive link open {count} reached the server')
    final = state(sensitive)
    assert int(final[0]) == int(initial[0]) + 3, (initial, final)
    assert len(final[1].split('|')) == 2, final
    assert all('link-reuse-test-secret' not in file.read_text() for file in alias_root.glob('*.json'))
    print('Sensitive URL: each open reaches the browser normally; the token is never stored', flush=True)
finally:
    apple(f'''tell application "Arc"
        repeat with wi from 1 to count of windows
            set tabURLs to URL of every tab of window wi
            repeat with ti from (count of tabURLs) to 1 by -1
                if item ti of tabURLs starts with "{base+prefix}" then close tab ti of window wi
            end repeat
        end repeat
        if "{original_id}" is not "" then select tab id "{original_id}" of front window
    end tell''')
    server.shutdown()
