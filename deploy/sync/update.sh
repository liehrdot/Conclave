#!/usr/bin/env bash
# Neue Images holen und nur dann neu starten, wenn sich eines geändert hat – stündlich per systemd-Timer oder
# jederzeit von Hand. Was passiert ist, steht im Journal: journalctl -u mtgdeck-sync-update.service
set -euo pipefail
cd "$(dirname "$0")"
# Neu starten, wenn ein Container nicht auf dem Image läuft, das sein Tag nach dem Pull meint. Nicht `docker compose
# images` vergleichen: das zeigt das Image der laufenden Container und ändert sich durch einen Pull nie.
running() { docker compose ps -aq | xargs -r docker inspect --format '{{.Image}}' | sort -u; }
wanted() { docker compose config --images | xargs -r docker image inspect --format '{{.Id}}' | sort -u; }
docker compose pull --quiet
if [ "$(running)" != "$(wanted)" ] || [ "${1:-}" = "--force" ]; then
  docker compose up -d --remove-orphans
  docker image prune -f >/dev/null
  echo "Update eingespielt: $(docker compose ps --format '{{.Service}} {{.Image}}' | tr '\n' ' ')"
else
  echo "Kein Update: alle Images aktuell."
fi
