import { createRequire } from 'node:module';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const require = createRequire(new URL('../../deepseek-harness/apps/desktop/package.json', import.meta.url));

/** Prepare packaging-only artwork without changing the official desktop tree. */
export async function prepareDesktopBrand(root, output) {
  const sharp = require('sharp');
  const brand = join(root, 'assets/brand');
  const logo = join(brand, 'dsh-plus-logo.png');
  const mascot = (await readFile(join(brand, 'dsh-plus-logo.svg'))).toString('base64');
  await mkdir(output, { recursive: true });

  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const bitmaps = await Promise.all(sizes.map(size => sharp(logo).resize(size, size).png().toBuffer()));
  const directory = Buffer.alloc(6 + 16 * sizes.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16;
    directory[entry] = directory[entry + 1] = size % 256;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(bitmaps[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += bitmaps[index].length;
  }
  await writeFile(join(output, 'dsh-plus.ico'), Buffer.concat([directory, ...bitmaps]));

  for (const scale of [1, 2]) {
    for (const dark of [false, true]) {
      const width = 600 * scale, height = 196 * scale;
      const background = dark ? '#151517' : '#ffffff';
      const artwork = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 600 196"><rect width="600" height="196" fill="${background}"/><image href="data:image/svg+xml;base64,${mascot}" x="198" y="50" width="96" height="96"/><text x="314" y="111" font-family="Segoe UI,Microsoft YaHei UI,Microsoft YaHei,Arial,sans-serif" font-size="36" font-weight="600" fill="${dark ? '#ffffff' : '#222222'}">小角</text></svg>`);
      const image = await sharp(artwork).removeAlpha().raw().toBuffer();
      const name = `brand${dark ? '-dark' : ''}${scale === 2 ? '-2x' : ''}.bmp`;
      await writeFile(join(output, name), bitmap24(image, width, height));
    }
  }
  const sidebar = await sharp({ create: { width: 164, height: 314, channels: 3, background: '#151517' } })
    .composite([{ input: await sharp(logo).resize(112, 112).png().toBuffer(), gravity: 'centre' }])
    .removeAlpha().raw().toBuffer();
  await writeFile(join(output, 'uninstaller-sidebar.bmp'), bitmap24(sidebar, 164, 314));
  const strings = await readFile(join(root, 'deepseek-harness/apps/desktop/installer/strings.nsh'), 'utf8');
  await writeFile(join(output, 'strings-plus.nsh'), strings.replaceAll('DeepSeek Harness', '小角'));
}

/** NSIS bitmap controls consume bottom-up, padded BGR scanlines. */
function bitmap24(rgb, width, height) {
  const stride = Math.ceil(width * 3 / 4) * 4;
  const result = Buffer.alloc(54 + stride * height);
  result.write('BM');
  result.writeUInt32LE(result.length, 2);
  result.writeUInt32LE(54, 10);
  result.writeUInt32LE(40, 14);
  result.writeInt32LE(width, 18);
  result.writeInt32LE(height, 22);
  result.writeUInt16LE(1, 26);
  result.writeUInt16LE(24, 28);
  result.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (y * width + x) * 3, target = 54 + (height - y - 1) * stride + x * 3;
    result[target] = rgb[source + 2];
    result[target + 1] = rgb[source + 1];
    result[target + 2] = rgb[source];
  }
  return result;
}

/** Keep upstream read-only; accept the old executable only in its registered directory. */
export async function prepareInstallerSources(root, output) {
  const source = join(root, 'deepseek-harness/apps/desktop/installer');
  await mkdir(output, { recursive: true });
  for (const name of await readdir(source)) {
    if (!name.endsWith('.nsh')) continue;
    let contents = (await readFile(join(source, name), 'utf8')).replaceAll('\r\n', '\n');
    if (name === 'path.nsh') {
      const anchor = [
        '    ${If} $0 != $INSTDIR',
        '    ${OrIfNot} ${FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"',
      ].join('\n');
      const replacement = [
        '    StrCpy $1 0',
        '    ${If} ${FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"',
        '    ${OrIf} ${FileExists} "$INSTDIR\\DSH-Plus.exe"',
        '        StrCpy $1 1',
        '    ${EndIf}',
        '    ${If} $0 != $INSTDIR',
        '    ${OrIf} $1 != 1',
      ].join('\n');
      if (contents.split(anchor).length !== 2) throw new Error('Official installer ownership check changed; review 小角 migration');
      contents = contents.replace(anchor, replacement);
    }
    await writeFile(join(output, name), contents);
  }
}
