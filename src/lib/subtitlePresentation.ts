/** Apply presentation preferences to a render copy; never change subtitle files. */
export function scaleAssFontSizes(content: string, scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) return content;
  let section = "", fontSizeIndex = -1;
  const scaled = (value: string) => {
    const number = Number(value);
    return Number.isFinite(number) ? String(Math.round(number * scale * 1000) / 1000) : value;
  };
  return content.split(/(\r?\n)/).map((line) => {
    const header = line.trim().match(/^\[([^\]]+)\]$/);
    if (header) { section = header[1].toLowerCase(); fontSizeIndex = -1; }
    if (section === "v4+ styles" || section === "v4 styles") {
      const format = line.match(/^\s*Format:\s*(.*)$/i);
      if (format) fontSizeIndex = format[1].split(",").findIndex((field) => field.trim().toLowerCase() === "fontsize");
      // ASS/SSA allow the standard style format to be omitted.
      const index = fontSizeIndex < 0 ? 2 : fontSizeIndex;
      return line.replace(/^(\s*Style:\s*)(.*)$/i, (_, prefix, style) => {
        const fields = style.split(",");
        if (fields[index]?.trim()) fields[index] = scaled(fields[index]);
        return prefix + fields.join(",");
      });
    }
    if (section === "events" && /^\s*Dialogue:/i.test(line)) {
      // Only override blocks: keep dialogue text, drawing coordinates, timing,
      // positioning, karaoke and reset-style tags intact. Includes animated \t(\fs...).
      return line.replace(/\{[^}]*\}/g, (block) => block.replace(
        /\\fs([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?=[\\)\s}]|$)/g,
        // Signed fs values are relative multipliers in libass, not font units.
        (_, value) => "\\fs" + (/^[+-]/.test(value) ? value : scaled(value)),
      ));
    }
    return line;
  }).join("");
}

/** External canvases bypass Octopus' video sizing and must include device DPI. */
export function subtitleRenderSize(width: number, height: number, sharpness: number, pixelRatio = 1) {
  const quality = Number.isFinite(sharpness) && sharpness >= 1 && sharpness <= 3 ? sharpness : 1;
  const dpi = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const factor = Math.min(dpi * quality, 1440 * quality / Math.max(1, height));
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) };
}
