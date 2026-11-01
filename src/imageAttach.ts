/**
 * 貼った・ドロップした・選んだ画像を、送れる形に整える。
 *
 * 長い辺を 1600 ピクセルまでに縮めて、JPEG にする。大きな画像をそのまま送ると、重く、
 * 費用もかかり、サーバーの受け入れ上限（約 8MB）にも当たる。画像の文字や図が読める大きさは残す。
 */
export interface PreparedImage { base64: string; mime: 'image/jpeg'; preview: string; name: string }

export async function prepareImage(file: File, maxEdge = 1600): Promise<PreparedImage | null> {
  if (!file.type.startsWith('image/')) return null;
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { return null; }
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  // 透明な部分は、JPEG では黒くなる。白で下地を塗る。
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const preview = canvas.toDataURL('image/jpeg', 0.82);
  const base64 = preview.slice(preview.indexOf(',') + 1);
  return { base64, mime: 'image/jpeg', preview, name: file.name || '画像' };
}

/** 貼り付け・ドロップ・ファイル選択のどれからでも、最初の画像ファイルを取り出す。 */
export function firstImageFile(files: FileList | File[] | null | undefined, items?: DataTransferItemList | null): File | null {
  const list = files ? Array.from(files as ArrayLike<File>) : [];
  const fromFiles = list.find((f) => f.type.startsWith('image/'));
  if (fromFiles) return fromFiles;
  if (items) {
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
    }
  }
  return null;
}
