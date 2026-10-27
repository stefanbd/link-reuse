on snapshot()
    tell application "Arc"
        set activeURL to ""
        try
            if mode of front window is "normal" then set activeURL to URL of active tab of front window
        end try
        return {activeURL, URL of every tab of (every window whose mode is "normal"), URL of every tab of every space of (every window whose mode is "normal")}
    end tell
end snapshot

on focustab(expectedURL)
    tell application "Arc"
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
        repeat with wi from 1 to count of windows
            if mode of window wi is "normal" then
                set tabURLs to URL of every tab of window wi
                repeat with ti from 1 to count of tabURLs
                    considering case
                        if item ti of tabURLs is expectedURL then
                            select tab ti of window wi
                            activate
                            return true
                        end if
                    end considering
                end repeat
                repeat with si from 1 to count of spaces of window wi
                    set tabURLs to URL of every tab of space si of window wi
                    repeat with ti from 1 to count of tabURLs
                        considering case
                            if item ti of tabURLs is expectedURL then
                                select tab ti of space si of window wi
                                activate
                                return true
                            end if
                        end considering
                    end repeat
                end repeat
            end if
        end repeat
        return false
    end tell
end focustab
