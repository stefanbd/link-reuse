# Link Reuse for OpenIn

Private source repository: [stefanbd/link-reuse](https://github.com/stefanbd/link-reuse).

OpenIn chooses the browser and passes that choice to one native Link Reuse app. The app checks existing normal tabs before opening a link, selects a match without changing its current URL, or opens the original link normally. Arc includes tabs in its spaces. The active matching tab wins; otherwise exact URLs precede equivalent resource URLs.

Supported native destinations: Arc, Chrome, Brave and Edge Beta. Explicit OpenIn profile/private routes and unsupported browsers retain their original handling. This handles external links routed through OpenIn; ordinary webpage clicks are not intercepted.

## Runtime components

- One native `~/Applications/Link Reuse.app` handles all configured browsers. It receives `linkreuse://open/<browser>?url=<encoded-original-url>` from OpenIn, validates the request and reuses the existing matching implementation.
- The app includes `Contents/Helpers/LinkReuseHost`, the same Swift implementation running as the native-messaging recorder. Browsers launch it directly; no shell or Python interpreter is involved.
- One shared Manifest V3 extension is bundled at `Contents/Resources/extension`. A folder shortcut at `~/Applications/Link Reuse Extension` makes it selectable in the browser's Load unpacked dialog.

Python is used only for development/build/install/test scripts. There is no web server, network resolver, login item or LaunchAgent. Chromium owns each native-messaging connection and its recorder process; one app installation does not imply one OS process across all browser profiles.

`browsers.json` is the browser catalog used by the build. Only installed browsers are included in the app, with their compiled adapters. The manifest public key fixes the extension ID across accounts and installation paths; the build derives the allowed native origin from that key. Installed operation does not depend on the source checkout.

## Matching and live-tab learning

Ordinary matching preserves path, query and fragment, normalizing scheme/host case, default ports and an empty root path. The extension learns observed HTTP/JavaScript redirects and automatic in-page URL changes. A trusted pointer/keyboard interaction ends the initial automatic redirect chain.

For general websites, one same-origin `rel=canonical` declaration can connect a page to its main resource. The canonical must use the same path or a parent at a path-segment boundary. Conflicting query values, fragments, credentials, broad homepage declarations and ambiguous/cross-origin declarations are rejected. This is a website-provided hint, not universal semantic understanding.

Google Maps also has a local matcher for the unique `0x…:0x…` place identifier in the place-details block. Camera, photo, zoom and tracking differences do not change that identity. Other places and directions stay separate. Recognized hosts are `google.com`, `www.google.com` and `maps.google.com`.

There is no age-based expiry. A learned relationship survives only while its destination is represented by an open normal tab in that observing profile, including an equivalent photo/reviews view. Closing the last matching tab or finishing navigation to an unrelated page prunes it. The previous page is retained temporarily during a loading transition so its canonical metadata can arrive before pruning. Updates are event-driven and briefly coalesced; opening a link still compares against the browser's current tabs.

The recorder removes its session on normal connection shutdown. After an abrupt crash, leftover records are ignored unless both their browser session and recorder process are still live, and are removed on the next access. No startup daemon is added solely to delete crash leftovers. Restarting the browser or reloading the extension can require learning redirects again. It cannot predict previously unseen redirects without visiting them.

On upgrade, eligible old mappings are imported only if their destination is currently open; old unbounded alias files are then removed. Old aliases are never read by the opener.

## Privacy and hard limits

The single policy source is `extension/learning-policy.json`; builds copy it into the native app resources. JavaScript and Swift share privacy test vectors in `privacy-vectors.json`.

- Steady-state cache: at most **2 MiB and 4,096 relationships per browser**, shared across active extension profiles.
- Outgoing retry queue: at most **128 observations / 128 KiB**, plus one in-flight batch of at most 32 observations. Latest observations replace older ones for the same source/kind. Old acknowledgements cannot remove newer data.
- Individual URLs: at most **4,096 UTF-8 bytes** for learning/reuse. Longer URLs open normally.
- Tab snapshot: at most **512 KiB**. Excess data is omitted conservatively; native-message framing is bounded independently.
- Native acknowledgements time out; reconnect attempts have a short cooldown and happen on subsequent activity or a popup request, without a polling loop.

Recognized login/OAuth/reset/verification paths, credential-bearing URLs, common token/key/signature/session query parameters and parameter-bearing fragments are excluded from both learning and reuse. Both the extension and native code enforce the policy. This is conservative pattern filtering, not a guarantee that every possible sensitive URL can be identified.

Data stays in `~/Library/Application Support/Link Reuse/Live/<browser-bundle-id>/cache.json`. Files are mode 0600 inside private directories. The cache stores relationship URLs and session identifiers, not full tab inventories or page bodies. It is plain text and accessible to software running with your user permissions. Native messaging accepts only this extension's origin. Logs contain no URLs.

The extension popup reports the stored count/size and provides **Forget learned links in this browser**. It clears all active profiles of that browser and prevents old queued observations from restoring cleared data. Static URL/Maps identifier matching still works after clearing.

## Process lifetime

The routing app starts when OpenIn sends its first request. It stays warm while any configured browser runs and exits when the last one closes, after queued requests finish. It does not track the active browser or run idle-retirement timers.

The Swift recorder is launched by the extension and blocks on its native-message pipe between events. Its connection keeps the extension worker alive. Browser-native tab queries happen when opening a link; extension tab snapshots happen on relevant navigation/closure events.

## Installation and updates

Requirements: macOS 14 or newer, Xcode command-line tools with Swift 6, Python 3, and at least one supported browser installed at a path in `browsers.json`. Node.js is needed only for extension tests.

```sh
gh repo clone stefanbd/link-reuse ~/src/link-reuse
cd ~/src/link-reuse
python3 verify.py
python3 build.py
python3 install.py
```

`build.py` compiles the shared Swift program once, packages the app, compiles adapters for installed browsers, bundles the extension and signs/verifies the native code. `install.py` installs the app and registers its bundled recorder for those browsers. It refuses to overwrite an existing app; for an update, quit Link Reuse and move the old app aside first.

In each browser, open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose `~/Applications/Link Reuse Extension`. In the file picker, Command–Shift–G opens Go to Folder; enter `~/Applications`, then select **Link Reuse Extension**. Version 3 has stable ID `dkkfdmgdgomngkkoaaolokhechagdlfl`. Upgrading from version 2 requires removing the old extension once, then loading this one. Subsequent updates keep the ID and only need Reload.

The extension uses `tabs`, `webNavigation` and `nativeMessaging`; it does not use saved browser history. Arc has the extension installed. Chrome, Brave and Edge Beta need their own extension load for redirect/canonical learning; their ordinary URL and Maps identity matching work independently.

OpenIn remains the default HTTP/HTTPS handler. Each eligible browser destination retains its name and rule membership, points to the same Link Reuse app, and uses `openin-rewrite.js` with its browser ID substituted. Normal links therefore carry the chosen browser explicitly without adding a shell launch to the click path.

`python3 configure_openin.py --apply` applies that configuration to the tested OpenIn 4.5.2 database schema, makes a private backup, preserves rules/profile/private routes, and refuses to replace unrelated custom rewrites. It quits and reopens OpenIn. This is a separate, explicit setup step; rebuilding the app does not change routing. To undo a destination, select the real browser in OpenIn and disable its Link Reuse URL rewrite.

Old helper apps may be archived after verifying the new OpenIn route. The installer stages bounded old relationships through the existing one-time migration mechanism; the new recorder imports only destinations represented by current tabs and deletes the staging file. Runtime caches, migration files, compiled binaries and settings backups are excluded from Git.

## Verification

- `python3 verify.py`: extension tests plus native resource matching, request validation, privacy, storage and framing tests. It does not open browsers.
- `python3 test_routing.py`: exact same-tab/no-reload checks through the unified app in each installed browser.
- `python3 test_routing.py Arc --openin`: the actual default OpenIn route.
- `python3 test_redirect_integration.py`: real HTTP/JavaScript/SPA redirect learning and closure pruning through OpenIn into Arc, plus sensitive-link bypass.
- `python3 test_resource_integration.py`: canonical deeper-page reuse, unrelated-item separation and pruning after navigation/closure.
- `python3 test_lifetime.py`: temporary stand-in browser apps verify that the routing process survives one browser closing and exits after the last. Real browsers are left alone.
- `python3 test_latency.py`: temporary local pages measure direct browser, helper and OpenIn opening paths, plus the native tab-lookup benchmark. These include browser/OS overhead and are not network-page load benchmarks.

Runtime tests close only their own temporary pages. Safari and Firefox/Zen are not implemented or certified by these tests.

Verified on 27 October 2026: 20 extension tests, 24 native resource-matching checks, 32 OpenIn rewrite/request checks, and native storage/privacy/framing tests passed. The unified app passed same-tab/no-reload checks in all four installed browsers, the actual OpenIn-to-Arc route, HTTP/JavaScript/SPA redirect learning, canonical deeper-page reuse, closure/navigation pruning, sensitive-link bypass, the original Maps search/base links preserving the existing photo tab, and the isolated two-browser lifetime test.

The small local timing sample used 20 native lookups and three new-page opens per path. Before/after medians in milliseconds were: native lookup **117 / 102**, direct Arc **346 / 312**, helper-to-Arc **467 / 502**, and OpenIn-to-Arc **887 / 701**. These are noisy local observations, not a guaranteed speedup or a general page-load benchmark.

Version 3.0.1 reduces synchronous browser calls in the compiled adapters: it removes redundant window/tab-count requests while retaining Arc's proven window/space selection method. A side-by-side, interleaved 20-sample Arc snapshot check measured **107 ms** with the previous adapter and **66 ms** with the optimized one. This is about 39% less lookup time; it is not a claim that the entire OpenIn opening path is 39% faster. OpenIn's existing rules, picker and tracking-parameter cleanup remain intact. No extension reload is required for this adapter-only update.

To compare two compiled Arc adapters without changing tabs, compile `test_adapter_latency.swift` with `xcrun swiftc -parse-as-library` and pass the old/new `.scpt` paths to the resulting executable.
