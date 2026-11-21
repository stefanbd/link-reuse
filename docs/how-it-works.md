# How it works

## Parts

| Part | Role |
| --- | --- |
| `extension/` | One extension for every browser. Its background decides which tab a link belongs to; its page scripts handle clicks and report canonical addresses. |
| `macos/` | The Mac app. Receives links from other apps, brings the browser forward and hands the link to the extension. It also contains the Safari extension. |
| `windows/` | The Windows app, with the same role for Edge, Chrome and Brave. |

The native apps never match tabs. All matching happens in the extension, so Windows, macOS and Safari behave the same.

## Matching

`extension/matching.mjs` gives every URL a set of match keys. Two URLs match when their sets share a key:

- the address itself
- the address without tracking parameters, with its query sorted (`noiseQueryKeys` and `noiseQueryPrefixes` in
  `extension/learning-policy.json`)
- an identity from a site rule (below)
- the keys of any address it has been learned to lead to (redirects and canonical links)

Generic matching never strips trailing slashes or fragments, since `/item` and `/item/`, or `#inbox` and `#sent`, can be
different pages. A request that matches nothing opens the original URL unchanged.

A link whose loading is itself an action always loads, and a tab showing one is never switched to: signing out or
starting a sign-in (`actionSegments`, in the path, query or fragment). Every other address can be reused, including a
sign-in form, a page about verification and a link carrying a token: matching compares addresses the browser already
has and keeps nothing. Learning and the fingerprints pages get are stricter (below).

### Site rules

`identityRules` in `extension/learning-policy.json` recognise a resource from its address:
`{name, host, path, identity, uppercase?, ignoreAnchor?, meaningfulQueryKeys?}`. `host` and `path` are regular
expressions matched against the whole host and path, and `identity` is a replacement template such as `$1`.

On a resource a rule recognises, query parameters are view state: a focused comment, a tab, tracking. A rule lists only
the parameters that choose a different resource; for Jira that is `selectedIssue`. With `ignoreAnchor` the anchor
is ignored too, except app routes (`#/`, `#!`). The defaults cover Jira issues (at `/browse/KEY` and
`/jira/browse/KEY`), Confluence pages and GitHub issues and pull requests. Identities include the rule name and origin,
so tenants and repositories stay apart.

Matching never guesses from an address's shape, such as a shared ID or one path ending another: the same ID under a
sandbox, a language or another tenant is a different page. Rules and learning are the only ways two different addresses
match.

Three formats need more than a regular expression and live in `extension/url-rules.js`:

- Google Maps place IDs
- Snowflake account landing pages, which can focus an open Snowsight tab for the same account
- Slack sign-in links, whose destination hint is used only to look up a tab; it is never trusted for sign-in or
  navigation

## Learning

`extension/observer.mjs` learns from what tabs actually do:

- **Redirects:** server redirects, plus automatic client-side redirects and address rewrites until the user interacts
  with the page.
- **Canonical addresses:** one `rel=canonical`, or `og:url` when there is none. Only same-origin declarations that pass
  conservative checks are accepted.

Learning is stored in the browser profile's local extension storage, up to 4,096 records and 2 MiB, so it survives
browser restarts and updates. A record is dropped once no tab in a normal window needs it, and a redirect from an address
is forgotten once a navigation seen starting there loads that address itself. A redirect or canonical link between
two selectors of one rule-identified resource (a Jira issue with and without `selectedIssue`) isn't learned, so learning
never joins what a rule keeps apart. Restored records are checked against open
tabs before use, once the browser lists a web page: a starting browser starts its extensions before it restores its
windows, and then restores them all at once, so a new tab page alone isn't the restored session. Sign-in and
authentication pages (`blockedPathSegments`, `blockedHostPrefixes`), addresses carrying tokens and private windows are
never learned: a redirect through a sign-in page is a passing state, not where an address leads. Nothing is synced.

Private browsing is invisible to Link Reuse: its page scripts do nothing in a private window, and the background ignores
private tabs' messages and navigation. Chromium never runs the extension there; Safari can, so there each tab is checked
before its events reach learning.

