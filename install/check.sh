#!/bin/sh

set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
installer="$root/install/install.sh"
check_root=$(mktemp -d "${TMPDIR:-/tmp}/topchester-installer-check.XXXXXX")

cleanup() {
  rm -rf "$check_root"
}

trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  printf 'Installer check failed: %s\n' "$1" >&2
  exit 1
}

make_fake_binary() {
  output="$1"
  version="$2"
  cat >"$output" <<EOF
#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' '$version'
  exit 0
fi
exit 1
EOF
  chmod 755 "$output"
}

sh -n "$installer"
sh "$installer" --help | grep -F "Topchester Installer" >/dev/null

if sh "$installer" --version definitely-not-a-version --no-modify-path >/dev/null 2>&1; then
  fail "an invalid version was accepted"
fi

home="$check_root/home"
install_dir="$home/.topchester/bin"
mkdir -p "$home"
make_fake_binary "$check_root/topchester-v1" "1.2.3"
make_fake_binary "$check_root/topchester-v2" "2.0.0"

HOME="$home" SHELL=/bin/zsh TOPCHESTER_INSTALL_DIR="$install_dir" \
  sh "$installer" --binary "$check_root/topchester-v1" --no-modify-path >/dev/null

[ -x "$install_dir/topchester" ] || fail "the local binary was not installed"
[ "$("$install_dir/topchester" --version)" = "1.2.3" ] || fail "the installed version was not runnable"
[ ! -e "$home/.zshrc" ] || fail "--no-modify-path changed the shell profile"

HOME="$home" SHELL=/bin/zsh TOPCHESTER_INSTALL_DIR="$install_dir" \
  sh "$installer" --binary "$check_root/topchester-v2" >/dev/null
HOME="$home" SHELL=/bin/zsh TOPCHESTER_INSTALL_DIR="$install_dir" \
  sh "$installer" --binary "$check_root/topchester-v2" >/dev/null

[ "$("$install_dir/topchester" --version)" = "2.0.0" ] || fail "the installed binary was not replaced"
[ "$(grep -c '^# >>> Topchester installer >>>$' "$home/.zshrc")" -eq 1 ] ||
  fail "the shell profile block was not idempotent"

cat >"$check_root/broken-topchester" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod 755 "$check_root/broken-topchester"

if HOME="$home" SHELL=/bin/zsh TOPCHESTER_INSTALL_DIR="$install_dir" \
  sh "$installer" --binary "$check_root/broken-topchester" --no-modify-path >/dev/null 2>&1; then
  fail "a broken binary was accepted"
fi
[ "$("$install_dir/topchester" --version)" = "2.0.0" ] || fail "a failed install replaced the working binary"

printf 'Topchester installer check passed.\n'

