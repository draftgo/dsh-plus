import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeDesktopRuntime, verifyDesktopRuntime } from '../../deepseek-harness/apps/desktop/src/runtime-tree.ts';
import { prepareRuntimeManifests } from '../../deepseek-harness/apps/desktop/scripts/prepare-runtime-manifests.ts';

const runtime = process.argv[2];
if (!runtime) throw new Error('Usage: seal-runtime.mjs <prepared-runtime>');
const original = JSON.parse(await readFile(join(runtime, 'desktop-runtime.json'), 'utf8'));
await prepareRuntimeManifests(runtime);
writeDesktopRuntime(runtime, original.release, [...original.sharedPackages.map(item => item.name), '@dowork/commander', '@dowork/dsh-plus-desktop'], original);
await verifyDesktopRuntime(runtime, original.release.version, original);
console.log('Plus runtime sealed with the official inventory and shared package contract.');