Safari reports a cross-site navigation that moves to another web process as failed before it commits, so the observer
keeps a failed navigation's start until the tab's next start or commit. Chromium reports a start before every commit,
so there the next start always replaces it.

## Opening a link

`routeToTab` in `extension/matching.mjs` handles links from other apps and from pages:

- Requests run one at a time, with up to 16 waiting.
- A tab opened moments ago counts by the URL it was opened with until the browser reports its address, so quick
  repeated clicks open one tab.
- A background click (⌘/Ctrl or middle-click) moves the match next to its source and leaves the source in front. In
  Chromium the move stays within the tab's group or between ungrouped tabs, since a moved tab joins its new
  neighbours' group; otherwise the match is selected instead. A pinned tab, or one already in place, stays where it is.
- Every other request selects the match where it is and focuses its window. Without a match it opens one tab next to
  its source, or in the most recently used visible window for links from other apps.
- Sleeping and discarded tabs are selected as they are; the browser wakes them.
- The match is checked against the live tab again right before acting.
- Safari lists only tabs on websites it lets the extension see. A link to a website outside that, with nothing found,
  is reported with how to allow the website, instead of opening a tab that may duplicate one it can't see.

## Clicks on pages

`extension/page-links.js` listens in the capture phase from the moment a page starts loading, before the page's own
scripts can act:

- **New-tab gestures** (⌘/Ctrl-click, middle-click, links that open a new tab) are cancelled and handed to the
  background.
- **Ordinary same-tab links** use match keys held by each top-level page: 53-bit fingerprints of the other tabs' keys,
  on every site (`extension/page-keys.mjs`). A page can check a link it has but can't read which pages are open. A page
  asks for its list whenever it is shown: when it loads in front, when its tab is selected or its window uncovered, and
  when it comes back from the back/forward cache. While it shows, the background sends it each new list. A hidden page
  gets nothing, so the browser can let it sleep. A restarted background sends every showing page its list once. The page
  decides at the click itself, before the page or its router sees it. Other links send no message and add no delay. A
  link to the page you're on stays there. The background confirms the match before switching, so a fingerprint collision
  or a tab that has gone just loads the link normally. If the switch fails after it began, the page shows a notice
  instead of also loading the link.
- Right-click menus, downloads, Shift- and Alt-clicks, synthetic clicks and plain clicks inside frames keep the
  browser's behaviour.

Chromium adds content scripts only to pages that load after an install or update, so the background adds them to the
tabs already open (`runtime.onInstalled`). The scripts the update orphaned there can no longer reach the extension and
leave each click to the new ones. Safari re-injects the scripts itself.

Another extension that stops click events first can hide them from Link Reuse while the browser still opens its own
tab. StopTheMadness Pro does this when *Protect ⌘-click* or *Protect all links* is on. *Stop link trackers* does it for
cross-site links that open in a new tab. Safari picks which extension's listener runs first once per tab, and keeps that
order across reloads.

## Native connections

