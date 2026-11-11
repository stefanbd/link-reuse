# Link Reuse

Link Reuse stops duplicate tabs. When a link would open a page you already have open, it switches to that tab instead.
It works for links you open from other apps (Slack, mail, a link router) and for links you click on web pages.

## What happens when you open a link

| You | Link Reuse |
| --- | --- |
| Open a link from another app | Selects the tab already showing it, or opens one new tab |
| ⌘-click (Ctrl-click on Windows) or middle-click a link | Moves the matching tab next to your current one without leaving your page, or opens a background tab as usual |
| Click a link that opens a new tab, or ⇧⌘-click | Selects the matching tab, or opens a new one |
| Click an ordinary link to a page another tab shows | Selects that tab and leaves your page where it is |

Anything else stays with the browser: the right-click menu, bookmarks, the address bar, downloads and links inside
frames.

Two links count as the same page when:

- their addresses match once tracking parameters (`utm_*`, `fbclid`, …) are removed
- they are the same Jira issue, Confluence page or GitHub issue or pull request, whatever comment, tab or view the
  link points at
- one has been seen redirecting to the other, or the page declares the other as its canonical address

## Supported browsers

| | Browsers |
| --- | --- |
| Windows | Edge, Chrome, Brave |
| macOS | Arc, Chrome, Brave, Edge, Edge Beta; Safari as a development preview |

Firefox is not supported. Load the extension in every browser profile you use.

## Install

### Windows

```powershell
scoop bucket add link-reuse https://github.com/stefanbd/link-reuse
scoop install link-reuse/link-reuse
link-reuse --setup
```

[windows/README.md](windows/README.md) covers loading the extension, sending links to it, updating and removal.

### macOS (26 or later)

Build and install from source. You need the Xcode command-line tools, Python 3 and Node.js:

```sh
python3 macos/build.py --sign "Apple Development: Your Name (TEAMID)"   # or no --sign for an ad-hoc build
python3 macos/install.py
```

- **Chrome, Edge, Brave, Arc:** load the unpacked extension from
  `~/Applications/Link Reuse.app/Contents/Resources/extension`, then open its popup to check the connection.
- **Safari:** open the app once, enable **Link Reuse** in Safari Settings → Extensions, and allow it on All Websites.
  Ad-hoc builds also need Safari's **Allow unsigned extensions** developer setting, which resets when Safari quits.

## Sending links from other apps

Make Link Reuse handle links, or keep your link router and add a destination for it:

- **macOS:** routers open `linkreuse://open/<browser>?url=<encoded-url>`. For OpenIn,
  `python3 macos/openin/configure.py --apply` points its browser destinations there.
- **Windows:** run `link-reuse --defaults` and choose Link Reuse for HTTP and HTTPS, or add `LinkReuse.exe` to your
  router with the URL as its argument.

## Updating

- **macOS:** pull, then run `python3 macos/build.py` and `python3 macos/install.py` again.
- **Windows:** `scoop update link-reuse`.

The extension reloads itself and updates the pages that are already open, so nothing needs reloading.

## Limits

- The first time a link redirects somewhere new, it opens once. After that the redirect is known.
- Switching to an open tab doesn't scroll it to a comment or section the link points at.
- Learning stays in the browser profile. Sign-in pages and addresses carrying tokens are never learned, and private
  windows are ignored.
- **StopTheMadness Pro** hides ⌘-clicks from Link Reuse in about half of Safari tabs when its *Protect ⌘-click* or
  *Protect all links* option is on. Turn those options off.

## More

- [How it works](docs/how-it-works.md): matching, learning, click handling and the native connections
- [Development](docs/development.md): repository layout, tests, builds and releases
