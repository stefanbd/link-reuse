# Development

## Layout

| Path | Contents |
| --- | --- |
| `extension/` | The browser extension, shared by every browser. `build.py` derives the Safari manifest from `manifest.json`. |
| `macos/App/` | The Mac app: link routing, the Chromium native host and the Safari connection |
| `macos/SafariExtension/` | The Safari extension's native handler |
| `macos/build.py`, `macos/install.py` | Build the universal app; install it into `~/Applications` |
| `macos/browsers.json` | Browsers the Mac app can route to |
| `macos/openin/` | Optional OpenIn router setup |
| `windows/` | The Windows app (.NET Native AOT) and its packaging |
| `bucket/` | The Scoop manifest; scoop reads it from this path, and the release workflow writes it |
| `test/` | Every test: JavaScript (`*.test.mjs`), Swift (`*Tests.swift`), Python (`test_*.py`) and shared test vectors |
| `docs/` | How it works, and this page |

## Requirements

- macOS 26 with the Xcode command-line tools, Python 3 and Node.js 20 or later
- For the Windows app: the .NET 10 SDK, on Windows

## Tests

```sh
python3 test/run.py   # everything: JavaScript, Swift and Python
node --test           # JavaScript only
```

The tests never open browsers or touch installed apps.

## Building and installing on macOS

```sh
python3 macos/build.py --sign "Apple Development: Your Name (TEAMID)"
python3 macos/install.py
```

- Without `--sign`, the app is ad-hoc signed, and Safari then shows the extension only while **Allow unsigned
  extensions** is on.
- `install.py` swaps the app in atomically, restores the previous one on failure and keeps no backups. It also takes
  `--app <path>` to install a bundle you already have.
- `LinkReuse --safari-status` reports whether the Safari extension is installed and enabled.

Keep exactly one registered copy of the app. Any LaunchServices change to its Safari extension makes PlugInKit stop the
extension, and Safari then reloads every extension and drops links in flight ("Operation timed out"). Two things guard
against it:

- `build.py` builds into `build/products.noindex`, which Spotlight skips, and unregisters what Xcode registered.
- `install.py` dates the installed bundle an hour back. For a few minutes after a bundle changes, macOS re-registers it
  on every link opened through CoreServicesUIAgent (OpenIn and `/usr/bin/open`), which would restart the extension each
  time.

To check, run:

```sh
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -dump | grep '^path:.*Link Reuse'
```

It should list only `~/Applications`.

## Building on Windows

```powershell
dotnet publish windows/LinkReuse/LinkReuse.csproj -c Release -r win-x64 --self-contained true -p:PublishAot=true -p:StripSymbols=true -o build/windows-native
python windows/package.py build/windows-native/LinkReuse.exe
```

`package.py` writes the ZIP, its SHA-256 and the Scoop manifest.

## Versions and releases

There are two versions:

- `version` in `extension/manifest.json`, for the extension and the Mac app
- `<Version>` in `windows/LinkReuse/LinkReuse.csproj`, for the Windows app

Bump the extension version whenever `extension/` changes, because browsers reload an extension only when its version
changes. Bump the Windows version whenever anything Windows ships changes, which includes `extension/`.

Windows releases are automatic. A push to `main` that touches `extension/` or `windows/` runs the Windows workflow.
Once its tests and native self-test pass, it publishes `windows-v<Version>` and commits the new Scoop manifest, and
`scoop update link-reuse` picks it up. If shipped files changed without a version bump, the workflow fails rather than
skipping.

The macOS workflow runs the tests, builds the app and uploads it as a workflow artifact. macOS releases are not
published.

CI checks don't cover live browser behaviour, focus across spaces or a full Scoop install; test those by hand.