| Browser | Connection |
| --- | --- |
| Chromium on macOS | A native messaging host (a copy of the app's binary) per browser profile, reached over private Unix sockets in `/tmp/link-reuse-<uid>` (directory 0700, files 0600). The app uses only hosts running the installed host file, checked by file identity and process start time. |
| Chromium on Windows | A native messaging host copied to `%LOCALAPPDATA%\Link Reuse\host\<app version>`, reached over current-user named pipes. Links go only to hosts running the copy the latest install registered, as on the Mac, so a link waiting while an update lands reaches the new host. |
| Safari | One WebSocket to the app on `127.0.0.1`, on a random port. The app announces it through Safari's extension messaging with a per-launch HMAC token, and the extension must authenticate before it receives any request. |

- Safari runs the extension with a resident Manifest V2 background page, because native messages cannot reliably wake
  a Manifest V3 one. Chromium uses Manifest V3. Both are built from the same source.
- The extension greets with its version and whether its profile has focus. The app always answers with the version it
  bundles; an extension of another version loads that one, and the app uses a connection only when the versions match.
- A link goes to the profile focused last. Connecting isn't focus: among profiles not focused since they connected, the
  one that connected first gets it.
- Each request belongs to one connection at a time. Before an app link changes anything (selects, focuses, moves or
  creates a tab), the extension asks the app for a one-time go-ahead over that connection. Until then the request may
  move to another connection; after it, a lost answer is reported, never replayed. A tab already selected in the
  focused window needs no change and no go-ahead.
- The Safari channel allows 16 clients and 1 MiB per message. When it is full, the oldest connection that hasn't
  authenticated makes room, so idle connections can't keep the extension out.
- The Mac app is background-only and starts on demand, with no login item or service. It stays running while a supported
  browser is open. Each browser has its own queue of up to 16 links, so a browser that is slow to connect holds up only
  its own links, and failures show as messages that hold nothing up. Safari's extension starts the app: when the
  extension starts, it opens the app's `linkreuse://started/safari` address, and the app sends the connection address
  to every Safari profile then. Safari takes over a second to pass on the first
  connection, so this way that wait is over before the first link. The app brings Safari forward before handing over a
  link, because Safari's extension calls stall while Safari is in the background.
- Connection metadata holds process identity and activity time only. Logs never contain URLs, tokens or page content.

## When something fails

There is never a second way to open the same request. An uncertain result shows an error instead of trying again, so
a failure can't produce a duplicate.

Nothing in Link Reuse waits on a timer. A link waits as long as the browser takes, and ends only with the extension's
answer or with an event that settles it: its connection ends, or the browser quits (which also ends the browser's links
still queued). An update moves the links that haven't had the go-ahead to the new version instead. For a Chromium browser that isn't connected, the app checks that the browser can
start its host and that the extension is installed and enabled there, so either missing is reported instead of waited
on. Safari takes about a second to answer that, so the app wakes the extension first and asks afterwards: the link is
already on its way. The app also brings the browser forward: a running browser's front window comes to the front, and
that focus connects the extension. Only a browser without a window is started, so a link never opens an extra window.

An update's new version takes over at once, and no link opens twice or goes missing on the way. Both installers stop
the old version only once the new one is in place. On the Mac the installer swaps the new app in, keeps the old one
aside until the new one is registered, and finds the processes still running the old one by the file they run, which
macOS reports from the file itself, so its path follows the swap. It sends them SIGUSR1; SIGTERM keeps its usual
meaning. From then on an old process gives no go-ahead: each link its extension hasn't had the go-ahead for goes back
untouched, and each one the extension may be acting on finishes where it is.

- **An old Chromium helper** stops being found (it removes its session and closes its socket), gives the links it holds
  back to the app (`withdrawn`), and once every link the app passed it has its answer, tells its extension it was
  replaced and exits. The extension connects to the new helper straight away, and the app passes the links there. On
  Windows the installer sets the event named after the helper's session instead.
- **The old Mac app** starts the new one itself, with one end of a private socket pair as its standard input and
  output. The connection exists before the new app runs and ends when either one does, so each learns every outcome
  from it, with no file or watcher. Once the link a browser may be acting on has finished, the old app hands over that
  browser's other links in order, one at a time, and tells the new app it is done with that browser. The new app
  answers each link once it has queued it, ahead of links that reached it directly, and opens a browser's links only
  once the old app is done with that browser. For Safari it then sends the extension its own address, which ends the
  old connection. A link the new app stopped while taking may have opened, so it is reported for you to check; one it
  never got is reported to open again. A link that reaches the old app during the hand-over joins it, and one that
  arrives after is reported to open again.

The extension connects to the new version straight away, however many updates come in a row. A connection that ends
any other way, or a helper that never connected, waits for the next tab switch, window focus or popup, so a helper that
keeps failing can't spin. Finding connections never stops a process.

### Known limits

- **Edge restoring its session.** A link that arrives while Edge is still starting can open a tab before Edge restores
  the previous session, which may bring back a tab for the same page. Edge starts extensions before it restores windows
  and gives no event for the restore being done.
- **A Chromium browser whose extension never connects** (for example, enabled only in a profile that isn't open) holds
  its links until it connects or quits. The extension's `!` badge shows the reason where the extension runs.
- **Safari not answering.** If Safari's extension is enabled but never connects, a Safari link waits until it does
  or Safari quits; an update moves it to the new version, where it waits again. Turning the extension off later isn't noticed while it waits.
