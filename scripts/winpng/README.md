# Blog playback previews

`cli.cjs` reads a bounded JSON request from stdin and returns embedded playable
files. Original PNG pixels are decoded with sharp; `decode.cjs` ports the seven
WinPNG transforms and recursive "twice" containers from
`anime-db-download/scripts/winpng_decode.py`. The independent Python pixel and
PNG fixtures cover every transform, UTF-8 paths and nested containers.

JMK is never executed. `preview.cjs` extracts only its main SAMI body, removes
editor comments and ruby readings, and marks the resulting SMI `temporary`.
Compact zero-width-space sync lines are restored as described by the author's
`SmiFile.fromText` in [harnenim/Jamaker](https://github.com/harnenim/Jamaker/blob/7c8f5b43349eb8709b1e265fb607f1f6e9e19cef/Jamaker/view/lib/SubtitleObject.js).
The normal subtitle codec turns this into plain VTT for playback. The preview
omits Jamaker frame correction, layout, extra holds and effect automations.
It is explicitly labeled and excluded from the verified subtitle disk cache.

Blog playback does not launch Chromium. The separate weekly Pi downloader
keeps using the author's Chromium viewer to save full ASS/SMI files; existing
local and verified full subtitles retain priority over blog previews.

Workers have a heap limit, a wall-clock deadline, PNG pixel/recursion limits and
input/output byte limits. Node receives no user scripts to evaluate. PNG and
raw JMK are transient inputs; the web cache is memory-only and contains only
playable outputs. Empty or incomplete extraction is not warm-cached.
