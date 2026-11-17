# 0.1.0-rc.1 candidate

This is the first public Windows candidate, not a declaration that every external
acceptance gate has passed. Packaging and local regressions are distinct from
live provider and third-party reader interoperability checks.

| Area | Verification / limit |
| --- | --- |
| Reading and independent tabs | Real PDF.js, page/zoom/selection/annotation/result isolation, close and Save/Discard/Cancel checks |
| File safety | Original PDF protection, atomic copy export, dirty edits retained after failed/cancelled writes |
| Native protocol | Loopback WinHTTP streaming/non-streaming, cancellation, timeout, credential dummy roundtrip |
| Formula output | Local KaTeX/Markdown fonts and code/math/source preservation; light/dark/narrow/100%/150% checks |
| Local state | Revision checks, corruption recovery, notes/cache separation and existing-state compatibility |
| Real APIs | Prior MiMo fixed streaming sentence/formula checks succeeded; current release checks use mocks/loopback, not repeated paid requests |
| Outstanding providers | DeepSeek has not been verified with a real key; non-streaming real PDF selections and complete key-management UI checks remain external acceptance items |
| Annotation interoperability | Independent pypdf/Poppler evidence exists; full Acrobat/Edge interoperability and all interactive annotation cases are not claimed |
| Distribution | Actual Unicode/space-path NSIS install, optional ShellExecute handler, offline app/editor export, and uninstall passed; defaults preserved. Unsigned candidate; clean-VM/missing-WebView2 branch remains unverified |

Do not remove these limits merely because CI passes. A formal stable release
requires completing the remaining external gates and recording the environment,
actions, observed results and exact artifact hashes. No unresolved data loss,
cross-document output or credential exposure issue is acceptable for release.

Detailed development logs, application state and machine-specific evidence remain
local and are not uploaded to the public repository. Public release notes report
the reproducible results and the remaining limits.
