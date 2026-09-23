#!/bin/bash
# deb after-remove (runs as root): clean up what linux-after-install.sh put
# on the system, so an uninstall leaves no stale permission file behind.

PROFILE="/etc/apparmor.d/recordly"

if [ -f "$PROFILE" ]; then
	command -v apparmor_parser >/dev/null 2>&1 && apparmor_parser -R "$PROFILE" || true
	rm -f "$PROFILE"
fi

exit 0
