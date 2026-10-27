import collections
import http.server
import json
import pathlib
import subprocess
import threading
import time
import uuid

requests = collections.Counter()
prefix = '/link-reuse-resource-' + uuid.uuid4().hex


class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        requests[self.path] += 1
        canonical = ''
        if self.path == prefix + '/products/42/reviews':
            canonical = f'<link rel="canonical" href="{prefix}/products/42">'
        body = ('<!doctype html><html><head><title>Link Reuse resource verification</title>' + canonical +
                '</head><body>Temporary resource matching check.</body></html>').encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args): pass


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Page)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'
alias_root = pathlib.Path.home() / 'Library/Application Support/Link Reuse/Live/company.thebrowser.Browser'


def apple(script):
    return subprocess.check_output(['osascript', '-e', script], text=True, timeout=20).strip()


def state():
    return apple('''tell application "Arc"
        set total to 0
        set allURLs to URL of every tab of every window
        repeat with urls in allURLs
            set total to total + (count of urls)
        end repeat
        return (total as text) & "\n" & (id of active tab of front window as text) & "\n" & (URL of active tab of front window)
    end tell''').split('\n', 2)


def wait_for(check, label):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if check(): return
        time.sleep(.1)
    raise RuntimeError('Timed out: ' + label)


def learned(source, destination):
    return any(record['kind'] == 'canonical' and record['source'] == source and record.get('destination') == destination
               for file in alias_root.glob('*.json')
               for session in json.loads(file.read_text()).get('sessions', []) for record in session.get('records', []))


def open_url(url):
    subprocess.run(['open', url], check=True)


try:
    original = state()
except subprocess.CalledProcessError:
    original = ['', '', '']
try:
    product = base + prefix + '/products/42'
    reviews = product + '/reviews'
    open_url(reviews)
    wait_for(lambda: learned(reviews, product), 'page-declared canonical recorded by extension')
    before = state()
    assert before[2] == reviews, before
    open_url(product)
    time.sleep(.7)
    assert state() == before, 'Deeper view or tab count changed'
    assert requests[prefix + '/products/42'] == 0, requests
    assert requests[prefix + '/products/42/reviews'] == 1, requests
    print('Canonical resource: parent link reuses the reviews tab, preserving its URL and tab ID, with no reload', flush=True)

    other = base + prefix + '/products/43'
    open_url(other)
    wait_for(lambda: requests[prefix + '/products/43'] == 1, 'different product opens normally')
    after = state()
    assert int(after[0]) == int(before[0]) + 1 and after[2] == other, after
    print('Different product: opens a separate tab normally', flush=True)

    unknown = base + prefix + '/articles/44'
    open_url(unknown + '/gallery')
    wait_for(lambda: requests[prefix + '/articles/44/gallery'] == 1, 'page without canonical opens')
    before_unknown = state()
    open_url(unknown)
    wait_for(lambda: requests[prefix + '/articles/44'] == 1, 'parent without identity evidence opens normally')
    after_unknown = state()
    assert int(after_unknown[0]) == int(before_unknown[0]) + 1, after_unknown
    print('No canonical declaration: a shared path prefix does not merge tabs', flush=True)
    unrelated = base + prefix + '/unrelated'
    apple(f'tell application "Arc" to set URL of tab id "{before[1]}" of front window to "{unrelated}"')
    wait_for(lambda: requests[prefix + '/unrelated'] == 1, 'test tab navigated away')
    wait_for(lambda: not learned(reviews, product), 'canonical mapping removed after navigation away')
    print('Canonical relation removed when its tab navigates to another resource', flush=True)
    open_url(reviews)
    wait_for(lambda: learned(reviews, product), 'canonical learned again for a newly opened tab')
    reopened = state()
    apple(f'tell application "Arc" to close tab id "{reopened[1]}" of front window')
    wait_for(lambda: not learned(reviews, product), 'canonical mapping removed after the reviews tab closes')
    print('Canonical relation removed when its last matching tab closes', flush=True)
finally:
    apple(f'''tell application "Arc"
        repeat with wi from 1 to count of windows
            set urls to URL of every tab of window wi
            repeat with ti from (count of urls) to 1 by -1
                if item ti of urls starts with "{base + prefix}" then close tab ti of window wi
            end repeat
        end repeat
        if "{original[1]}" is not "" then select tab id "{original[1]}" of front window
    end tell''')
    server.shutdown()
