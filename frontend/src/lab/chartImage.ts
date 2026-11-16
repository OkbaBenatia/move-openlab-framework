/** Raster image of a standalone SVG, drawn by the browser (so the PNG is the chart as rendered, not a screenshot). */
export function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = Math.round(width * scale); c.height = Math.round(height * scale);
      const g = c.getContext('2d');
      if (!g) { reject(new Error('no canvas')); return; }
      g.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('the image could not be encoded'))), 'image/png');
    };
    img.onerror = () => reject(new Error('the chart image could not be drawn'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

export function saveBlob(blob: Blob, name: string) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
