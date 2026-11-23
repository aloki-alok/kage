#!/bin/sh
case "$1" in
  *snapshot-zsh-*) shell=zsh ;;
  *snapshot-bash-*) shell=bash ;;
  *) shell=${SHELL:-sh} ;;
esac
keep=${KAGE_OUTPUT_CHARS:-3000}
dir="${TMPDIR:-/tmp}/kage-command-output"
mkdir -p "$dir" 2>/dev/null
full=$(mktemp "$dir/output.XXXXXX" 2>/dev/null) || exec "$shell" -c "$1"
status=$(mktemp "$dir/status.XXXXXX" 2>/dev/null) || { rm -f "$full"; exec "$shell" -c "$1"; }
find "$dir" -type f -mmin +2880 -delete 2>/dev/null
{ "$shell" -c "$1" 2>&1; echo $? > "$status"; } | tee "$full" | {
  head -c "$keep"
  if [ -n "$(dd bs=1 count=1 2>/dev/null)" ]; then
    printf '\n[More output follows. It is saved live to %s, and its end prints when the command finishes.]\n' "$full"
  fi
  cat > /dev/null
}
size=$(wc -c < "$full" | tr -d ' ')
if [ "$size" -le "$keep" ]; then
  rm -f "$full"
elif [ "$size" -le $((keep + keep)) ]; then
  tail -c +$((keep + 1)) "$full"
  rm -f "$full"
else
  printf '[%s characters cut from the middle. The full output is in %s]\n' $((size - keep - keep)) "$full"
  tail -c "$keep" "$full"
fi
code=$(cat "$status" 2>/dev/null)
rm -f "$status"
exit "${code:-1}"
