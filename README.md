# Link Reuse

[Source and releases](https://github.com/stefanbd/link-reuse). Windows packages are published automatically from `main` (see Releases); the published macOS package remains 3.2.12. The current extension/macOS version is 3.2.51. Safari remains a development preview.

Link Reuse selects an existing matching tab before creating a new one. It preserves that tab's current page and deeper view. External links and webpage new-tab clicks use the **same extension matcher on Windows and macOS**. The native apps only deliver external links and activate the browser; they do not maintain separate matching rules.

Supported browsers: Edge, Chrome and Brave on Windows; Arc, Chrome, Brave, Edge and Edge Beta on macOS, plus Safari as a development preview. The Mac app requires macOS 26+. The extension must be loaded in every browser profile you want to use. Tab and window visibility is limited to what that browser exposes to its extension, including workspaces/spaces. Explicit external profile selection and Firefox are not implemented.

## Which clicks are handled

- External HTTP/HTTPS links delivered by the native app, directly or through an existing router.
- Webpage anchor links that would open a new tab: blank targets, Ctrl-click on Windows, Command-click on macOS, and middle-click. Modified background clicks keep the current page in front: an unmatched link opens beside it in the background, and a matching tab is moved beside it without being selected. It is selected instead if the browser cannot move it, or if moving it would change its tab group: Chromium regroups a moved tab by its neighbours, so a tab moves only between ungrouped tabs or within its own group. Foreground opens select the matching tab. Either way the match is used regardless of its sleeping/discarded state.
- A plain same-tab link to a page already open in another tab selects that tab, moved beside the current one (same tab-group rule), and leaves the current page where it is. Pressing such a link asks the extension whether another tab shows it. With a match the click is cancelled before the page or its router sees it (and replayed if switching fails); without one it is left alone, so client-side routing (Jira, GitHub) is untouched. A click before the answer (fast or by keyboard) falls back to the Navigation API's `navigate` event, which holds only real page loads, never a router's same-document navigation. While the extension checks, the navigation is held. Without a match, or without an answer within a second, it resumes unchanged. A resumed navigation still teaches redirects: the extension records the link it resumed as the source of the tab's next commit, because Safari reports the held original as failed and does not report the resumed one before it commits. Links in frames, `noreferrer` links, forms, script navigations and back/forward are left alone.
- Other same-tab navigation, Shift-only new-window clicks, downloads, Alt-click and synthetic clicks retain browser handling. Control-click is not given a separate macOS exclusion; it follows the ordinary click rules when the browser delivers a click event.

**Right-button clicks and the browser's native “Open link in new tab” context-menu action are excluded on both platforms.** Bookmarks, address-bar opens, browser-internal/store pages and script-only popups are also outside the webpage handler. No temporary tab is opened and closed as a workaround. The webpage handler is active from page start and never waits for the extension, so a slow browser delays the tab switch instead of leaving the click to the browser. After an extension update Safari refreshes open pages itself; in Chromium browsers reload a page containing links once. Destination tabs can remain asleep.

**Conflicting click extensions.** Another extension that captures `click` on `window` and calls `stopImmediatePropagation` without `preventDefault` hides the click from this handler, while the browser still opens its own tab. StopTheMadness Pro does this for ⌘-clicks when "Protect ⌘-click" or "Protect all links" is on. With "Stop link trackers" on, it also does it for cross-site `target=_blank`/`noopener` links. Safari decides which extension's listener runs first once per tab, and reloading keeps that order. As a result, roughly half of new tabs duplicate, and those tabs always duplicate. Turn those options off; this handler already stops page scripts from seeing the ⌘-clicks it takes.

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

Learning is saved in each browser profile's local extension storage, bounded to 4,096 entries / 2 MiB of encoded record data. It survives background restarts and extension updates. Closing the last matching tab or completing unrelated navigation prunes it; restored data is checked against live tabs before matching. If the browser crashes or closes before a pruning write finishes, unused entries can remain on disk until the next startup checks open tabs. Sensitive URLs and private tabs are excluded before matching. The cache is not synced. Chromium restricts storage to trusted extension contexts; webpages cannot read it. The popup's Forget control waits for the saved copy to clear.

The same 16-request queue serves external and webpage opens. Cache writes are coalesced and skipped when learning is unchanged, outside the opening result. Disconnect recovery makes at most four attempts and then waits for activity; there is no permanent polling. Safari retries its first disconnect immediately; Chromium retains its update backoff. Safari requests interrupted before tab creation can resume on a new connection with the same request ID and original deadline. Creation requires a one-time authorization over the existing channel. Once authorized, a disconnected request is never replayed because a tab may already exist. Existing-tab focus needs no authorization round trip. There is no second opening path or automatic fallback that could duplicate an uncertain request. Independent tab/window reads run concurrently; last-focused-window lookup is used only as a fallback. Existing matches are still revalidated before activation. Rapid repeats cannot open a link twice. Requests run one at a time, and a tab created here keeps its requested URL as a stand-in until the browser reports an address. Safari lists a new tab without a URL until its navigation commits. The stand-in ends once an address appears or the tab closes.

Windows uses current-user-only named pipes. Chromium on macOS uses private Unix sockets and metadata under `/tmp/link-reuse-<uid>` (directory 0700, files/sockets 0600), verifies executable identity and process start time, and removes normal sessions on shutdown. Stale sessions are ignored/cleaned on access. Metadata contains process/browser identity and activity time, **no URLs or page content**. Each Chromium browser profile owns its native-messaging connection and helper process. Safari uses one authenticated WebSocket inside the same routing app, bound to an ephemeral port on 127.0.0.1. A single native startup handshake announces extension readiness without sending URL data; Apple messaging then supplies the connection address and a per-process authentication token. Version compatibility is checked before pending requests can be claimed. Only the authenticated channel decides native compatibility; a delayed bootstrap reply cannot invalidate a working connection. The engine and Safari connection share one version captured when the background starts, including when the connection is recreated; updated manifest metadata cannot make an old context identify itself as the new one. URLs and results then travel over that connection; they do not pass through per-open native-extension exchanges. Clients must authenticate before receiving requests. The app assigns and claims each request to one connection, with a 16-client limit, a five-second authentication timeout and a 1 MiB message limit. No app-group container or separate Safari helper is used. Explicit Safari profile selection is not available. Helpers block between events and exit when the browser connection closes. The routing app starts on demand; there is no login item, service, scheduled task or extra runtime.

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

macOS 26+, universal Intel/Apple Silicon application with one embedded Safari Web Extension and the Chromium native host. Download the macOS release, extract and place **Link Reuse.app** in `~/Applications` first, then register its native bridge:

```sh
~/Applications/'Link Reuse.app'/Contents/MacOS/LinkReuse --install
```

For Chromium browsers, load unpacked `~/Applications/Link Reuse.app/Contents/Resources/extension` in each browser profile, and open its popup to check the connection. The stable extension ID remains `dkkfdmgdgomngkkoaaolokhechagdlfl`. The release is ad-hoc signed, not Developer ID signed/notarized; macOS may require a manual first-open confirmation.

Updates use `python3 install.py`, or `python3 install.py --app /path/to/Link\ Reuse.app` for a downloaded bundle. The installer stops only its own processes, atomically replaces Contents, and registers the app once. Temporary rollback data is deleted when installation finishes; failure restores the prior app. No backups are retained. Reload/re-enable the bundled extension after updating. External reuse requires the extension; Browser Automation permission is unnecessary.

For Safari, open the installed app once, then enable **Link Reuse** in Safari Settings → Extensions and grant access to the websites where reuse is wanted. Local ad-hoc builds require Safari’s **Allow unsigned extensions** development setting, which resets after quitting Safari. Development signing is available with `python3 build.py --sign <identity>` when the signing key is accessible. A production distribution requires appropriate signing; this build is not notarized. `LinkReuse --safari-status` reports installation/enabled state without reading browser tabs.

Safari tab lookup uses only currently granted website patterns, so background matching does not request access to unrelated open sites. Without any website grants, reuse reports the required Safari setting immediately. Tabs on sites without access cannot be reused; grant All Websites access to cover arbitrary external links.

The routing app is declared background-only and activates Safari only when needed; it enables its own UI only to present an actual failure. It brings Safari forward through LaunchServices before handing over a link, because Safari's extension calls can stall while Safari is in the background. It stays running while a supported browser is open and reconnects as soon as the Safari extension (re)starts, so links after the first use the warm channel. Routers should deliver links without activating the routing app, as the OpenIn setup does. Once connected, requests and replies use the warm authenticated channel. Webpage reuse and learning remain available when the native app is absent. This is still a development preview; automated transport checks do not certify Safari’s live tab APIs.

Safari uses a generated Manifest V2 package with a resident background page because incoming native-port messages cannot reliably wake an unloaded MV3 page. The port listener is installed before asynchronous policy/session startup, with at most 16 early deliveries awaiting readiness. After authentication the app delivers unclaimed pending requests, covering connection startup. Each request has one connection owner at a time. Pre-creation disconnects release that ownership for safe redelivery; creation authorization prevents replay of uncertain tab creation. Timed-out requests are rejected before tab mutation. Chromium keeps Manifest V3; the engine and policy files remain shared. Safari’s resident context blocks between browser events and adds no polling. Native transport stage/error logs contain no URLs, tokens or page content.

Safari supplies document IDs from 18.4 onward. Where it lacks Chromium history/transition events, URL-update events and document/referrer checks feed the same observer. A page report can reconcile a missed URL rewrite only when its document ID matches the tracked document and the browser-reported sender tab URL matches the reported URL. This preserves the complete observed redirect without assuming that arbitrary hostnames, trailing slashes or query values are equivalent. Referrer-based redirect continuation is conservative: omitted or reduced referrers do not authorize inferred aliases.

OpenIn can remain your default router. Existing `linkreuse://open/<browser>?url=<encoded-original>` destinations and routing rules work for Safari and Chromium browsers. Any router that can send this ordinary app URL can use it; there is no runtime OpenIn dependency. Existing `openin-rewrite.js` and the separately invoked `configure_openin.py --apply` support the previously tested OpenIn schema. The setup script updates ordinary Safari and Chromium destinations in one SQLite transaction, preserving private/custom destinations and routing rules without saving backup files. Rebuilding/installing does not modify router rules. Links sent directly to Safari bypass the helper and cannot be checked before tab creation.

Build from source with Xcode command-line tools, Python and a current Node version:

```sh
python3 verify.py
python3 build.py
python3 install.py
```

`build.py` prepares both extension manifests from the same source and builds the containing app and Safari target with `LinkReuse.xcodeproj`; it does not maintain a separate Safari matching implementation.

Keeping a Chromium native-messaging connection open also keeps its extension background worker resident. The helper blocks on messages and sockets rather than polling; it consumes memory even when idle. This trades resident memory for avoiding helper startup on every external link. Idle battery impact has not been measured. Safari’s channel similarly waits for events without application heartbeat timers.

Python/Node are development tools only. The installed app and helper are the same native Swift binary; the installed Windows binary is .NET Native AOT. No Python, Node or .NET runtime is needed by end users.

## Verification and publishing

Keep exactly one registered copy of Link Reuse.app. Any LaunchServices change involving its Safari extension (another registered copy, an install, a re-registration) makes PlugInKit kill the extension, and Safari then reloads every extension, dropping in-flight links as "Operation timed out". Xcode registers every app it builds, so `build.py` writes products to `build/products.noindex` (Spotlight skips it) and unregisters them. For a few minutes after a bundle changes, macOS also re-registers it on every URL open through CoreServicesUIAgent (OpenIn and `/usr/bin/open` both go that way), which would restart the Safari extension on every link. `install.py` therefore dates the installed bundle folder an hour back before registering it.

`python3 verify.py` runs shared JavaScript checks plus native request/IPC/framing checks without opening user browsers. `python3 build.py` compiles and verifies a universal Mac app. GitHub's Windows job runs the same JavaScript suite, Native AOT compilation and Windows pipe/host-update checks. The macOS job runs verification and packages the universal app. These checks do not certify live browser focus, space/workspace visibility, webpage event ordering or Scoop installation on a target machine.

Windows releases are automatic. A push to `main` that changes `extension/` or `windows/` runs the Windows job; once its tests and native self-test pass, the job publishes `windows-v<Version>` with the packaged assets and commits the generated Scoop manifest, so `scoop update link-reuse` picks it up. `<Version>` in `windows/LinkReuse/LinkReuse.csproj` is the only Windows version. The job fails, instead of silently skipping, when those folders changed without a new `<Version>`, or when `extension/` changed without a new extension version (browsers reload the extension only when its version changes). An installed extension folder is an artifact, never the source checkout. Preserve unrelated work and line endings; do not force-push or commit work addresses, tokens, private URLs, caches or backups.
