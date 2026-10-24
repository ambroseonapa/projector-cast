#!/bin/bash
# Runs a command under a window manager (if one is installed) so window capture can list windows.
command -v openbox >/dev/null && { openbox >/dev/null 2>&1 & WM=$!; sleep 1; }
"$@"; code=$?
[ -n "$WM" ] && kill $WM
exit $code
