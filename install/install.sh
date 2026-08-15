#!/bin/sh

set -eu

PACKAGE_NAME="topchester-ai"
VERSION="${TOPCHESTER_VERSION:-latest}"
INSTALL_DIR="${TOPCHESTER_INSTALL_DIR:-$HOME/.topchester/bin}"
REGISTRY_URL="${TOPCHESTER_REGISTRY_URL:-https://registry.npmjs.org}"
NO_MODIFY_PATH="${TOPCHESTER_NO_MODIFY_PATH:-false}"
BINARY_SOURCE=""
BIN_PATH=""
tmp_dir=""
staged_binary=""

usage() {
  cat <<'EOF'
Topchester Installer

Usage: install.sh [options]

Options:
  -h, --help               Show this help message.
  -v, --version VERSION    Install a published version instead of latest.
  -d, --install-dir DIR    Install into DIR instead of ~/.topchester/bin.
  -b, --binary PATH        Install a local standalone binary without downloading.
      --no-modify-path     Do not update a shell profile.

Environment:
  TOPCHESTER_VERSION          Published version to install.
  TOPCHESTER_INSTALL_DIR      Directory for the topchester command.
  TOPCHESTER_REGISTRY_URL     npm registry base URL.
  TOPCHESTER_NO_MODIFY_PATH   Set to 1, true, or yes to skip profile changes.
EOF
}

die() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

step() {
  printf '==> %s\n' "$1"
}

cleanup() {
  if [ -n "$staged_binary" ]; then
    rm -f "$staged_binary"
  fi
  if [ -n "$tmp_dir" ]; then
    rm -rf "$tmp_dir"
  fi
}

trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    -v | --version)
      [ "$#" -ge 2 ] || die "$1 requires a version."
      VERSION="$2"
      shift 2
      ;;
    -d | --install-dir)
      [ "$#" -ge 2 ] || die "$1 requires a directory."
      INSTALL_DIR="$2"
      shift 2
      ;;
    -b | --binary)
      [ "$#" -ge 2 ] || die "$1 requires a path."
      BINARY_SOURCE="$2"
      shift 2
      ;;
    --no-modify-path)
      NO_MODIFY_PATH=true
      shift
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[ -n "$INSTALL_DIR" ] || die "the install directory cannot be empty."
BIN_PATH="$INSTALL_DIR/topchester"
REGISTRY_URL=${REGISTRY_URL%/}

case "$NO_MODIFY_PATH" in
  1 | true | yes) NO_MODIFY_PATH=true ;;
  0 | false | no | '') NO_MODIFY_PATH=false ;;
  *) die "TOPCHESTER_NO_MODIFY_PATH must be true or false." ;;
esac

download_text() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -q -O - "$1"
    return
  fi
  die "curl or wget is required to install Topchester."
}

download_file() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
    return
  fi
  die "curl or wget is required to install Topchester."
}

json_string() {
  printf '%s\n' "$2" |
    sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1
}

validate_version() {
  if ! printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$'; then
    die "invalid Topchester version '$1'; expected x.y.z or x.y.z-suffix."
  fi
}

detect_target() {
  case "$(uname -s)" in
    Darwin) detected_os=darwin ;;
    Linux) detected_os=linux ;;
    *) die "Topchester supports Apple Silicon macOS and glibc Linux on ARM64 or x64." ;;
  esac

  case "$(uname -m)" in
    arm64 | aarch64) detected_arch=arm64 ;;
    x86_64 | amd64)
      detected_arch=x64
      if [ "$detected_os" = darwin ]; then
        sysctl_command=$(command -v sysctl 2>/dev/null || printf '/usr/sbin/sysctl')
        if [ "$("$sysctl_command" -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
          detected_arch=arm64
        fi
      fi
      ;;
    *) die "unsupported architecture: $(uname -m)." ;;
  esac

  if [ "$detected_os" = darwin ] && [ "$detected_arch" != arm64 ]; then
    die "Topchester's standalone release supports Apple Silicon macOS, not Intel macOS."
  fi

  if [ "$detected_os" = linux ]; then
    if [ -f /etc/alpine-release ]; then
      die "Topchester's standalone release requires glibc Linux; musl Linux is not supported."
    fi
    if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
      die "Topchester's standalone release requires glibc Linux; musl Linux is not supported."
    fi
  fi

  target="$detected_os-$detected_arch"
}

file_sha1() {
  if command -v sha1sum >/dev/null 2>&1; then
    sha1sum "$1" | awk '{print tolower($1)}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 1 "$1" | awk '{print tolower($1)}'
    return
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha1 "$1" | sed 's/^.*= //' | tr '[:upper:]' '[:lower:]'
    return
  fi
  die "sha1sum, shasum, or openssl is required to verify the download."
}

install_binary() {
  source_binary="$1"
  expected_version="$2"

  [ -f "$source_binary" ] || die "binary not found at $source_binary."
  mkdir -p "$INSTALL_DIR"
  staged_binary="$INSTALL_DIR/.topchester.$$"
  cp "$source_binary" "$staged_binary"
  chmod 755 "$staged_binary"

  staged_version=$("$staged_binary" --version </dev/null 2>/dev/null || true)
  [ -n "$staged_version" ] || die "the staged Topchester binary did not run successfully."
  if [ -n "$expected_version" ] && [ "$staged_version" != "$expected_version" ]; then
    die "the staged binary reported $staged_version; expected $expected_version."
  fi

  mv -f "$staged_binary" "$BIN_PATH"
  staged_binary=""
  installed_version="$staged_version"
}

