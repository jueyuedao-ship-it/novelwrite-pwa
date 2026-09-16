/* Local image I/O only. Original image bytes are embedded; no conversion or upload. */
(function () {
  'use strict';
  const C = NovelCore;
  async function checkDecoded(dataUrl) {
    const img = new Image();
    img.src = dataUrl;
    try {
      await img.decode();
      if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty');
    } catch { throw new Error('画像を表示できません。破損していないPNG・JPEG・WebP・GIFを選んでください。'); }
    finally { img.removeAttribute('src'); }
  }
  async function readFile(file) {
    if (file.size > C.MAX_IMAGE_BYTES) throw new Error(`「${file.name}」は10MBを超えています。`);
    const extensions = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
    const mime = Object.values(extensions).includes(file.type) ? file.type : extensions[file.name.split('.').at(-1).toLowerCase()];
    if (!mime) throw new Error('PNG・JPEG・WebP・GIFの画像を選んでください。');
    const encoded = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(`「${file.name}」を読み込めませんでした。`));
      reader.onabort = () => reject(new Error('画像の読み込みが取り消されました。'));
      reader.readAsDataURL(file);
    });
    const dataUrl = `data:${mime};base64,${encoded.slice(encoded.indexOf(',') + 1)}`;
    C.validateImageData(dataUrl);
    await checkDecoded(dataUrl);
    return { id: C.uid('image'), name: file.name, dataUrl };
  }
  async function validateWorkImages(work) {
    // Decode one image at a time, including images on chapters that are not displayed.
    for (const owner of [...work.characters, ...work.chapters.flatMap(c => c.scenes)]) {
      for (const img of owner.images) {
        try { await checkDecoded(img.dataUrl); }
        catch (error) { throw new Error(`「${img.name}」：${error.message}`); }
      }
    }
  }
  globalThis.NovelImages = { readFile, validateWorkImages };
})();
