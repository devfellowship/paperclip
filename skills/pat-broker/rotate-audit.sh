#!/usr/bin/env bash
# skills/pat-broker/rotate-audit.sh
#
# Enforce 1-week retention on the pat-broker audit log.
# Splits the JSONL log by date and deletes files older than
# PAT_BROKER_AUDIT_RETENTION_DAYS (default 7). Retention is measured against
# the DATE in each archive's filename, not the archive file's mtime, so
# re-running the rotation never resets the clock.
#
# Usage: bash skills/pat-broker/rotate-audit.sh
# Intended to be run daily via cron or a Paperclip routine.

set -uo pipefail

AUDIT_LOG="${PAT_BROKER_AUDIT_LOG:-/var/log/paperclip/pat-broker-audit.jsonl}"
RETENTION_DAYS="${PAT_BROKER_AUDIT_RETENTION_DAYS:-7}"

[[ -f "$AUDIT_LOG" ]] || { echo "rotate-audit: $AUDIT_LOG does not exist, nothing to do"; exit 0; }

log_dir="$(dirname "$AUDIT_LOG")"
log_base="$(basename "$AUDIT_LOG" .jsonl)"
archive_dir="$log_dir/archive"
mkdir -p "$archive_dir"

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
cp "$AUDIT_LOG" "$tmp"
: > "$AUDIT_LOG"

# Split current log by `ts` date prefix (YYYY-MM-DD). Malformed lines land in
# a catch-all archive so nothing is silently lost.
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  day=$(jq -r '.ts // ""' <<<"$line" 2>/dev/null | cut -c1-10)
  if [[ -z "$day" || "$day" == "null" ]]; then
    echo "$line" >> "$archive_dir/${log_base}.unparsed.jsonl"
  else
    echo "$line" >> "$archive_dir/${log_base}.${day}.jsonl"
  fi
done < "$tmp"

# Delete archives whose filename-date is older than retention.
cutoff_epoch=$(date -u -d "-${RETENTION_DAYS} days" +%s)
shopt -s nullglob
for f in "$archive_dir/${log_base}".*.jsonl; do
  fname=$(basename "$f")
  # Extract YYYY-MM-DD between "${log_base}." and ".jsonl"
  tail="${fname#${log_base}.}"
  day="${tail%.jsonl}"
  [[ "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
  day_epoch=$(date -u -d "$day" +%s 2>/dev/null) || continue
  if [[ $day_epoch -lt $cutoff_epoch ]]; then
    echo "rotate-audit: deleting expired archive $fname"
    rm -f "$f"
  fi
done
