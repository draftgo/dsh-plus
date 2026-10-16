import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { build as esbuild } from 'esbuild';

const selector = fileURLToPath(new URL('../client/provider-settings.jsx', import.meta.url));
const once = (source, before, after, label) => {
  if (source.split(before).length !== 2) throw new Error('Official Models UI changed: ' + label);
  return source.replace(before, after);
};

/** Strict build-only adaptation; the official submodule always stays untouched. */
export function officialModelsUi() {
  return { name: 'commander-official-models-ui', setup(build) {
    build.onLoad({ filter: /ui-settings-models\/src\/client\/ModelsSection\.tsx$/ }, async args => {
      let source = await readFile(args.path, 'utf8');
      source = 'import { ProviderSelect, ProviderBrandIcon } from ' + JSON.stringify(selector) + ';\n' + source;
      source = once(source, "const [addMode, setAddMode] = useState<AddMode>('catalog')", "const [addMode, setAddMode] = useState<AddMode>('catalog')\n  const [providerPreset, setProviderPreset] = useState<any>(undefined)", 'preset state');
      const start = source.indexOf('                      <select\n');
      const end = source.indexOf('                      </select>', start);
      if (start < 0 || end < 0 || source.indexOf('                      <select\n', start + 1) !== -1) throw new Error('Official Models UI changed: provider select');
      const original = source.slice(start, end + '                      </select>'.length);
      if (!original.includes('value={draft.target.provider}') || !original.includes('setEditing(targetOf(picked.row))')) throw new Error('Official Models UI changed: provider selection semantics');
      const fieldStart = source.lastIndexOf('                    <div className={styles[\'field\']}>', start);
      const fieldEnd = source.indexOf('                    </div>', end) + '                    </div>'.length;
      if (fieldStart < 0 || fieldEnd < end) throw new Error('Official Models UI changed: provider field');
      source = source.slice(0, fieldStart) + source.slice(fieldEnd);
      source = once(source, '              <div className={styles[\'addModes\']}>', '              <div className={styles[\'addModes\']}>\n' + [
        '                      <ProviderSelect',
        '                        value={mode === "custom" ? providerPreset?.id ?? "__custom" : draft?.target.provider}',
        '                        options={addable.map(({ row }) => ({ id: row.entry.provider, name: row.entry.displayName, declared: row.entry.declared === true }))}',
        "                        label={t('provider')} disabled={catalogBusy || customBusy}",
        '                        customEnabled={customEnabled} routerAvailable={!state.rows.some(row => row.entry.provider === "routergo" && row.configured)}',
        '                        onChange={(id) => { const picked = addable.find(candidate => candidate.row.entry.provider === id); if (picked) { setProviderPreset(undefined); setEditing(targetOf(picked.row)); setAddMode("catalog"); setVisited(previous => new Set([...previous, "catalog"])) } }}',
        "                        onPreset={(preset) => { setProviderPreset(preset); setAddMode('custom'); setVisited(previous => new Set([...previous, 'custom'])) }}",
        '                      />',
      ].join('\n'), 'provider picker');
      source = once(source, "                  <span className={styles['rowName']}>{row.entry.displayName}</span>", "                  <ProviderBrandIcon id={row.entry.provider} name={row.entry.displayName} declared={row.entry.declared === true} />\n                  <span className={styles['rowName']}>{row.entry.displayName}</span>", 'configured provider brand');
      source = once(source, '                    <CustomProviderCard\n', '                    <CustomProviderCard key={providerPreset?.id ?? "custom"} preset={providerPreset}\n', 'custom preset prop');
      source = once(source, '                    setSavedTarget(undefined)\n                    setEditing(first === undefined', '                    setSavedTarget(undefined)\n                    setProviderPreset(undefined)\n                    setEditing(first === undefined', 'clear preset');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models\/src\/client\/CustomProviderCard\.tsx$/ }, async args => {
      let source = await readFile(args.path, 'utf8');
      source = 'import { ProviderHarnessField, useProviderHarness, ProviderBrandIcon } from ' + JSON.stringify(selector) + ';\n' + source;
      source = once(source, 'export interface CustomProviderCardProps {', 'export interface CustomProviderCardProps {\n  preset?: { id: string; name: string; baseURL: string; protocol: string }', 'preset interface');
      for (const [name, field] of [['route', 'id'], ['displayName', 'name'], ['baseURL', 'baseURL']]) {
        const capital = name[0].toUpperCase() + name.slice(1);
        source = once(source, "const [" + name + ', set' + capital + "] = useState('')", "const [" + name + ', set' + capital + "] = useState(props.preset?." + field + " ?? '')", 'preset ' + name);
      }
      source = once(source, "const [protocol, setProtocol] = useState(protocols[0] ?? '')", "const [protocol, setProtocol] = useState(props.preset?.protocol && protocols.includes(props.preset.protocol) ? props.preset.protocol : protocols[0] ?? '')", 'preset protocol');
      source = once(source, "  const [keyDraft, setKeyDraft] = useState('')", "  const harness = useProviderHarness(route)\n  const [keyDraft, setKeyDraft] = useState('')", 'custom harness draft');
      source = once(source, "    <div className={styles['editor']}>", "    <div className={styles['editor']}>\n      <ProviderHarnessField value={harness} disabled={disabled} />", 'custom harness field');
      source = once(source, '      props.onClose(true)', '      await harness.save()\n      props.onClose(true)', 'custom harness save');
      source = once(source, '    } finally {\n      setBusy(false)', '    } catch (error) {\n      setFailure(error instanceof Error ? error.message : String(error))\n    } finally {\n      setBusy(false)', 'custom harness failure');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models\/src\/client\/ProviderEditor\.tsx$/ }, async args => {
      let source = await readFile(args.path, 'utf8');
      source = 'import { ProviderHarnessField, useProviderHarness, ProviderBrandIcon } from ' + JSON.stringify(selector) + ';\n' + source;
      source = once(source, "            <span className={styles['editorTitle']}>{props.displayName}</span>", "            <ProviderBrandIcon id={props.provider} name={props.displayName} declared={props.declared === true} />\n            <span className={styles['editorTitle']}>{props.displayName}</span>", 'provider editor brand');
      source = once(source, '  const { namespace, schema, settingsPath, operations, t } = props', '  const { namespace, schema, settingsPath, operations, t } = props\n  const harness = useProviderHarness(props.provider)', 'provider harness draft');
      source = once(source, "    <div className={props.credentialOnly === true ? styles['addBlock'] : styles['editor']}>", "    <div className={props.credentialOnly === true ? styles['addBlock'] : styles['editor']}>\n      {props.credentialOnly === true ? null : <ProviderHarnessField value={harness} disabled={disabled} />}", 'provider harness field');
      source = once(source, '      props.onClose(true)', '      if (props.credentialOnly !== true) await harness.save()\n      props.onClose(true)', 'provider harness save');
      source = once(source, '    } finally {\n      setBusy(false)', '    } catch (error) {\n      setFailure(error instanceof Error ? error.message : String(error))\n    } finally {\n      setBusy(false)', 'provider harness failure');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models\/src\/client\/ModelsSection\.module\.css$/ }, async args => {
      const result = await esbuild({ stdin: { contents: 'import styles from ' + JSON.stringify(args.path) + '; export default styles;', resolveDir: dirname(args.path) }, bundle: true, write: false, outdir: '/tmp/commander-css-memory', format: 'cjs', loader: { '.css': 'local-css' }, logLevel: 'silent' });
      const js = result.outputFiles.find(file => file.path.endsWith('.js'));
      const css = result.outputFiles.find(file => file.path.endsWith('.css'));
      if (!js || !css) throw new Error('Official Models CSS module did not compile');
      const module = { exports: {} }; new Function('module', 'exports', js.text)(module, module.exports);
      return { loader: 'js', contents: 'const id="commander-official-models-style"; if (!document.getElementById(id)) { const style=document.createElement("style"); style.id=id; style.textContent=' + JSON.stringify(css.text) + '; document.head.append(style); } export default ' + JSON.stringify(module.exports.default) + ';' };
    });
  } };
}
