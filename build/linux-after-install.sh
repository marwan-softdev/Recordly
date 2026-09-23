#!/bin/bash
# deb after-install (runs as root on the user's machine).
#
# Ubuntu 23.10+ restricts unprivileged user namespaces (AppArmor), which
# kills Chromium's sandbox inside Electron apps launched from unpackaged
# paths — AppImages crash with SIGTRAP seconds after launch (see
# LINUX-CURSOR-WORKLOG.md "Ubuntu AppArmor userns restriction"). This deb
# installs Recordly at a fixed path, so we can grant it permission the way
# Ubuntu does for Chrome:
#   1. an AppArmor profile allowing userns for /opt/Recordly/recordly
#   2. the setuid bit on Electron's chrome-sandbox helper as a fallback
#      for systems where AppArmor is absent but userns still restricted

APP_PATH="/opt/Recordly/recordly"
SANDBOX_HELPER="/opt/Recordly/chrome-sandbox"
PROFILE="/etc/apparmor.d/recordly"

if [ -d /etc/apparmor.d ] && command -v apparmor_parser >/dev/null 2>&1; then
	cat > "$PROFILE" <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile recordly /opt/Recordly/recordly flags=(unconfined) {
  userns,
  include if exists <local/recordly>
}
PROFILE
	apparmor_parser -r "$PROFILE" || true
fi

if [ -f "$SANDBOX_HELPER" ]; then
	chmod 4755 "$SANDBOX_HELPER" || true
fi

# The AppImage target updates itself via electron-updater; nothing to do here.
exit 0
