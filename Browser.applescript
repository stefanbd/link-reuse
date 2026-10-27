on snapshot()
    tell application "Google Chrome"
        set activeURL to ""
        try
            if mode of front window is "normal" then set activeURL to URL of active tab of front window
        end try
        return {activeURL, URL of every tab of (every window whose mode is "normal")}
    end tell
end snapshot

on focustab(expectedURL)
    tell application "Google Chrome"
        try
            if mode of front window is "normal" then
                considering case
                    if URL of active tab of front window is expectedURL then
                        activate
                        return true
                    end if
                end considering
            end if
        end try
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