configure_path() {
  if [ "$NO_MODIFY_PATH" = true ]; then
    path_action=skipped
    return
  fi

  case ":$PATH:" in
    *":$INSTALL_DIR:"*)
      path_action=already
      return
      ;;
  esac

  shell_name=$(basename "${SHELL:-sh}")
  case "$shell_name" in
    zsh)
      profile="${ZDOTDIR:-$HOME}/.zshrc"
      path_line="export PATH=\"$INSTALL_DIR:\$PATH\""
      ;;
    bash)
      profile="$HOME/.bashrc"
      path_line="export PATH=\"$INSTALL_DIR:\$PATH\""
      ;;
    fish)
      profile="$HOME/.config/fish/config.fish"
      path_line="fish_add_path \"$INSTALL_DIR\""
      ;;
    *)
      profile="$HOME/.profile"
      path_line="export PATH=\"$INSTALL_DIR:\$PATH\""
      ;;
  esac

  begin_marker="# >>> Topchester installer >>>"
  end_marker="# <<< Topchester installer <<<"
  mkdir -p "$(dirname "$profile")"

  if [ -f "$profile" ] && grep -F "$begin_marker" "$profile" >/dev/null 2>&1; then
    if grep -F "$path_line" "$profile" >/dev/null 2>&1; then
      path_action=configured
    else
      path_action=conflicting
    fi
    return
  fi

  {
    printf '\n%s\n' "$begin_marker"
    printf '%s\n' "$path_line"
    printf '%s\n' "$end_marker"
  } >>"$profile"
  path_action=added
}

if [ -n "$BINARY_SOURCE" ]; then
  step "Installing Topchester from $BINARY_SOURCE"
  install_binary "$BINARY_SOURCE" ""
else
  VERSION=${VERSION#v}
  if [ "$VERSION" = latest ]; then
    step "Resolving the latest Topchester version"
    latest_metadata=$(download_text "$REGISTRY_URL/$PACKAGE_NAME/latest")
    VERSION=$(json_string version "$latest_metadata")
    [ -n "$VERSION" ] || die "could not resolve the latest Topchester version."
  fi
  validate_version "$VERSION"
  detect_target

  if [ -x "$BIN_PATH" ] && [ "$("$BIN_PATH" --version 2>/dev/null || true)" = "$VERSION" ]; then
    step "Topchester $VERSION is already installed at $BIN_PATH"
    installed_version="$VERSION"
  else
    command -v tar >/dev/null 2>&1 || die "tar is required to install Topchester."
    platform_version="$VERSION-$target"
    step "Fetching Topchester $VERSION for $target"
    package_metadata=$(download_text "$REGISTRY_URL/$PACKAGE_NAME/$platform_version")
    metadata_version=$(json_string version "$package_metadata")
    tarball_url=$(json_string tarball "$package_metadata")
    expected_sha1=$(json_string shasum "$package_metadata" | tr '[:upper:]' '[:lower:]')

    [ "$metadata_version" = "$platform_version" ] || die "the registry returned version '$metadata_version'; expected '$platform_version'."
    [ -n "$tarball_url" ] || die "the registry response did not include a tarball URL."
    if ! printf '%s\n' "$expected_sha1" | grep -Eq '^[0-9a-f]{40}$'; then
      die "the registry response did not include a valid package checksum."
    fi

    tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/topchester-install.XXXXXX")
    archive="$tmp_dir/topchester.tgz"
    download_file "$tarball_url" "$archive"
    actual_sha1=$(file_sha1 "$archive")
    if [ "$actual_sha1" != "$expected_sha1" ]; then
      die "download checksum mismatch (expected $expected_sha1, got $actual_sha1)."
    fi

    tar -xzf "$archive" -C "$tmp_dir"
    install_binary "$tmp_dir/package/bin/topchester" "$VERSION"
  fi
fi

configure_path

printf '\nTopchester %s is installed at %s.\n' "$installed_version" "$BIN_PATH"
case "$path_action" in
  added)
    printf 'Restart your shell, then run: topchester --version\n'
    ;;
  conflicting)
    printf 'A different Topchester installer block already exists. Add this directory to the front of PATH:\n'
    printf '  %s\n' "$INSTALL_DIR"
    ;;
  skipped)
    case ":$PATH:" in
      *":$INSTALL_DIR:"*) ;;
      *)
        printf 'Add this directory to the front of PATH:\n'
        printf '  %s\n' "$INSTALL_DIR"
        ;;
    esac
    ;;
esac

visible_command=$(command -v topchester 2>/dev/null || true)
if [ -n "$visible_command" ] && [ "$visible_command" != "$BIN_PATH" ]; then
  printf 'Note: this shell still finds another Topchester first at %s. Restart the shell or remove that older npm/mise install.\n' "$visible_command"
fi

