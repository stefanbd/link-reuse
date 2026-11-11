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

### Site rules

`identityRules` in `extension/learning-policy.json` recognise a resource from its address:
`{name, host, path, identity, uppercase?, ignoreAnchor?, meaningfulQueryKeys?}`. `host` and `path` are regular
expressions matched against the whole host and path, and `identity` is a replacement template such as `$1`.

On a resource a rule recognises, query parameters are view state: a focused comment, a tab, tracking. A rule lists only
the parameters that choose a different resource; for Jira that is `selectedIssue`. With `ignoreAnchor` the anchor
is ignored too, except app routes (`#/`, `#!`). The defaults cover Jira issues, Confluence pages and GitHub issues
and pull requests. Identities include the rule name and origin, so tenants and repositories stay apart.

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

Learning is stored in the browser profile's local extension storage, up to 4,096 records and 2 MiB. A record is
dropped once no open tab needs it, and restored records are checked against open tabs before use. Sign-in and
authentication pages, addresses carrying tokens and private windows are never learned. Nothing is synced.

Safari reports a cross-site navigation that moves to another web process as failed before it commits, so the observer
keeps a navigation's start for 30 seconds.

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

## Clicks on pages

`extension/page-links.js` listens in the capture phase from the moment a page starts loading, before the page's own
scripts can act:

- **New-tab gestures** (⌘/Ctrl-click, middle-click, links that open a new tab) are cancelled and handed to the
  background.
- **Ordinary same-tab links** use match keys pushed to each top-level page: the keys of the other tabs on its own origin,
  never another site's (`extension/page-keys.mjs`). The background sends a page its list only when it changes. The
  page then decides at the click itself, before the page or its router sees it. Other links send no message and add no
  delay. If the matched tab has gone by the time the background acts, the link loads normally.
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
| Chromium on macOS | A native messaging host (a copy of the app's binary) per browser profile, reached over private Unix sockets in `/tmp/link-reuse-<uid>` (directory 0700, files 0600). The app checks the host's executable identity and process start time. |
| Chromium on Windows | A native messaging host copied to `%LOCALAPPDATA%\Link Reuse\host\<version>`, reached over current-user named pipes. |
| Safari | One WebSocket to the app on `127.0.0.1`, on a random port. The app announces it through Safari's extension messaging with a per-launch HMAC token, and the extension must authenticate before it receives any request. |

- Safari runs the extension with a resident Manifest V2 background page, because native messages cannot reliably wake
  a Manifest V3 one. Chromium uses Manifest V3. Both are built from the same source.
- Each request belongs to one connection at a time. Creating a tab needs a one-time authorization, so a request that
  was interrupted is never replayed once it may have created a tab. Expired requests are rejected before any tab
  changes.
- The Safari channel allows 16 clients, 5 seconds to authenticate and 1 MiB per message.
- The Mac app is background-only and starts on demand, with no login item or service. It brings Safari forward before
  handing over a link, because Safari's extension calls stall while Safari is in the background. It stays running while
  a supported browser is open.
- Connection metadata holds process identity and activity time only. Logs never contain URLs, tokens or page content.

## When something fails

There is never a second way to open the same request. An uncertain result shows an error instead of trying again, so
a failure can't produce a duplicate. A lost connection is retried at most four times, then waits for browser
activity; nothing polls.
