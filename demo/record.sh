#!/usr/bin/env bash
# Records docs/demo.gif from simulated data. Requires vhs, ttyd and ffmpeg.
# VHS 0.12 cannot encode a GIF with ffmpeg 9. The script keeps the VHS frames and encodes them here.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf demo/frames
vhs demo/demo.tape >/dev/null
mkdir -p docs
ffmpeg -v error -y \
  -framerate 50 -i demo/frames/frame-text-%05d.png \
  -framerate 50 -i demo/frames/frame-cursor-%05d.png \
  -filter_complex "[0][1]overlay,pad=iw+48:ih+48:24:24:color=0x1e1e2e,fps=12,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  docs/demo.gif
rm -rf demo/frames
ls -lh docs/demo.gif
