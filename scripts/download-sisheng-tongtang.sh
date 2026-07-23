#!/bin/bash
set -euo pipefail

# ============================================================================
# 四世同堂 — Four Generations Under One Roof
# Author: 老舍 (Lao She, 1899-1966)
# Status: Public domain in mainland China (life+50, expired 2016)
#         local_external for this project — not redistributable in public CI
# ============================================================================
#
# Two variants per CORPUS-5 gate (no pooling):
#   four-generations-87  — 87-chapter original (1944-1949)
#   four-generations-103 — 103-chapter back-translation (separate work)
#
# Primary source (87-chapter):
#   Chinese Wikisource: https://zh.wikisource.org/wiki/四世同堂
#   Chapters 1-87 + prologue as subpages: 四世同堂/N
#
# Usage:
#   ./download-sisheng-tongtang.sh                           # instructions
#   ./download-sisheng-tongtang.sh 87                        # download 87-chapter from Wikisource
#   ./download-sisheng-tongtang.sh --url <url> <variant>     # download from custom URL
#   ./download-sisheng-tongtang.sh --file <path> <variant>   # copy local file
# ============================================================================

CORPUS_DIR="${CORPUS_DIR:-bench-data/corpus/four-generations}"
WIKISOURCE_BASE="https://zh.wikisource.org/w/index.php?title=%E5%9B%9B%E4%B8%96%E5%90%8C%E5%A0%82"

echo "=== 四世同堂 — Four Generations Under One Roof ==="
echo "Author: 老舍 (Lao She, 1899-1966)"
echo "Source: Chinese Wikisource (zh.wikisource.org)"
echo "Status: public domain in mainland China | local_external in CI"
echo ""

download_wikisource_87() {
  local VARIANT="four-generations-87"
  local DEST="$CORPUS_DIR/$VARIANT"
  mkdir -p "$DEST"
  local TMPDIR="$(mktemp -d)"
  trap "rm -rf $TMPDIR" EXIT

  echo "Downloading 87 chapters from Wikisource..."
  echo "  Prologue + Chapters 1-87"

  # Prologue
  curl -sS --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 30 \
    -H 'User-Agent: Mozilla/5.0' \
    "${WIKISOURCE_BASE}/%E5%BA%8F%E5%B9%95&action=raw" \
    -o "$TMPDIR/ch00.txt" 2>/dev/null || true

  # Chapters 1-87
  for i in $(seq 1 87); do
    printf "  Chapter %d/87\r" "$i"
    curl -sS --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 30 \
      -H 'User-Agent: Mozilla/5.0' \
      "${WIKISOURCE_BASE}/${i}&action=raw" \
      -o "$TMPDIR/ch$(printf '%02d' $i).txt"
    sleep 0.3
  done
  echo ""

  # Concatenate with chapter markers
  echo "Concatenating..."
  > "$DEST/source.txt"  # truncate
  for f in "$TMPDIR"/ch*.txt; do
    [ -s "$f" ] || continue
    local chname="$(basename "$f" .txt)"
    echo "第${chname#ch}章" >> "$DEST/source.txt"
    cat "$f" >> "$DEST/source.txt"
    echo "" >> "$DEST/source.txt"
  done

  local size=$(wc -c < "$DEST/source.txt")
  echo "Done: $DEST/source.txt ($size bytes)"
  echo "Next: create $DEST/source-manifest.json with ChapterLocation[]"
}

if [ $# -eq 0 ]; then
  echo "Usage:"
  echo "  $0 87                         # Download 87-chapter from Wikisource"
  echo "  $0 --url <url> <variant>      # Download from custom URL"
  echo "  $0 --file <path> <variant>    # Copy local file"
  echo ""
  echo "Variants: four-generations-87 | four-generations-103"
  echo ""
  echo "103-chapter back-translation:"
  echo "  The 103-chapter edition is a separate work variant."
  echo "  Source: English 'The Yellow Storm' → back-translated to Chinese."
  echo "  Provide via --url or --file."
  exit 0
fi

case "${1:-}" in
  87)
    download_wikisource_87
    ;;
  --url)
    TARGET="${2:?missing URL}"
    VARIANT="${3:-four-generations-87}"
    if [[ "$VARIANT" != "four-generations-87" && "$VARIANT" != "four-generations-103" ]]; then
      echo "ERROR: variant must be four-generations-87 or four-generations-103"
      exit 1
    fi
    DEST="$CORPUS_DIR/$VARIANT"
    mkdir -p "$DEST"
    echo "Downloading: $TARGET"
    curl -sL --connect-timeout 10 --max-time 300 "$TARGET" -o "$DEST/source.txt"
    echo "Saved: $DEST/source.txt ($(wc -c < "$DEST/source.txt") bytes)"
    ;;
  --file)
    TARGET="${2:?missing file path}"
    VARIANT="${3:-four-generations-87}"
    if [[ "$VARIANT" != "four-generations-87" && "$VARIANT" != "four-generations-103" ]]; then
      echo "ERROR: variant must be four-generations-87 or four-generations-103"
      exit 1
    fi
    DEST="$CORPUS_DIR/$VARIANT"
    mkdir -p "$DEST"
    echo "Copying: $TARGET"
    cp "$TARGET" "$DEST/source.txt"
    echo "Saved: $DEST/source.txt ($(wc -c < "$DEST/source.txt") bytes)"
    ;;
  *)
    echo "Unknown option: $1"
    echo "Run without arguments for usage."
    exit 1
    ;;
esac
