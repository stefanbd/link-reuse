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

class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        requests[self.path] += 1
        body = b'<!doctype html><title>Link Reuse verification</title><p>Temporary link-reuse verification page.</p>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Page)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}/link-reuse-{uuid.uuid4().hex}'

def apple(script):
    result = subprocess.run(['osascript', '-e', script], text=True, capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return result.stdout.strip()

def state(browser, url):
    return apple(f'''tell application "{browser}"
        set totalTabs to 0
        set matchingIDs to {{}}
        set activeID to ""
        repeat with wi from 1 to count of windows
            if mode of window wi is "normal" then
                set totalTabs to totalTabs + (count of tabs of window wi)
                set tabURLs to URL of every tab of window wi
                set tabIDs to id of every tab of window wi
                repeat with ti from 1 to count of tabURLs
                    if item ti of tabURLs is "{url}" then set end of matchingIDs to (item ti of tabIDs as text)
                end repeat
            end if
        end repeat
        if (count of windows) > 0 then set activeID to (id of active tab of front window as text)
        set AppleScript's text item delimiters to "|"
        return (totalTabs as text) & ";" & (matchingIDs as text) & ";" & activeID
    end tell''').split(';')

def wait_for(check, label, timeout=40):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.1)
    raise RuntimeError(f'Timed out: {label}; a macOS Automation prompt may need approval')

def open_helper(short, url):
    if '--openin' in sys.argv:
        subprocess.run(['open', url], check=True)
        return
    app = pathlib.Path.home() / f'Applications/Link Reuse/{short} Reuse.app'
    subprocess.run(['open', '-g', '-a', str(app), url], check=True)

for browser, short in [('Arc','Arc'), ('Google Chrome','Chrome'), ('Brave Browser','Brave'), ('Microsoft Edge Beta','EdgeBeta')]:
    if len(sys.argv) > 1 and short not in sys.argv[1:]:
        continue
    was_running = apple(f'application "{browser}" is running') == 'true'
    original_id = apple(f'''tell application "{browser}"
        if (count of windows) is 0 then return ""
        return id of active tab of front window
    end tell''') if was_running else ''
    url_a = base + '/' + short + '/a'
    url_b = base + '/' + short + '/b'
    path_a = '/' + url_a.split('/',3)[3]
    print(f'{short}: testing first open', flush=True)
    try:
        open_helper(short, url_a)
        wait_for(lambda: requests[path_a] == 1, f'{short} first page loaded')
        first = state(browser, url_a)
        assert first[1] and '|' not in first[1], first
        open_helper(short, url_b)
        wait_for(lambda: state(browser, url_b)[1], f'{short} second page opened')
        before = state(browser, url_a)
        print(f'{short}: testing duplicate selection', flush=True)
        start = time.monotonic()
        open_helper(short, url_a)
        final = wait_for(lambda: (s if (s := state(browser,url_a))[2] == first[1] else None), f'{short} existing tab activated')
        elapsed = round((time.monotonic() - start) * 1000)
        time.sleep(0.3)
        assert final[0] == before[0], (before, final)
        assert final[1] == first[1], (first, final)
        assert requests[path_a] == 1, requests[path_a]
        print(json.dumps({'browser': short, 'new_link': 'one tab', 'duplicate': 'same tab ID; unchanged tab count; no reload', 'observed_switch_ms_including_test_polling': elapsed}), flush=True)
    finally:
        if apple(f'application "{browser}" is running') == 'true':
            apple(f'''tell application "{browser}"
                repeat with wi from 1 to count of windows
                    if mode of window wi is "normal" then
                        set tabURLs to URL of every tab of window wi
                        repeat with ti from (count of tabURLs) to 1 by -1
                            if item ti of tabURLs starts with "{base}" then close tab ti of window wi
                        end repeat
                    end if
                end repeat
            end tell''')
            if was_running and original_id:
                if short == 'Arc':
                    apple(f'tell application "{browser}" to select tab id "{original_id}" of front window')
                else:
                    apple(f'''tell application "{browser}"
                        set ids to id of every tab of front window
                        repeat with i from 1 to count of ids
                            if (item i of ids as text) is "{original_id}" then set active tab index of front window to i
                        end repeat
                    end tell''')
            elif not was_running:
                apple(f'tell application "{browser}" to quit')
server.shutdown()
