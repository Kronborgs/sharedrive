async function cropAndScaleImageSrc(
  src: string,
  preferPng: boolean,
  maxDimension: number
): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Kunne ikke indlæse det valgte billede.'));
    el.src = src;
  });

  const srcWidth = img.naturalWidth || img.width;
  const srcHeight = img.naturalHeight || img.height;
  if (!srcWidth || !srcHeight) {
    throw new Error('Billedet har ugyldige dimensioner.');
  }

  const side = Math.min(srcWidth, srcHeight);
  const sx = Math.floor((srcWidth - side) / 2);
  const sy = Math.floor((srcHeight - side) / 2);
  const targetSide = Math.min(maxDimension, side);

  const canvas = document.createElement('canvas');
  canvas.width = targetSide;
  canvas.height = targetSide;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Browseren understøtter ikke billedbehandling.');
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (!preferPng) {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, targetSide, targetSide);
  }

  ctx.drawImage(img, sx, sy, side, side, 0, 0, targetSide, targetSide);

  if (preferPng) {
    const pngDataUrl = canvas.toDataURL('image/png');
    if (pngDataUrl.length <= 160_000) {
      return pngDataUrl;
    }
    const jpgCanvas = document.createElement('canvas');
    jpgCanvas.width = targetSide;
    jpgCanvas.height = targetSide;
    const jpgCtx = jpgCanvas.getContext('2d');
    if (jpgCtx) {
      jpgCtx.fillStyle = '#0f172a';
      jpgCtx.fillRect(0, 0, targetSide, targetSide);
      jpgCtx.drawImage(canvas, 0, 0);
      return jpgCanvas.toDataURL('image/jpeg', 0.86);
    }
  }

  return canvas.toDataURL('image/jpeg', 0.86);
}

/**
 * Indlæser et valgt billede i browseren, centrerer og beskærer det kvadratisk (1:1)
 * og skalerer det ned til maks. 256×256 px som kompakt data-URL til CardDAV vCard PHOTO.
 */
export async function processContactPhotoFile(file: File, maxDimension = 256): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Vælg venligst en gyldig billedfil (JPG, PNG eller WebP).');
  }
  if (file.size > 15 * 1024 * 1024) {
    throw new Error('Billedfilen er for stor (maks. 15 MB).');
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    return await cropAndScaleImageSrc(objectUrl, file.type === 'image/png', maxDimension);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Beskærer og komprimerer en data:image/* URL (f.eks. fra en e-mailvedhæftning)
 * kvadratisk til maks. 256×256 px til CardDAV vCard PHOTO.
 */
export async function processContactPhotoDataUrl(
  dataUrl: string,
  maxDimension = 256
): Promise<string> {
  const clean = dataUrl.trim();
  if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(clean)) {
    throw new Error('Ugyldigt billedformat.');
  }
  const preferPng = /^data:image\/png;/i.test(clean);
  return cropAndScaleImageSrc(clean, preferPng, maxDimension);
}
