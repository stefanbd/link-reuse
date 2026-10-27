import collections
import http.server
import json
import pathlib
import statistics
import subprocess
import threading
import time
import uuid
import urllib.parse

arrived = {}
class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        arrived.setdefault(self.path, time.monotonic())
        body = b'<!doctype html><title>Link Reuse timing check</title><p>Temporary timing check.</p>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args): pass

server = http.server.ThreadingHTTPServer(('127.0.0.1',0),Page)
threading.Thread(target=server.serve_forever,daemon=True).start()
prefix = '/link-reuse-timing-' + uuid.uuid4().hex
base = f'http://127.0.0.1:{server.server_port}'
helper = str(pathlib.Path.home()/'Applications/Link Reuse.app')
measurements = collections.defaultdict(list)
try:
    for round_number in range(3):
        for kind in ['direct', 'helper', 'openin']:
            path = prefix + f'/{round_number}/{kind}'
            command = {'direct':['open','-a','/Applications/Arc.app'], 'helper':['open','-g','-a',helper], 'openin':['open']}[kind]
            start = time.monotonic()
            url = base + path
            if kind == 'helper': url = 'linkreuse://open/Arc?url=' + urllib.parse.quote(url, safe='')
            subprocess.run(command+[url],check=True)
            deadline = start+20
            while path not in arrived and time.monotonic()<deadline:
                time.sleep(0.005)
            if path not in arrived: raise RuntimeError(f'No page request for {kind}')
            measurements[kind].append(round((arrived[path]-start)*1000,1))
    subprocess.run([str(pathlib.Path(helper) / 'Contents/MacOS/LinkReuse'), '--benchmark', 'Arc'], check=True)
    print(json.dumps({'samples_ms_to_first_page_request':measurements,'medians_ms':{k:statistics.median(v) for k,v in measurements.items()}},indent=2))
finally:
    cleanup=f'''tell application "Arc"
        repeat with wi from 1 to count of windows
            set tabURLs to URL of every tab of window wi
            repeat with ti from (count of tabURLs) to 1 by -1
                if item ti of tabURLs starts with "{base+prefix}" then close tab ti of window wi
            end repeat
        end repeat
    end tell'''
    subprocess.run(['osascript','-e',cleanup],check=True,timeout=20)
    server.shutdown()
