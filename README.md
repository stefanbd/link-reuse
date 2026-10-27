# Link Reuse for OpenIn

Private source repository: [stefanbd/link-reuse](https://github.com/stefanbd/link-reuse).

OpenIn chooses the browser. A small native helper checks existing normal tabs before opening a link, selects a match without changing its current URL, or opens the original link normally. Arc includes tabs in its spaces. The active matching tab wins; otherwise exact URLs precede equivalent resource URLs.

Supported native destinations: Arc, Chrome, Brave and Edge Beta. Explicit OpenIn profile/private routes and unsupported browsers retain their original handling. This handles external links routed through OpenIn; ordinary webpage clicks are not intercepted.

## Runtime components

- One Swift implementation, compiled into the four browser-specific app bundles in `~/Applications/Link Reuse`.
- The same compiled program installed as `~/src/link-reuse/native-host`, invoked directly by Chromium native messaging. It does not use a shell launcher or Python. A standalone executable keeps the recorder separate from macOS application URL delivery.
- One Manifest V3 extension in `~/src/link-reuse/extension`. It observes navigation, reads canonical metadata, and sends bounded updates over the native connection.

Python is used only for development/build/install/test scripts; no Python recorder runs during use. There is no server, network resolver, login item or LaunchAgent.

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

A helper starts when OpenIn sends it a link. The most recently active supported browser keeps its helper warm, including while you work in another non-browser app. Helpers for other browsers exit after two minutes without relevant activity. A helper also exits when its browser quits, once any queued open request finishes. Opening another link launches it again as needed.

The Swift recorder is launched by the extension and blocks on its native-message pipe between events. Its connection keeps the extension worker alive. Neither is a zero-memory process; the design avoids a cold recorder launch on every observation. Browser-native tab queries happen when opening a link; extension tab snapshots happen on relevant navigation/closure events.

## Installation and updates

The repository contains the Swift and extension source, AppleScript adapters, build/install scripts and tests. Generated app bundles, the installed `native-host` binary, local backups, browser settings and learned URL data are excluded from Git.

To restore the source on this Mac after moving aside any existing checkout:

```sh
gh repo clone stefanbd/link-reuse ~/src/link-reuse
cd ~/src/link-reuse
python3 build.py
```

Building requires macOS, Xcode command-line tools with Swift 6, Python 3, and the four browser applications at the paths in `build.py`. Node.js runs the extension unit tests. For a fresh installation only, run `python3 install.py`, then `python3 install_redirects.py`, and load the unpacked extension as described below. Existing helper apps are deliberately not overwritten by `install.py`.

This is the current personal Mac setup: keep the installed extension at the documented path. Chromium derives the unpacked extension ID from that path, and `NativeHost.extensionOrigin` restricts the recorder to the current ID. A different account or installation path requires reconciling that constant with the ID printed by `install_redirects.py`, then rebuilding and reinstalling. OpenIn routing is configured separately; rebuilding source does not change it.

In each supported browser, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `/Users/stefandichev/src/link-reuse/extension`. Reload the extension after updates. Version 2 uses `tabs` permission to enumerate current URLs and prune closed-tab relationships; it does not use the browser history API or extension storage.

Arc has been the configured extension browser. Chrome, Brave and Edge Beta need their own manual extension load for learning; their native helpers support ordinary URL and Maps identity matching independently.

`python3 build.py` uses Xcode's `swiftc`, `osacompile` and ad-hoc `codesign`. `install.py` performs an initial app install and refuses to overwrite existing apps. `install_redirects.py` copies the shared native executable and registers it for all four browsers. The native host identifies its actual parent browser because Arc uses Chrome's host registration on this machine.

OpenIn remains the default HTTP/HTTPS handler. Its eligible normal destinations point to the corresponding helper app. `configure_openin.py` is the existing backed-up, version-specific OpenIn database configuration script; upgrades to the helper do not require running it again. To undo a route, select the original browser destination in OpenIn.

## Verification

- `node --test test_redirects.mjs test_canonical.mjs test_learning.mjs test_bridge.mjs`
- Compile/run `test_url_matching.swift` with `URLMatching.swift`.
- Compile/run `test_learning.swift` with `URLMatching.swift`, `LearningPolicy.swift`, `LearningStore.swift` and `NativeHost.swift`.
- `python3 test_routing.py`: exact reuse in the four browsers using temporary local pages.
- `python3 test_redirect_integration.py`: actual redirect learning, same-tab reuse with no extra page requests, and pruning after closure through OpenIn into Arc.
- `python3 test_resource_integration.py`: canonical reviews reuse, unrelated-item separation and pruning after navigation away or closure.

Unit checks cover shared privacy exclusions, hard count/byte bounds, queue saturation, late acknowledgements, clear/replay races, stale snapshot suppression, live-resource retention, dead-session rejection, private file modes, protocol framing and helper lifetime decisions. Runtime tests close only their own temporary pages.

Verified on 27 October 2026: 20 extension logic tests, 24 resource-matching checks, and native storage/privacy/lifecycle/framing checks passed. All four helpers passed exact-link same-tab/no-reload tests. Arc passed real HTTP, JavaScript and SPA redirect reuse and tab-close pruning; generic canonical reuse and cleanup after navigating away; sensitive-link bypass with the test token absent from storage; and preservation of the supplied Maps photo tab from both the search and base-place links. Inactive Chrome, Brave and Edge Beta helpers exited automatically while Arc remained warm. No Python recorder remained running.
