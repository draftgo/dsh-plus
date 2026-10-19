#!/usr/bin/env bash
set -euo pipefail
umask 077
source_name=${1:-mirror}
operation=${2:-connect}
case "$source_name" in mirror|github) ;; *) echo '无效下载源' >&2; exit 1;; esac
case "$operation" in connect|update) ;; *) echo '无效安装操作' >&2; exit 1;; esac
case "$(uname -s)" in Linux) ;; *) echo '服务器首版仅支持 Linux' >&2; exit 1;; esac
case "$(uname -m)" in x86_64) node_arch=x64;; aarch64|arm64) node_arch=arm64;; *) echo '仅支持 x64 和 arm64' >&2; exit 1;; esac
if [ ! -f /etc/os-release ]; then echo '无法识别服务器发行版' >&2; exit 1; fi
. /etc/os-release
case " ${ID:-} ${ID_LIKE:-} " in *' debian '*|*' ubuntu '*) ;; *) echo '首版仅支持 Ubuntu / Debian 系统' >&2; exit 1;; esac
command -v systemctl >/dev/null || { echo '需要 systemd 用户服务' >&2; exit 1; }
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}
systemctl --user show-environment >/dev/null 2>&1 || { echo 'systemd 用户服务不可用；请启用用户会话服务后重试' >&2; exit 1; }
node_root="$HOME/.local/share/dsh-plus/node"
node_binary=$(command -v node || true)
if [ -z "$node_binary" ] || ! "$node_binary" -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit(a>=24||(a===22&&(b>19||(b===19&&c>=0)))?0:1)' >/dev/null 2>&1; then
  node_version=22.22.1
  node_file="node-v$node_version-linux-$node_arch.tar.xz"
  command -v curl >/dev/null || { echo '安装 Node.js 需要 curl' >&2; exit 1; }
  command -v sha256sum >/dev/null || { echo '安装 Node.js 需要 sha256sum' >&2; exit 1; }
  work=$(mktemp -d)
  trap 'rm -rf -- "$work"' EXIT
  node_url="https://nodejs.org/dist/v$node_version"
  if [ "$source_name" = mirror ]; then node_url="https://npmmirror.com/mirrors/node/v$node_version"; fi
  echo '下载并校验 Node.js…' >&2
  curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 300 "$node_url/$node_file" -o "$work/$node_file"
  curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 15 --max-time 60 "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
  checksum=$(awk -v name="$node_file" '$2==name { print }' "$work/SHASUMS256.txt")
  [ -n "$checksum" ] || { echo '未找到 Node.js 官方校验值' >&2; exit 1; }
  (cd "$work" && echo "$checksum" | sha256sum --check --status)
  mkdir -p -- "$node_root"
  tar -xJf "$work/$node_file" -C "$node_root" --strip-components=1
  node_binary="$node_root/bin/node"
fi
export PATH="$(dirname "$node_binary"):$PATH"
exec "$node_binary" "$(dirname "$0")/bootstrap.mjs" "$source_name" "$operation"
