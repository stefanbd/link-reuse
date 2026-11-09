# Link Reuse on Windows

For Windows 10 and 11 (x64) with Edge, Chrome or Brave. Link Reuse is one standalone executable: it needs no .NET
runtime, administrator rights, service, scheduled task or login entry.

## Install

In a normal (non-admin) PowerShell:

```powershell
scoop bucket add link-reuse https://github.com/stefanbd/link-reuse
scoop install link-reuse/link-reuse
link-reuse --setup
```

`--setup` opens a setup page in your browser. Then load the extension:

1. Open `edge://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
2. Choose **Load unpacked** and select `~\scoop\apps\link-reuse\current\extension`. Always use `current`, never a
   numbered version folder, so updates reach the browser.
3. Open the extension's popup and check that it shows connected.

Organization policies can block unpacked extensions or native messaging.

## Send links to it

- **As the default:** run `link-reuse --defaults`, then choose Link Reuse for HTTP and HTTPS in Windows Settings. Pages
  still open in your browser.
- **From a link router:** keep your router as the default and add `LinkReuse.exe` as a destination, with the URL as
  its argument. To pick a browser, pass `--browser edge "<url>"`, `--browser chrome "<url>"` or
  `--browser brave "<url>"`.

`link-reuse --install --browser edge` registers one browser explicitly; `link-reuse --status` shows what is set up.

## Try it

1. Open a page in your browser.
2. Run `link-reuse "<that page's address>"`, or open the same link from another app.
3. The existing tab is selected; no new tab opens.
4. Open an address you don't have open: exactly one new tab appears.

## Update

```powershell
scoop update link-reuse
```

The update restarts the native helper, and the extension reloads itself. Reload pages that were already open to give
them the new version.

## Remove

Choose your browser again in Windows Default Apps (or in your router) first, then:

```powershell
scoop uninstall link-reuse
```

This removes only what Link Reuse registered. Remove the extension on the browser's extensions page.

## What it installs

- Registrations under `HKCU` only, never for other applications
- The native helper, copied to `%LOCALAPPDATA%\Link Reuse\host\<version>` so Scoop can update while it runs
- Current-user named pipes, with connection metadata only: no URLs or page content

To build it or follow how releases happen, see [Development](../docs/development.md). For how matching works, see
[How it works](../docs/how-it-works.md).
