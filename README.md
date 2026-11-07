# Link Reuse

[Source and releases](https://github.com/stefanbd/link-reuse). Windows 0.1.8 and macOS 3.2.2 bundle extension 3.2.2.

Link Reuse selects an existing matching tab before creating a new one. It preserves that tab's current page and deeper view. External links and webpage new-tab clicks use the **same extension matcher on Windows and macOS**. The native apps only deliver external links and activate the browser; they do not maintain separate matching rules.

Supported browsers: Edge, Chrome and Brave on Windows; Arc, Chrome, Brave, Edge and Edge Beta on macOS, plus Safari 18.4+ as a development preview. The extension must be loaded in every browser profile you want to use. Tab and window visibility is limited to what that browser exposes to its extension, including workspaces/spaces. Explicit external profile selection and Firefox are not implemented.

## Which clicks are handled

- External HTTP/HTTPS links delivered by the native app, directly or through an existing router.
- Webpage anchor links that would open a new tab: blank targets, Ctrl-click on Windows, Command-click on macOS, and middle-click. Modified background clicks stay in the background when no existing tab matches. A matching tab is selected regardless of its sleeping/discarded state.
- Ordinary same-tab navigation, Shift-only new-window clicks, downloads, Alt-click and synthetic clicks retain browser handling. Control-click is not given a separate macOS exclusion; it follows the ordinary click rules when the browser delivers a click event.

**Right-button clicks and the browser's native “Open link in new tab” context-menu action are excluded on both platforms.** Bookmarks, address-bar opens, browser-internal/store pages and script-only popups are also outside the webpage handler. No temporary tab is opened and closed as a workaround. After an extension update, reload the page containing the links once; destination tabs can remain asleep.

## Matching and policy

`extension/matching.mjs` owns lookup, final tab revalidation, shared request serialization, bounded learning and pruning. `extension/browser-bridge.mjs` uses it on both platforms. `extension/url-rules.mjs` supplies URL-format identities and lookup hints; it never chooses a tab or navigates a normalized URL. Unmatched requests always open the original URL.

`extension/learning-policy.json` owns:

- `noiseQueryKeys`: known tracking keys, compared without case, hyphens or underscores.
- `noiseQueryPrefixes`: literal case-insensitive prefixes. The default `utm_` does not swallow unrelated names such as `utmost`.
- `identityRules`: `{name, host, path, identity, uppercase?, ignoreAnchor?, noiseQueryKeys?}`. Host/path regexes match the entire host/path. `identity` is a JavaScript replacement template such as `$1`. Patterns compile once per policy. Invalid rules are ignored.

Defaults identify Jira issues, Confluence pages by page ID rather than title slug, and GitHub issue/PR threads. Identities include origin and rule name so different tenants, repositories and resources stay separate. Remaining meaningful query values and hash routes are retained. Jira/Confluence `search_id`, notification-referrer and `ref_src` differences are handled only within their rules; unrelated websites' search IDs remain meaningful.

Generic comparison removes known tracking parameters and sorts query names, preserving the order of repeated values. It **does not universally strip trailing slashes or fragments**: `/item` and `/item/`, or `#inbox` and `#sent`, can represent different resources. Known entity rules may ignore ordinary anchors and accept a trailing slash; `#/` and `#!` routes remain distinct.

Observed HTTP/JavaScript redirects and automatic URL rewrites can teach aliases. Trusted interaction ends the initial automatic redirect chain. The canonical reader uses one `rel=canonical`, or falls back to one `og:url` only when no canonical is declared. Both pass the same conservative same-origin/path/query checks. Ambiguous, cross-origin, broad homepage and fragment declarations are rejected.

Google Maps place IDs, Snowflake account/launch scope and Slack's documented destination hint remain small isolated code rules because their validation and lifecycle exceed a path regex. Slack hints are unverified lookup data, never authentication or replacement navigation URLs. Authentication URLs and payloads are not retained. There is no same-origin/path-only soft fallback.

## Storage, failure and lifetime

Learning remains in browser-session memory while matching normal tabs are open, bounded to 4,096 entries / 2 MiB of encoded record data. Closing the last matching tab or completing unrelated navigation prunes it. Worker stops preserve the session copy; browser restart and extension disable/reload/update clear it. Sensitive URLs and private tabs are excluded before matching. The popup's Forget control waits for the session copy to clear.

The same 16-request queue serves external and webpage opens. Session writes are coalesced and skipped when learning is unchanged, outside the opening result. Disconnect recovery makes four timed attempts and then waits for activity; there is no permanent polling. Accepted/uncertain requests are not retried through a second opening path.

Windows uses current-user-only named pipes. Chromium on macOS uses private Unix sockets and metadata under `/tmp/link-reuse-<uid>` (directory 0700, files/sockets 0600), verifies executable identity and process start time, and removes normal sessions on shutdown. Stale sessions are ignored/cleaned on access. Metadata contains process/browser identity and activity time, **no URLs or page content**. Each Chromium browser profile owns its native-messaging connection and helper process. Safari uses its bundled native app extension and Apple messaging; a private app-group socket returns request claims and results to the routing app. A request can be claimed once, preventing duplicate opens if Safari delivers it to more than one extension instance. Safari follows Apple’s containing-app message delivery; explicit profile selection is not available. The app-group container holds no learned links or URL files. Helpers block between events and exit when the browser connection closes. The routing app starts on demand; there is no login item, service, scheduled task or extra runtime.

## Windows installation

See [Windows setup, Scoop and updates](windows/README.md). Use a normal non-admin PowerShell:

```powershell
scoop bucket add link-reuse https://github.com/stefanbd/link-reuse
scoop install link-reuse/link-reuse
link-reuse --setup
```

Load the extension from `scoop/apps/link-reuse/current/extension`, not the bucket checkout or a numbered version folder. Use Windows Default Apps to choose Link Reuse for HTTP/HTTPS, or keep your router and add LinkReuse.exe as a destination. Windows owns default-app consent.

```powershell
scoop update
scoop update link-reuse
```

From 0.1.2 onward, updates restart the staged helper and reload the extension. A source webpage still needs a reload to receive changed content scripts. Existing router rules and HTTP/HTTPS registration are preserved.

## macOS installation and update

macOS 14+, universal Intel/Apple Silicon application with one embedded Safari Web Extension and the Chromium native host. Download the macOS release, extract and place **Link Reuse.app** in `~/Applications` first, then register its native bridge:

```sh
~/Applications/'Link Reuse.app'/Contents/MacOS/LinkReuse --install
```

For Chromium browsers, load unpacked `~/Applications/Link Reuse.app/Contents/Resources/extension` in each browser profile, and open its popup to check the connection. The stable extension ID remains `dkkfdmgdgomngkkoaaolokhechagdlfl`. The release is ad-hoc signed, not Developer ID signed/notarized; macOS may require a manual first-open confirmation.

**Upgrading from the earlier Mac implementation:** `python3 install.py` now stops only Link Reuse’s own processes, replaces the app, registers both browser connections and retains a rollback copy. Then reload/re-enable the bundled extension. For a downloaded release, `python3 install.py --app /path/to/Link\ Reuse.app` uses the same installer. Update app and extension together. The independent Swift matcher, Apple Events adapters, disk learning cache and recorder queue are no longer used. Full external reuse now requires the extension, just as on Windows. Browser Automation permission is no longer needed. Earlier on-disk learning files are not imported; newly learned data stays in session memory.

For Safari, open the installed app once, then enable **Link Reuse** in Safari Settings → Extensions and grant access to the websites where reuse is wanted. Local ad-hoc builds require Safari’s **Allow unsigned extensions** development setting, which resets after quitting Safari; macOS may also request access to the app’s own shared container. Development signing is available with `python3 build.py --sign <identity> --team <team-id>` when the signing key is accessible. A production distribution requires appropriate signing; this build is not notarized. `LinkReuse --safari-status` reports installation/enabled state without reading browser tabs.

Safari uses a generated Manifest V2 package with a resident background page because incoming native-port messages cannot reliably wake an unloaded MV3 page. The port listener is installed before asynchronous policy/session startup, with at most 16 early deliveries awaiting readiness. Its startup handshake also retrieves unclaimed requests from the app, covering delivery before the listener loads. Both paths use the same claim, so each request opens at most once. Chromium keeps Manifest V3; the engine and policy files remain shared. Safari’s resident context blocks between browser events and adds no polling. Native transport stage/error logs contain no URLs, tokens or page content.

Safari supplies document IDs from 18.4 onward. Where it lacks Chromium history/transition events, URL-update events and document/referrer checks feed the same observer. Referrer-based redirect continuation is conservative: omitted or reduced referrers do not authorize inferred aliases.

OpenIn can remain your default router. Existing `linkreuse://open/<browser>?url=<encoded-original>` destinations, including the new `Safari` browser ID, and routing rules continue to work. Any router that can send this ordinary app URL can use it; there is no runtime OpenIn dependency. Existing `openin-rewrite.js` and the separately invoked `configure_openin.py --apply` support the previously tested OpenIn schema. Rebuilding/installing does not modify router rules. External Safari links must pass through the app before Safari opens a tab; choosing Safari itself as the default destination does not provide pre-creation reuse.

Build from source with Xcode command-line tools, Python and a current Node version:

```sh
python3 verify.py
python3 build.py
python3 install.py
```

`build.py` prepares both extension manifests from the same source and builds the containing app and Safari target with `LinkReuse.xcodeproj`; it does not maintain a separate Safari matching implementation.

Python/Node are development tools only. The installed app and helper are the same native Swift binary; the installed Windows binary is .NET Native AOT. No Python, Node or .NET runtime is needed by end users.

## Verification and publishing

`python3 verify.py` runs shared JavaScript checks plus native request/IPC/framing checks without opening user browsers. `python3 build.py` compiles and verifies a universal Mac app. GitHub's Windows job runs the same JavaScript suite, Native AOT compilation and Windows pipe/host-update checks. The macOS job runs verification and packages the universal app. These checks do not certify live browser focus, space/workspace visibility, webpage event ordering or Scoop installation on a target machine.

For a release: commit only intended source/tests/docs and version changes, push the feature commit, wait for both relevant jobs, download artifacts for that exact SHA, verify packaged source/permissions and SHA-256, and publish the matching release assets. Only then commit/push the generated Scoop manifest separately. An installed extension folder is an artifact, never the source checkout. Preserve unrelated work and line endings; do not force-push or commit work addresses, tokens, private URLs, caches or backups.
