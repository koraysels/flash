#!/usr/bin/env bash
# Pull Komodo stack logs over the REST API directly — bypasses the flaky
# `mcp-komodo` docker MCP (its per-session container handshake intermittently
# fails with JSON-RPC -32000).
#
# Credentials are read from the existing komodo MCP entry in ~/.claude.json,
# so nothing secret lives in this file.
#
# Usage:
#   scripts/komodo-logs.sh                       # list stacks + their ids
#   scripts/komodo-logs.sh <stack> [service] [tail] [grep]
#
#   <stack>    stack name or id            (default service: backend)
#   [service]  compose service to read     (default: backend)
#   [tail]     lines to fetch              (default: 300)
#   [grep]     extended-regex filter       (default: none — print all)
#
# Examples:
#   scripts/komodo-logs.sh flash backend 400 'track-debug'
#   scripts/komodo-logs.sh flash backend 200 'SPAWN|SUPPRESS'
set -euo pipefail

CONF="${HOME}/.claude.json"
[ -f "$CONF" ] || { echo "no $CONF" >&2; exit 1; }

read -r KURL KEY SEC < <(CONF="$CONF" node -e '
  const c = require(process.env.CONF);
  const a = c.mcpServers?.komodo?.args || [];
  const g = p => (a.find(x => x.startsWith(p)) || "").split("=").slice(1).join("=");
  process.stdout.write([g("KOMODO_URL="), g("KOMODO_API_KEY="), g("KOMODO_API_SECRET=")].join(" ") + "\n");
')
[ -n "$KURL" ] && [ -n "$KEY" ] && [ -n "$SEC" ] || { echo "komodo creds not found in $CONF" >&2; exit 1; }

auth=(-H "X-Api-Key: $KEY" -H "X-Api-Secret: $SEC" -H "Content-Type: application/json")

# No stack arg → list stacks and exit.
if [ $# -lt 1 ]; then
  echo "Stacks (name | id):"
  curl -s "${auth[@]}" -X POST "$KURL/read" -d '{"type":"ListStacks","params":{}}' \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d);console.log(a.map(s=>"  "+s.name+" | "+s.id).join("\n"))})'
  echo
  echo "usage: $0 <stack> [service=backend] [tail=300] [grep]"
  exit 0
fi

STACK="$1"; SERVICE="${2:-backend}"; TAIL="${3:-300}"; PATTERN="${4:-}"

curl -s "${auth[@]}" -X POST "$KURL/read" \
  -d "{\"type\":\"GetStackLog\",\"params\":{\"stack\":\"$STACK\",\"services\":[\"$SERVICE\"],\"tail\":$TAIL}}" \
  | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      let a; try { a=JSON.parse(d); } catch(e){ console.error("bad response:", d.slice(0,300)); process.exit(1); }
      const arr=Array.isArray(a)?a:[a];
      let log="";for(const x of arr) log+=(x.stdout||"")+"\n"+(x.stderr||"")+"\n";
      const pat=process.argv[1];
      let lines=log.split("\n").filter(Boolean);
      if(pat){ const re=new RegExp(pat); lines=lines.filter(l=>re.test(l)); }
      console.log(lines.join("\n"));
    });
  ' "$PATTERN"
