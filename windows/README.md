# Link Reuse on Windows — first-install preview

Windows 10/11 x64, starting with Microsoft Edge. Chrome and Brave use the same extension and native protocol. This preview has focused logic/build checks; real browser focus and installation still need the first Windows trial.

## Install with Scoop

After the Windows release and bucket manifest are published:

```powershell
scoop bucket add link-reuse https://github.com/stefanbd/link-reuse
scoop install link-reuse/link-reuse
link-reuse --setup
```

Use a normal, non-admin PowerShell. The app is compiled to a standalone native executable; no .NET runtime, Python, AutoHotkey or Raycast installation is needed. There is no Start menu shortcut, Windows service, scheduled task or login entry.

`--setup` opens the bundled setup page in the selected browser. In Edge, open `edge://extensions`, enable Developer mode, choose **Load unpacked**, and select the installed `extension` folder. It is normally `~\scoop\apps\link-reuse\current\extension`. Open the extension popup to confirm the bridge is connected. Organization policies can block unpacked extensions or user-level native messaging even without an administrator requirement.

Then choose how links reach the app:

- **Direct:** run `link-reuse --defaults`, then choose Link Reuse for HTTP and HTTPS in Windows Settings. This changes the default browser/link-handler setting. Browsing still happens in Edge.
- **Existing router:** keep the router as default. Add the installed `LinkReuse.exe` as a custom destination and pass the URL as one argument. For a specific browser, use arguments equivalent to `--browser edge "<url>"`, `--browser chrome "<url>"` or `--browser brave "<url>"`. Use the router's own URL placeholder syntax. No router-specific integration is included.

App registrations and native messaging manifests are written only under HKCU and `%LOCALAPPDATA%\Link Reuse`. Existing registrations for other applications are not edited. Windows retains control of default-app consent.

## First try

1. Open a normal Edge tab at a non-sensitive web page.
2. Open that exact URL from another app, or run `link-reuse "https://the-page-you-opened"` in PowerShell.
3. Confirm Edge selects the existing tab, without changing its page or creating another tab.
4. Try an unopened URL and confirm exactly one new tab appears.

Choose Edge explicitly if needed:

```powershell
link-reuse --install --browser edge
link-reuse --status
```

If the extension is disconnected, the opener reports the setup problem instead of opening a speculative duplicate. A request that times out is never automatically retried through a second opening path; check whether it completed before trying again.

## Ownership and lifetime

- The app receives normal HTTP/HTTPS URLs and forwards requests over current-user-only named pipes.
- The browser launches a copy of the same executable from `%LOCALAPPDATA%\Link Reuse\host\<extension-version>`. Keeping the long-running host outside Scoop's package directory lets Scoop update normally. New copies are staged before replacing the registration; superseded copies are removed after their hosts stop. The host blocks between requests and exits when the browser closes the connection.
- The extension owns Windows learning and tab selection. It serializes incoming opens, queries live normal tabs, activates a match without navigating it, or creates one tab. The most recently focused connected profile is preferred; explicit profile routing is not yet supported.
- New tabs prefer the most recently used non-minimized normal window visible to the extension. If all are minimized, the most recently used one is restored. Existing matching tabs are reused even in minimized windows. Window recency is kept in memory and starts fresh when the extension reloads; Edge's last-focused window is used when eligible. Workspace windows must be exposed by Edge's normal window and tab APIs; workspace names are not inferred.
- Exact URLs, Google Maps place identity, observed redirects and conservative same-origin canonicals use the existing learning policy. Sensitive URLs bypass learning and direct reuse. Private windows are excluded.
- Slack's documented `https://slack.com/openid/connect/login_initiate_redirect` link format has one narrow exception: the extension reads the original destination from the `login_hint` payload for tab lookup, including the clean Snowflake account landing links below. It does not authenticate the token, retain the extracted payload, learn the sign-in URL as an alias, or fetch the redirect. If no tab matches, it opens the original sign-in URL unchanged. Other OpenID/sign-in links remain excluded. See [Slack's link format](https://docs.slack.dev/authentication/sign-in-with-slack/setting-up-sign-in-with-slack-links/).
- A clean Snowflake account landing link, including a Classic Console `/console/login#/` link, can focus an existing Snowsight view for the same organization/account. Specific worksheet URLs keep normal resource matching. If Link Reuse opens a sign-in flow, it retains only the account identity and created tab ID, under the same storage budget, so repeated landing-link clicks can focus that tab during Snowflake login/OAuth or the recognized Slack handoff. Closing it, changing accounts or leaving those recognized hosts removes that association. Unrelated pre-existing OAuth flows are not inferred to be the account page; direct OAuth requests still open unchanged. External identity-provider pages are outside this association. Account URL formats follow [Snowflake's account identifiers](https://docs.snowflake.com/en/user-guide/admin-account-identifier) and [Snowsight account URLs](https://docs.snowflake.com/en/release-notes/2023-05).
- Learned relations stay in extension memory, bounded to 4,096 entries / 2 MiB of encoded record data. Closing the last matching tab or completing an unrelated navigation removes them. Browser/extension restarts forget them. Unknown redirects require a first visit.
- Only connection metadata (process identity and random pipe name) is written to the Windows sessions directory. No page bodies or learned URLs are written there; no network service or browser debugging port is used.

## Updates and removal

```powershell
scoop update
scoop update link-reuse
```

From Windows 0.1.2 / extension 3.1.2 onward, updates keep the HTTP/HTTPS registration, replace and restart the native host, and reload the extension automatically when its bundled version changes. Reconnection makes at most four timed attempts after a disconnect, then waits for browser activity or a popup request. There is no permanent polling or extra updater process. The ordinary link-opening path is unchanged.

The extension must be loaded from Scoop's stable `current\extension` folder. Before an automatic reload it checks the version in that folder; a stale copy reports an error instead of repeatedly reloading. The ordinary Scoop `current` junction is required for this setup.

**One-time transition from 0.1.0 or 0.1.1:** turn off Link Reuse in the browser, run `Stop-Process -Name LinkReuse -Force -ErrorAction SilentlyContinue`, update through Scoop, then turn it back on and check version 3.1.2. Those older releases cannot perform the new restart/reload protocol.

Before uninstalling, select your real browser in Windows Default Apps or restore the destination in your router:

```powershell
scoop uninstall link-reuse
```

Uninstall removes only registrations owned by this installation and stops its extension-host processes. The browser extension can then be removed in the browser's Extensions page.

## Build

The GitHub Windows job does one native compilation, focused JavaScript routing/reconnection checks, and native request/framing/current-user-pipe checks. A small Windows file-lock check stages a replacement host outside the package while the preceding host file remains locked, then verifies a same-version reinstall. It does not launch or install browsers; a full Scoop update with a connected browser still needs a Windows trial.

```powershell
dotnet publish windows/LinkReuse/LinkReuse.csproj -c Release -r win-x64 --self-contained true -p:PublishAot=true -p:StripSymbols=true -o build/windows-native
python windows/package.py build/windows-native/LinkReuse.exe
```

The package script emits a ZIP, SHA-256 checksum and a Scoop manifest with current-user registration/unregistration hooks. A Mac can cross-compile a larger self-contained build with `PublishSingleFile=true` in place of `PublishAot=true`, but Windows Native AOT publishing runs on Windows.

Windows containers cannot provide the interactive desktop/browser check. For this preview, use the real Windows installation rather than setting up a Windows VM solely for testing.
