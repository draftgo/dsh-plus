import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareInstallerSources } from './prepare-brand.mjs';

for (const newline of ['\n', '\r\n']) test('installer migration retains registered-directory guard: ' + JSON.stringify(newline), async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaojiao-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'deepseek-harness/apps/desktop/installer');
  const output = join(root, 'packaging');
  await mkdir(source, { recursive: true });
  const contents = [
    '    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"',
    '    ${If} $0 != $INSTDIR',
    '    ${OrIfNot} ${FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"',
    '        RejectNonEmptyDirectory',
    '    ${EndIf}',
  ].join(newline);
  await writeFile(join(source, 'path.nsh'), contents);
  await writeFile(join(source, 'pages.nsh'), 'unchanged');
  await writeFile(join(source, 'window-frame.cpp'), 'not an include');
  await prepareInstallerSources(root, output);
  const prepared = await readFile(join(output, 'path.nsh'), 'utf8');
  assert.ok(prepared.includes('${OrIf} ${FileExists} "$INSTDIR\\DSH-Plus.exe"'));
  assert.ok(prepared.includes('${If} $0 != $INSTDIR\n    ${OrIf} $1 != 1'));
  assert.equal(await readFile(join(source, 'path.nsh'), 'utf8'), contents);
  assert.equal(await readFile(join(output, 'pages.nsh'), 'utf8'), 'unchanged');
  await assert.rejects(readFile(join(output, 'window-frame.cpp')), { code: 'ENOENT' });
  await writeFile(join(source, 'path.nsh'), 'upstream changed ownership semantics');
  await assert.rejects(prepareInstallerSources(root, output), /ownership check changed/);
});
