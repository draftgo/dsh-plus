import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { build as esbuild } from 'esbuild';

const selector = fileURLToPath(new URL('../client/provider-settings.jsx', import.meta.url));
const reasoningEditor = fileURLToPath(new URL('../client/model-reasoning.jsx', import.meta.url));
const reasoningState = fileURLToPath(new URL('../client/model-reasoning-state.mjs', import.meta.url));
const once = (source, before, after, label) => {
  if (source.split(before).length !== 2) throw new Error('Official Models UI changed: ' + label);
  return source.replace(before, after);
};

/** Strict build-only adaptation; the official submodule always stays untouched. */
export function officialModelsUi() {
  return { name: 'commander-official-models-ui', setup(build) {
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ModelsSection\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
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
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]CustomProviderCard\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = 'import { validateModelReasoning } from ' + JSON.stringify(reasoningState) + ';\n' + source;
      source = 'import { ProviderHarnessField, useProviderHarness, ProviderBrandIcon } from ' + JSON.stringify(selector) + ';\n' + source;
      source = once(source, 'export interface CustomProviderCardProps {', 'export interface CustomProviderCardProps {\n  preset?: { id: string; name: string; baseURL: string; protocol: string }', 'preset interface');
      for (const [name, field] of [['route', 'id'], ['displayName', 'name'], ['baseURL', 'baseURL']]) {
        const capital = name[0].toUpperCase() + name.slice(1);
        source = once(source, "const [" + name + ', set' + capital + "] = useState('')", "const [" + name + ', set' + capital + "] = useState(props.preset?." + field + " ?? '')", 'preset ' + name);
      }
      source = once(source, "const [protocol, setProtocol] = useState(protocols[0] ?? '')", "const [protocol, setProtocol] = useState(props.preset?.protocol && protocols.includes(props.preset.protocol) ? props.preset.protocol : protocols[0] ?? '')", 'preset protocol');
      source = once(source, "  const [keyDraft, setKeyDraft] = useState('')", "  const harness = useProviderHarness(route)\n  const [keyDraft, setKeyDraft] = useState('')", 'custom harness draft');
      source = once(source, "    <div className={styles['editor']}>", "    <div className={styles['editor']} data-commander-provider-editor='true'>\n      <ProviderHarnessField value={harness} disabled={disabled} />", 'custom harness field');
      source = once(source, '      props.onClose(true)', '      await harness.save()\n      props.onClose(true)', 'custom harness save');
      source = once(source, '    } finally {\n      setBusy(false)', '    } catch (error) {\n      setFailure(error instanceof Error ? error.message : String(error))\n    } finally {\n      setBusy(false)', 'custom harness failure');
      source = once(source, '  const modelFailure = validateDeepSeekModels(models)', '  const reasoningFailure = validateModelReasoning(models)\n  const modelFailure = validateDeepSeekModels(models)', 'custom reasoning validation');
      source = once(source, '    && keyFailure === undefined', '    && keyFailure === undefined && reasoningFailure === undefined', 'custom reasoning submit gate');
      source = once(source, "        : t('customNeedsModels')", "        : reasoningFailure ?? t('customNeedsModels')", 'custom reasoning failure hint');
      source = once(source, '  const createOnce = async (): Promise<string | undefined> => {', '  const createOnce = async (): Promise<string | undefined> => {\n    if (!committed && reasoningFailure !== undefined) return reasoningFailure', 'custom reasoning write gate');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ProviderEditor\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = 'import { validateModelReasoning } from ' + JSON.stringify(reasoningState) + ';\n' + source;
      source = 'import { ProviderHarnessField, useProviderHarness, ProviderBrandIcon } from ' + JSON.stringify(selector) + ';\n' + source;
      source = once(source, "            <span className={styles['editorTitle']}>{props.displayName}</span>", "            <ProviderBrandIcon id={props.provider} name={props.displayName} declared={props.declared === true} />\n            <span className={styles['editorTitle']}>{props.displayName}</span>", 'provider editor brand');
      source = once(source, '  const { namespace, schema, settingsPath, operations, t } = props', '  const { namespace, schema, settingsPath, operations, t } = props\n  const harness = useProviderHarness(props.provider)', 'provider harness draft');
      source = once(source, "    <div className={props.credentialOnly === true ? styles['addBlock'] : styles['editor']}>", "    <div className={props.credentialOnly === true ? styles['addBlock'] : styles['editor']} data-commander-provider-editor={props.credentialOnly === true ? undefined : 'true'}>\n      {props.credentialOnly === true ? null : <ProviderHarnessField value={harness} disabled={disabled} />}", 'provider harness field');
      source = once(source, '      props.onClose(true)', '      if (props.credentialOnly !== true) await harness.save()\n      props.onClose(true)', 'provider harness save');
      source = once(source, '    } finally {\n      setBusy(false)', '    } catch (error) {\n      setFailure(error instanceof Error ? error.message : String(error))\n    } finally {\n      setBusy(false)', 'provider harness failure');
      source = once(source, "  const modelFailure = validateDeepSeekModels(schema.getPath(draft, ['models']))", "  const reasoningFailure = layout === 'pi-ai' && props.credentialOnly !== true ? validateModelReasoning(schema.getPath(draft, ['models'])) : undefined\n  const modelFailure = validateDeepSeekModels(schema.getPath(draft, ['models']))", 'provider reasoning validation');
      source = once(source, '    if (props.credentialOnly !== true) {', '    if (props.credentialOnly !== true) {\n      if (reasoningFailure !== undefined) return reasoningFailure', 'provider reasoning write gate');
      source = once(source, "      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}", "      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}\n      {props.credentialOnly !== true && reasoningFailure !== undefined ? <p role=\"alert\" className={styles['error']}>{reasoningFailure}</p> : null}", 'provider reasoning failure hint');
      source = once(source, "          || (props.credentialOnly !== true && modelFailure !== undefined)", "          || (props.credentialOnly !== true && (modelFailure !== undefined || reasoningFailure !== undefined))", 'provider reasoning submit gate');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ModelRow\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = once(source, 'interface ModelRowProps {', 'interface ModelRowProps {\n  extraSettings?: ReactNode', 'model extension prop');
      source = once(source, '            />\n          </div>', '            />\n            {props.extraSettings}\n          </div>', 'expanded model extension');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ModelListEditor\.tsx$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = 'import { ModelReasoningEditor } from ' + JSON.stringify(reasoningEditor) + ';\n' + source;
      source = once(source, '            onFieldChange={(field, value)', '            extraSettings={<ModelReasoningEditor model={model} position={index + 1} disabled={disabled} styles={styles} onChange={(next) => { onChange(models.map((row, at) => at === index ? next : row)) }} />}\n            onFieldChange={(field, value)', 'per-model reasoning settings');
      return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
    });
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]ModelsSection\.module\.css$/ }, async args => {
      const result = await esbuild({ stdin: { contents: 'import styles from ' + JSON.stringify(args.path) + '; export default styles;', resolveDir: dirname(args.path) }, bundle: true, write: false, outdir: join(tmpdir(), 'commander-css-memory'), format: 'cjs', loader: { '.css': 'local-css' }, logLevel: 'silent' });
      const js = result.outputFiles.find(file => file.path.endsWith('.js'));
      const css = result.outputFiles.find(file => file.path.endsWith('.css'));
      if (!js || !css) throw new Error('Official Models CSS module did not compile');
      const module = { exports: {} }; new Function('module', 'exports', js.text)(module, module.exports);
      return { loader: 'js', contents: 'const id="commander-official-models-style"; if (!document.getElementById(id)) { const style=document.createElement("style"); style.id=id; style.textContent=' + JSON.stringify(css.text) + '; document.head.append(style); } export default ' + JSON.stringify(module.exports.default) + ';' };
    });
  } };
}
