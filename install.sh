#!/bin/sh
# Links the pi extensions in this checkout into pi's extension directory and
# offers their settings. scripts/install.mjs does the work; this finds Node.
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)

# pi's own installer keeps the Node.js it installs off PATH; use that one when
# there is no other.
if ! command -v node >/dev/null 2>&1; then
	pi_node_bin=${XDG_DATA_HOME:-$HOME/.local/share}/pi-node/current/bin
	if [ ! -x "$pi_node_bin/node" ]; then
		echo "install.sh: Node.js is required, but node is not on PATH." >&2
		exit 1
	fi
	PATH=$pi_node_bin:$PATH
	export PATH
fi

exec node "$repo/scripts/install.mjs" "$@"
