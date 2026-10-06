#!/usr/bin/env bash
# Builds the GitHub Pages site into _site/ (run from anywhere: bash site/build.sh).
# Copies site/ (incl. the guide pages in site/<slug>/), adds the README screenshots and demo GIF,
# renders og.png and apple-touch-icon.png with headless Chrome, and writes llms-full.txt from the
# repo's Markdown docs plus the text of the guide pages.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/_site}"
rm -rf "$out"
mkdir -p "$out/img"
out="$(cd "$out" && pwd)" # absolute, for file:// URLs
cp -r "$root/site/." "$out/"
rm -f "$out/build.sh" "$out/.htmlvalidate.json"
cp "$root/docs/live.png" "$root/docs/commit-view.png" "$root/docs/demo.gif" \
  "$root/docs/demo.mp4" "$root/docs/demo-poster.webp" "$out/img/"

chrome="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser || true)"
if [ -z "$chrome" ]; then
  echo "build.sh: Chrome/Chromium is needed to render og.png" >&2
  exit 1
fi
shot() { # <url> <png> <width> <height>
  "$chrome" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --allow-file-access-from-files --window-size="$3,$4" --screenshot="$2" "$1" >/dev/null 2>&1
}
shot "file://$out/og-image.html" "$out/og.png" 1200 630
printf '<!doctype html><html><body style="margin:0"><img src="favicon.svg" width="180" height="180" alt=""></body></html>' >"$out/icon.html"
shot "file://$out/icon.html" "$out/apple-touch-icon.png" 180 180
rm -f "$out/og-image.html" "$out/icon.html"
for f in og.png apple-touch-icon.png; do
  [ -s "$out/$f" ] || { echo "build.sh: failed to render $f" >&2; exit 1; }
done

{
  echo "# grok-coding-observatory: full documentation"
  echo
  echo "> Source: https://github.com/Eeliya/grok-coding-observatory (branch main). Generated from the repo's Markdown files."
  for f in README.md docs/AGENT-PROTOCOL.md docs/API.md CONTRIBUTING.md; do
    [ -f "$root/$f" ] || continue
    printf '\n\n---\n\n<!-- %s -->\n\n' "$f"
    cat "$root/$f"
  done
  for f in "$root"/site/*/index.html; do
    slug="$(basename "$(dirname "$f")")"
    printf '\n\n---\n\n<!-- https://observatory.eeliyarasta.com/%s/ -->\n\n' "$slug"
    python3 - "$f" <<'PY'
import html, re, sys
page = open(sys.argv[1], encoding='utf-8').read()
main = page[page.index('<main'):page.index('</main>')]
main = re.sub(r'<pre[^>]*>(.*?)</pre>', lambda m: '\n```\n' + re.sub(r'<[^>]+>', '', m.group(1)) + '\n```\n', main, flags=re.S)
main = re.sub(r'<h1[^>]*>', '\n# ', main)
main = re.sub(r'<h2[^>]*>', '\n\n## ', main)
main = re.sub(r'<h3[^>]*>', '\n\n### ', main)
main = re.sub(r'<li[^>]*>', '\n- ', main)
main = re.sub(r'</(p|figcaption)>', '\n', main)
text = html.unescape(re.sub(r'<[^>]+>', '', main))
out, code = [], False
for line in text.split('\n'):
    if line.strip() == '```':
        code = not code
    if not code:
        line = re.sub(r'[ \t]+', ' ', line).strip()
        if line == '-':
            continue
    out.append(line)
print(re.sub(r'\n{3,}', '\n\n', '\n'.join(out)).strip())
PY
  done
} >"$out/llms-full.txt"

echo "Built $out"
