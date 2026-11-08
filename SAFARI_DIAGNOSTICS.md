# Safari transport investigation — 2026-11-08

Development-signed 3.2.25 is installed locally. Normal OpenIn Safari destinations use background delivery through Link Reuse; private destinations and routing rules were preserved. Published packages still precede this candidate. Safari remains a development preview, not an App Store or general reliability certification.

## Observed failure and correction

Correlated macOS logs showed application re-registration, extension records temporarily unavailable (-10814), Safari replacing its extension background context, and the WebSocket closing with goingAway (1001). This establishes an observed failure sequence, not a claim that every prior timeout had this cause. Watching the installed bundle found no filesystem changes during these opens; its signature remained valid.

The native protocol previously failed an assigned request when its connection disappeared, without distinguishing delivery from possible tab creation. It now releases pre-creation ownership and resumes the same request on a replacement authenticated connection under the original deadline. A one-time authorization is required immediately before creation. After that authorization, disconnect is treated as uncertain and never replayed. Existing-tab focus is idempotent and needs no extra authorization exchange. Tests cover wrong owners, late replies, expired deadlines, interrupted authorization and no replay after creation authorization. Live requests recovered actual context replacements without additional document loads.

Safari's first reconnect is immediate and subsequent attempts are bounded. A logical SDK-ready notification does not reset the retry budget before the real channel connects. Chromium keeps its existing updater backoff. Authentication, queue bounds, original request deadlines and final tab revalidation remain in force; no timeout was increased and no second routing fallback was added.

## Installation and activation

The installer preserves the installed app directory and atomically swaps Contents after making and checking a rollback ZIP. Staging apps are removed before recursive containing-app registration. Separate pluginkit registration was removed. Xcode automatically registers build bundles; the builder unregisters those copies when finished. Sixteen retired backup app directories were deleted with explicit user approval after file-by-file ZIP verification; all archive data was retained.

The routing app now declares LSBackgroundOnly. Runtime-only activation-policy changes did not hold across ordinary URL launches and were discarded. The installed bundle remained prohibited/inactive while Safari was active after normal opens and helper restart. Only actual error presentation temporarily enables app UI. Redundant browser activation is skipped. Ordinary activating command-line launches can still incur registration/context replacement overhead; background router delivery is the relevant production route.

## Measurements and limits

A real OpenIn HTTP-link run on this Mac completed nine measured reuses plus control-tab switches. End-to-end samples were 313–492 ms; bridge-to-completion samples were 134–270 ms. Selected-tab bridge median was 142 ms, different-tab 236 ms, and other-app 148 ms. The source URL redirected via HTTP 302. Each controlled document loaded exactly once, so these opens neither duplicated nor reloaded it.

A helper-restart request through OpenIn took 1,697 ms end to end, including 1,463 ms from bootstrap to completion. Safari itself was already running: this is not a fully cold browser benchmark. Redirect learning survived the helper restart. A subsequent nine-reuse run again kept one load per document; warm end-to-end samples were 362–603 ms, with bridge medians 173 / 231 / 161 ms for selected tab / different tab / other app. Cold-start latency remains material and is not claimed solved. These samples do not isolate all OpenIn time from macOS dispatch and cannot attribute a previous 1.7-second delay solely to OpenIn.

Earlier explicit background-delivery samples were faster: selected-tab bridge 7–9 ms / total 52–67 ms, tab-switch bridge 45–62 ms / total 96–116 ms, and bringing Safari forward roughly 180–195 ms total. These are observations, not guarantees. No-op channel requests took approximately 1–8 ms. Profiling showed most variable warm waiting inside Safari permission/tab/window API responses. A representative older route spent 299 ms inside JS: overlapped permission/window reads ended at 199 ms, tab query took 52 ms, and final tab validation 45 ms.

Retained speed changes overlap independent reads, skip last-focused-window lookup with at most one eligible window, and disable TCP delay. Permission caching and populated-window experiments did not demonstrate a consistent safe gain and were removed. Learning writes and badge behavior remain enabled. No fixture or API profiling wrapper is included in the installed app.

## Validation boundaries

The final source batch passed 125 JavaScript tests, five native Swift executable suites, and six Python packaging/installer checks. The bundle metadata assertion was rerun after the background-only declaration. A clean universal app was built, development-signed and installed. Automated coverage includes framing, authentication, bounds, disconnection, request ownership, creation authorization, installer rollback and shared matcher behavior.

Controlled live Safari tests verified focus, no additional document loads, redirect reuse and helper restart. They do not certify every site, Safari profile, permission combination, full-browser cold launch, Edge workspace or Windows installation. Windows native changes still require its CI job. Shared URL matching remains one source; no LinkedIn rule or separate Safari matcher was introduced.

Temporary diagnostic harnesses/logs live under /private/tmp, outside the repository. They suppress dialogs only in explicitly diagnostic app launches. Normal installed operation must run without that flag. Tests never edit Safari's live databases or close unrelated user tabs.
