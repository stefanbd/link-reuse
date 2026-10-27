on snapshot()
    tell application "Google Chrome"
        set activeURL to ""
        if (count of windows) > 0 then
            if mode of front window is "normal" and (count of tabs of front window) > 0 then set activeURL to URL of active tab of front window
        end if
        return {activeURL, URL of every tab of (every window whose mode is "normal")}
    end tell
end snapshot

on focustab(expectedURL)
    tell application "Google Chrome"
        if (count of windows) > 0 then
            if mode of front window is "normal" and (count of tabs of front window) > 0 then
                considering case
                    if URL of active tab of front window is expectedURL then
                        activate
                        return true
                    end if
                end considering
            end if
        end if
        repeat with browserWindow in (get every window whose mode is "normal")
            set tabURLs to URL of every tab of browserWindow
            repeat with tabIndex from 1 to count of tabURLs
                considering case
                    if item tabIndex of tabURLs is expectedURL then
                        if URL of tab tabIndex of browserWindow is not expectedURL then return false
                        set active tab index of browserWindow to tabIndex
                        set minimized of browserWindow to false
                        set index of browserWindow to 1
                        activate
                        return true
                    end if
                end considering
            end repeat
        end repeat
        return false
    end tell
end focustab
