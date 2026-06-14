#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: reset-jetson-over-ssh.sh jetson@HOST [options]

Run the Rust harness good-state reset on a Jetson over SSH.

The Jetson must already have this repo checked out. If SSH rejects the laptop's
key, install the key first or run reset-good-state.sh directly on the Jetson.

Options:
  --repo-dir PATH               Repo path on Jetson. Default: ~/onchain-rover.
  --role guard|courier          Robot role. Default: guard.
  --sidecar-url URL             Sidecar URL. Default: http://192.168.0.100:4021.
  --profile wifi|usbnet         Profile label. Default: wifi.
  --drive-invert                Pass through to reset-good-state.sh.
  --drive-swap                  Pass through to reset-good-state.sh.
  --disable-lidar               Pass through to reset-good-state.sh.
  --no-camera-device            Pass through to reset-good-state.sh.
  --extra 'ARGS...'             Extra quoted args for reset-good-state.sh.
  -h, --help                    Show this help.
EOF
}

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 2
fi

target=""
repo_dir="~/onchain-rover"
role="guard"
sidecar_url="http://192.168.0.100:4021"
profile="wifi"
pass_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --repo-dir)
      repo_dir="${2:?--repo-dir requires a path}"
      shift 2
      ;;
    --role)
      role="${2:?--role requires guard or courier}"
      shift 2
      ;;
    --sidecar-url)
      sidecar_url="${2:?--sidecar-url requires a URL}"
      shift 2
      ;;
    --profile)
      profile="${2:?--profile requires wifi or usbnet}"
      shift 2
      ;;
    --drive-invert|--drive-swap|--disable-lidar|--no-camera-device)
      pass_args+=("$1")
      shift
      ;;
    --extra)
      pass_args+=("${2:?--extra requires a quoted arg string}")
      shift 2
      ;;
    --*)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$target" ]]; then
        echo "only one SSH target is allowed" >&2
        exit 2
      fi
      target="$1"
      shift
      ;;
  esac
done

if [[ -z "$target" ]]; then
  echo "missing SSH target, for example jetson@172.16.2.151" >&2
  usage >&2
  exit 2
fi

printf -v remote_cmd \
  'export PATH="$HOME/.cargo/bin:$PATH"; cd %q && ./robot-harness/deploy/reset-good-state.sh --role %q --sidecar-url %q --profile %q %s' \
  "$repo_dir" "$role" "$sidecar_url" "$profile" "${pass_args[*]-}"

ssh -o BatchMode=yes -o ConnectTimeout=5 "$target" "$remote_cmd"
