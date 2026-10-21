#!/usr/bin/env node

// plugins/link/scripts/ip-certificate.mjs
import { spawn } from "node:child_process";
import { createHash, randomUUID, X509Certificate, createPrivateKey } from "node:crypto";
import { access, link, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var MIN_CERTBOT = [5, 4, 0];
var CERT_NAME = "dsh-link-ip";
var TOOL_DIR = "dsh-link-ip-certificate";
var TIMER_SERVICE = "dsh-link-ip-certificate-renew.service";
var TIMER_UNIT = "dsh-link-ip-certificate-renew.timer";
var RELAY_UNIT = "dsh-link-relay.service";
var UNIT_MARKER = "# Managed by DSH Link IP certificate tool.";
var TIMER_MANIFEST = ".dsh-link-ip-certificate-renew.json";
var fail = (message) => {
  throw new Error(message);
};
function options(argv) {
  const [operation, ...rest] = argv;
  if (!["issue", "renew", "dry-run", "status", "install-timer", "uninstall-timer"].includes(operation)) fail("\u7528\u6CD5\uFF1Aip-certificate.mjs <issue|renew|dry-run|status|install-timer|uninstall-timer> [\u9009\u9879]");
  const allowed = /* @__PURE__ */ new Set(["--ip", "--email", "--webroot", "--state-dir", "--challenge-port", "--relay-port", "--confirm-public-ip", "--certbot", "--restart-relay-unit"]);
  const values = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!allowed.has(key) || key in values || !value || value.startsWith("--")) fail("\u8BC1\u4E66\u53C2\u6570\u65E0\u6548\uFF1A" + key);
    values[key] = value;
  }
  if (operation === "uninstall-timer") {
    if (Object.keys(values).length) fail("uninstall-timer \u4E0D\u63A5\u53D7\u53C2\u6570");
    return { operation, values };
  }
  if (!values["--state-dir"]) fail("\u5FC5\u987B\u6307\u5B9A --state-dir");
  if (["status", "install-timer"].includes(operation) && Object.keys(values).some((key) => key !== "--state-dir")) fail(operation + " \u53EA\u63A5\u53D7 --state-dir");
  if (!["status", "install-timer"].includes(operation)) {
    for (const key of ["--ip", "--email", "--webroot", "--challenge-port", "--relay-port", "--confirm-public-ip"]) if (!values[key]) fail("\u5FC5\u987B\u6307\u5B9A " + key);
  }
  if (values["--restart-relay-unit"] && (operation !== "renew" || values["--restart-relay-unit"] !== RELAY_UNIT)) fail("\u7EED\u671F\u53EA\u5141\u8BB8\u91CD\u542F\u672C\u5DE5\u5177\u7BA1\u7406\u7684 " + RELAY_UNIT);
  return { operation, values };
}
function portNumber(value) {
  if (!/^\d{1,5}$/.test(value ?? "")) fail("\u7AEF\u53E3\u5FC5\u987B\u4F7F\u7528\u5341\u8FDB\u5236\u6570\u5B57");
  return Number(value);
}
function ipv4Number(ip) {
  return ip.split(".").reduce((value, item) => value << 8n | BigInt(item), 0n);
}
function inCidr(value, base, bits, width) {
  return value >> BigInt(width - bits) === base >> BigInt(width - bits);
}
function ipv6Number(ip) {
  let value = ip.toLowerCase();
  if (value.includes(".")) {
    const index = value.lastIndexOf(":");
    const v4 = value.slice(index + 1);
    if (isIP(v4) !== 4) return null;
    const n = ipv4Number(v4);
    value = value.slice(0, index) + ":" + (n >> 16n).toString(16) + ":" + (n & 0xffffn).toString(16);
  }
  const halves = value.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  if (halves.length > 2) return null;
  const groups = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((number, group) => number << 16n | BigInt("0x" + group), 0n);
}
function validateConfig(input) {
  const ip = input.ip;
  const family = typeof ip === "string" ? isIP(ip) : 0;
  if (!family) fail("\u5FC5\u987B\u586B\u5199\u6709\u6548\u7684 IP \u5730\u5740\uFF0C\u4E0D\u80FD\u586B\u5199\u57DF\u540D");
  if (input.confirmPublicIp !== true) fail("\u8BF7\u786E\u8BA4\u8BE5 IP \u662F\u6B64\u670D\u52A1\u5668\u5B9E\u9645\u4F7F\u7528\u7684\u516C\u7F51 IP");
  if (family === 4) {
    const value = ipv4Number(ip);
    const blocked = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4]
    ];
    if (blocked.some(([base, bits]) => inCidr(value, ipv4Number(base), bits, 32))) fail("\u8BE5 IPv4 \u5730\u5740\u4E0D\u662F\u53EF\u7B7E\u53D1\u8BC1\u4E66\u7684\u516C\u7F51\u5355\u64AD\u5730\u5740");
  } else {
    const value = ipv6Number(ip);
    if (value === null || value >> 125n !== 1n || inCidr(value, ipv6Number("2001::"), 23, 128) || inCidr(value, ipv6Number("2001:db8::"), 32, 128) || inCidr(value, ipv6Number("2001:20::"), 28, 128) || inCidr(value, ipv6Number("3fff::"), 20, 128)) fail("\u8BE5 IPv6 \u5730\u5740\u4E0D\u662F\u53EF\u7B7E\u53D1\u8BC1\u4E66\u7684\u516C\u7F51\u5355\u64AD\u5730\u5740");
  }
  if (!/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/.test(input.email ?? "")) fail("\u8BF7\u8F93\u5165\u6709\u6548\u7684\u8054\u7CFB\u90AE\u7BB1");
  if (input.challengePort !== 80) fail("Let\u2019s Encrypt HTTP-01 \u56FA\u5B9A\u4F7F\u7528\u516C\u7F51 80 \u7AEF\u53E3\uFF1B\u8BF7\u8BA9\u73B0\u6709\u53CD\u5411\u4EE3\u7406\u5C06\u6311\u6218\u76EE\u5F55\u6620\u5C04\u5230 webroot");
  if (!Number.isInteger(input.relayPort) || input.relayPort < 2e4 || input.relayPort > 49151 || [22, 80, 443, 8080, 8443].includes(input.relayPort)) fail("\u4E2D\u7EE7\u4E1A\u52A1\u7AEF\u53E3\u987B\u4E3A 20000\u201349151 \u7684\u4E13\u7528\u9AD8\u4F4D\u7AEF\u53E3");
  if (typeof input.webroot !== "string" || !input.webroot || !input.stateDir) fail("\u5FC5\u987B\u6307\u5B9A\u5DF2\u5B58\u5728\u7684 webroot \u548C\u72B6\u6001\u76EE\u5F55");
  if (input.certbot !== void 0 && (typeof input.certbot !== "string" || !input.certbot || input.certbot.includes("\0"))) fail("Certbot \u8DEF\u5F84\u65E0\u6548");
  return { ip, family, email: input.email, challengePort: 80, relayPort: input.relayPort, webroot: resolve(input.webroot), stateDir: resolve(input.stateDir), certbot: input.certbot ?? "certbot" };
}
async function existingDirectory(path, label, writable = false) {
  const resolved = await realpath(path).catch(() => fail(label + " \u5FC5\u987B\u662F\u5DF2\u5B58\u5728\u7684\u76EE\u5F55"));
  const stat = await lstat(resolved);
  if (!stat.isDirectory()) fail(label + " \u5FC5\u987B\u662F\u76EE\u5F55");
  await access(resolved, writable ? 2 : 4).catch(() => fail(label + (writable ? " \u4E0D\u53EF\u5199" : " \u4E0D\u53EF\u8BFB")));
  return resolved;
}
async function stateDirectory(path, { create = false } = {}) {
  const requested = resolve(path);
  if (create) await mkdir(requested, { recursive: true, mode: 448 });
  const resolved = await realpath(requested).catch((error) => error.code === "ENOENT" && !create ? null : fail("\u72B6\u6001\u76EE\u5F55\u5FC5\u987B\u662F\u53EF\u8BBF\u95EE\u7684\u76EE\u5F55"));
  if (!resolved) return null;
  const stat = await lstat(resolved);
  if (!stat.isDirectory()) fail("\u72B6\u6001\u76EE\u5F55\u5FC5\u987B\u662F\u76EE\u5F55");
  await access(resolved, create ? 2 : 4).catch(() => fail(create ? "\u72B6\u6001\u76EE\u5F55\u4E0D\u53EF\u5199" : "\u72B6\u6001\u76EE\u5F55\u4E0D\u53EF\u8BFB"));
  return resolved;
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
function systemdArg(value) {
  const text = String(value);
  if (/[\0\r\n]/.test(text)) fail("systemd \u53C2\u6570\u4E0D\u80FD\u5305\u542B\u6362\u884C\u6216\u7A7A\u5B57\u7B26");
  return '"' + text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "$$").replace(/%/g, "%%") + '"';
}
function unitDirectory() {
  const configHome = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : join(homedir(), ".config");
  return join(configHome, "systemd", "user");
}
function timerContents(config, stateDir) {
  const script = fileURLToPath(import.meta.url);
  const args = [
    process.execPath,
    script,
    "renew",
    "--state-dir",
    stateDir,
    "--ip",
    config.ip,
    "--email",
    config.email,
    "--webroot",
    config.webroot,
    "--challenge-port",
    "80",
    "--relay-port",
    String(config.relayPort),
    "--confirm-public-ip",
    "true",
    "--certbot",
    config.certbot ?? "certbot",
    "--restart-relay-unit",
    RELAY_UNIT
  ];
  const service = [
    UNIT_MARKER,
    "[Unit]",
    "Description=Renew the DSH Link IP certificate",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    "UMask=0077",
    "TimeoutStartSec=25min",
    "ExecStart=" + args.map(systemdArg).join(" "),
    ""
  ].join("\n");
  const timer = [
    UNIT_MARKER,
    "[Unit]",
    "Description=Daily renewal of the DSH Link IP certificate",
    "",
    "[Timer]",
    "OnCalendar=daily",
    "RandomizedDelaySec=1h",
    "Persistent=true",
    "Unit=" + TIMER_SERVICE,
    "",
    "[Install]",
    "WantedBy=timers.target",
    ""
  ].join("\n");
  return { [TIMER_SERVICE]: service, [TIMER_UNIT]: timer };
}
async function ownedFile(path, expectedHash, label) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid()) fail(label + " \u4E0D\u662F\u672C\u5DE5\u5177\u62E5\u6709\u7684\u666E\u901A\u6587\u4EF6");
  const contents = await readFile(path, "utf8");
  if (!contents.startsWith(UNIT_MARKER) || digest(contents) !== expectedHash) fail(label + " \u5DF2\u88AB\u4FEE\u6539\uFF0C\u62D2\u7EDD\u8986\u76D6\u6216\u5220\u9664");
  return contents;
}
async function readTimerManifest(directory) {
  const path = join(directory, TIMER_MANIFEST);
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 63) !== 0 || typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("\u7EED\u671F timer \u5F52\u5C5E\u6E05\u5355\u6743\u9650\u6216\u6587\u4EF6\u7C7B\u578B\u65E0\u6548");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.tool !== "dsh-link-ip-certificate" || !manifest.units || typeof manifest.units[TIMER_SERVICE] !== "string" || typeof manifest.units[TIMER_UNIT] !== "string") fail("\u7EED\u671F timer \u5F52\u5C5E\u6E05\u5355\u65E0\u6548");
  if (![manifest.units[TIMER_SERVICE], manifest.units[TIMER_UNIT]].every((value) => /^[a-f0-9]{64}$/.test(value))) fail("\u7EED\u671F timer \u5F52\u5C5E\u6E05\u5355\u54C8\u5E0C\u65E0\u6548");
  return manifest;
}
async function createOwnedFile(path, contents) {
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, contents, { mode: 384, flag: "wx" });
  try {
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function systemd(args) {
  return command("systemctl", ["--user", ...args], { timeout: 3e4, label: "systemctl" });
}
async function requireRelayUnit() {
  const { stdout } = await systemd(["show", "--property=LoadState", "--value", RELAY_UNIT]);
  if (stdout.trim() !== "loaded") fail("\u5F53\u524D\u7528\u6237\u7684 systemd \u5C1A\u672A\u52A0\u8F7D " + RELAY_UNIT + "\uFF0C\u8BF7\u5148\u914D\u7F6E\u5E76\u542F\u52A8\u4E2D\u7EE7\u670D\u52A1");
}
async function installTimer(config, stateDir) {
  await requireRelayUnit();
  const directory = unitDirectory();
  await mkdir(directory, { recursive: true, mode: 448 });
  const contents = timerContents(config, stateDir), hashes = Object.fromEntries(Object.entries(contents).map(([name, value]) => [name, digest(value)]));
  const manifestPath = join(directory, TIMER_MANIFEST), manifest = await readTimerManifest(directory);
  if (manifest) {
    if (manifest.units[TIMER_SERVICE] !== hashes[TIMER_SERVICE] || manifest.units[TIMER_UNIT] !== hashes[TIMER_UNIT]) fail("\u7EED\u671F timer \u5DF2\u5B89\u88C5\u4F46\u914D\u7F6E\u4E0D\u540C\uFF0C\u8BF7\u5148\u5378\u8F7D\u518D\u5B89\u88C5");
    for (const name of [TIMER_SERVICE, TIMER_UNIT]) {
      const current = await ownedFile(join(directory, name), manifest.units[name], name);
      if (!current) await createOwnedFile(join(directory, name), contents[name]);
    }
  } else {
    for (const name of [TIMER_SERVICE, TIMER_UNIT]) {
      try {
        await lstat(join(directory, name));
        fail(name + " \u5DF2\u5B58\u5728\u4E14\u4E0D\u5C5E\u4E8E\u672C\u5DE5\u5177\uFF0C\u62D2\u7EDD\u8986\u76D6");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    let serviceCreated = false, timerCreated = false;
    try {
      await createOwnedFile(join(directory, TIMER_SERVICE), contents[TIMER_SERVICE]);
      serviceCreated = true;
      await createOwnedFile(join(directory, TIMER_UNIT), contents[TIMER_UNIT]);
      timerCreated = true;
      await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, tool: "dsh-link-ip-certificate", units: hashes }) + "\n", { mode: 384, flag: "wx" });
    } catch (error) {
      if (timerCreated) await rm(join(directory, TIMER_UNIT), { force: true });
      if (serviceCreated) await rm(join(directory, TIMER_SERVICE), { force: true });
      throw error;
    }
  }
  await systemd(["daemon-reload"]);
  await systemd(["enable", "--now", TIMER_UNIT]);
}
async function uninstallTimer() {
  const directory = unitDirectory(), manifest = await readTimerManifest(directory);
  if (!manifest) {
    for (const name of [TIMER_SERVICE, TIMER_UNIT]) {
      try {
        await lstat(join(directory, name));
        fail(name + " \u5B58\u5728\u4F46\u6CA1\u6709\u672C\u5DE5\u5177\u5F52\u5C5E\u6E05\u5355\uFF0C\u62D2\u7EDD\u5220\u9664");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return false;
  }
  for (const name of [TIMER_SERVICE, TIMER_UNIT]) await ownedFile(join(directory, name), manifest.units[name], name);
  await systemd(["disable", "--now", TIMER_UNIT]);
  for (const name of [TIMER_SERVICE, TIMER_UNIT]) await rm(join(directory, name), { force: true });
  await rm(join(directory, TIMER_MANIFEST));
  await systemd(["daemon-reload"]);
  return true;
}
async function markRelayReloadPending(root) {
  const path = join(root, "relay-reload-pending");
  try {
    await writeFile(path, "pending\n", { mode: 384, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 63) !== 0) fail("\u4E2D\u7EE7 reload \u6807\u8BB0\u6587\u4EF6\u6743\u9650\u6216\u7C7B\u578B\u65E0\u6548");
  }
}
async function reloadRelayIfPending(root) {
  const path = join(root, "relay-reload-pending");
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 63) !== 0) fail("\u4E2D\u7EE7 reload \u6807\u8BB0\u6587\u4EF6\u6743\u9650\u6216\u7C7B\u578B\u65E0\u6548");
  await systemd(["try-restart", RELAY_UNIT]);
  await rm(path);
  return true;
}
function command(binary, args, { timeout = 20 * 60 * 1e3, env = process.env, label = "Certbot" } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "", stderr = "", settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolvePromise(value);
    };
    const append = (current, data) => (current + data.toString()).slice(-16e3);
    child.stdout.on("data", (data) => {
      stdout = append(stdout, data);
    });
    child.stderr.on("data", (data) => {
      stderr = append(stderr, data);
    });
    child.once("error", (error) => finish(new Error(error.code === "ENOENT" ? label === "Certbot" ? "\u672A\u627E\u5230 Certbot\uFF0C\u8BF7\u5148\u624B\u52A8\u5B89\u88C5 Certbot 5.4 \u6216\u66F4\u9AD8\u7248\u672C" : "\u672A\u627E\u5230 " + label : label + " \u65E0\u6CD5\u542F\u52A8\uFF1A" + error.message)));
    child.once("close", (code) => code === 0 ? finish(null, { stdout, stderr }) : finish(new Error(label + " \u6267\u884C\u5931\u8D25\uFF08" + code + "\uFF09\uFF1A" + (stderr.trim() || stdout.trim()).slice(-1200))));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(label + " \u64CD\u4F5C\u8D85\u65F6"));
    }, timeout);
    timer.unref?.();
  });
}
async function certbotVersion(binary) {
  const { stdout, stderr } = await command(binary, ["--version"], { timeout: 15e3 });
  const match = (stdout + stderr).match(/certbot\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!match || compareVersion(match.slice(1).map(Number), MIN_CERTBOT) < 0) fail("IP webroot \u8BC1\u4E66\u9700\u8981 Certbot 5.4.0 \u6216\u66F4\u9AD8\u7248\u672C");
  return match.slice(1).join(".");
}
function compareVersion(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
var owned = (dir) => join(dir, TOOL_DIR);
var markerPath = (dir) => join(owned(dir), "managed.json");
async function readMarker(dir) {
  try {
    const path = markerPath(dir), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 63) !== 0) fail("\u8BC1\u4E66\u72B6\u6001\u5F52\u5C5E\u6807\u8BB0\u6743\u9650\u65E0\u6548");
    const marker = JSON.parse(await readFile(path, "utf8"));
    if (marker.schemaVersion !== 1 || marker.tool !== "dsh-link-ip-certificate") fail("\u8BC1\u4E66\u72B6\u6001\u76EE\u5F55\u5F52\u5C5E\u6807\u8BB0\u65E0\u6548");
    return marker;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function ensureOwnedDir(dir) {
  const path = owned(dir);
  try {
    await mkdir(path, { mode: 448 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 63) !== 0) fail("\u8BC1\u4E66\u72B6\u6001\u76EE\u5F55\u5FC5\u987B\u662F\u4EC5\u5F53\u524D\u7528\u6237\u53EF\u8BBF\u95EE\u7684\u771F\u5B9E\u76EE\u5F55");
  let marker = await readMarker(dir);
  if (!marker) {
    if ((await readdir(path)).length) fail("\u8BC1\u4E66\u72B6\u6001\u76EE\u5F55\u5DF2\u6709\u975E\u672C\u5DE5\u5177\u6570\u636E\uFF0C\u62D2\u7EDD\u63A5\u7BA1");
    marker = { schemaVersion: 1, tool: "dsh-link-ip-certificate" };
    await writeFile(markerPath(dir), JSON.stringify(marker) + "\n", { mode: 384, flag: "wx" });
  }
  return path;
}
async function saveMarker(stateDir, value) {
  const path = markerPath(stateDir), temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 384, flag: "wx" });
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
function certbotArgs(operation, config, root, hasLineage = false) {
  const common = ["--non-interactive", "--agree-tos", "--no-eff-email", "--email", config.email, "--config-dir", join(root, "certbot"), "--work-dir", join(root, "work"), "--logs-dir", join(root, "logs")];
  if (operation === "issue") return ["certonly", "--authenticator", "webroot", "--webroot-path", config.webroot, "--preferred-challenges", "http", "--ip-address", config.ip, "--preferred-profile", "shortlived", "--cert-name", CERT_NAME, ...common];
  if (operation === "dry-run") return hasLineage ? ["renew", "--cert-name", CERT_NAME, "--webroot-path", config.webroot, "--preferred-profile", "shortlived", "--dry-run", ...common] : ["certonly", "--authenticator", "webroot", "--webroot-path", config.webroot, "--preferred-challenges", "http", "--ip-address", config.ip, "--preferred-profile", "shortlived", "--cert-name", CERT_NAME, "--dry-run", ...common];
  return ["renew", "--cert-name", CERT_NAME, "--webroot-path", config.webroot, "--preferred-profile", "shortlived", ...common];
}
async function readCertificate(certPath, keyPath, ip, { allowExpired = false } = {}) {
  const [cert, key] = await Promise.all([readFile(certPath, "utf8"), readFile(keyPath, "utf8")]);
  let certificate;
  try {
    certificate = new X509Certificate(cert);
    if (!certificate.checkPrivateKey(createPrivateKey(key))) fail("\u8BC1\u4E66\u4E0E\u79C1\u94A5\u4E0D\u5339\u914D");
  } catch (error) {
    if (/证书与私钥/.test(error.message)) throw error;
    fail("Certbot \u8FD4\u56DE\u7684\u8BC1\u4E66\u6216\u79C1\u94A5\u65E0\u6548");
  }
  if (!certificate.checkIP(ip)) fail("\u7B7E\u53D1\u8BC1\u4E66\u7684 IP \u4E0E\u914D\u7F6E\u4E0D\u5339\u914D");
  const notBefore = Date.parse(certificate.validFrom), notAfter = Date.parse(certificate.validTo), now = Date.now();
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notBefore > now + 5 * 6e4 || !allowExpired && notAfter <= now) fail("\u8BC1\u4E66\u5C1A\u672A\u751F\u6548\u6216\u5DF2\u7ECF\u8FC7\u671F");
  return { cert, key, notBefore: new Date(notBefore).toISOString(), notAfter: new Date(notAfter).toISOString(), daysRemaining: Math.floor((notAfter - now) / 864e5), expired: notAfter <= now };
}
async function activePaths(root) {
  const active = join(root, "active");
  let target;
  try {
    target = await readlink(active);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("\u6D3B\u52A8\u8BC1\u4E66\u8DEF\u5F84\u4E0D\u662F\u672C\u5DE5\u5177\u521B\u5EFA\u7684\u94FE\u63A5");
  }
  if (!/^releases\/[A-Za-z0-9-]+$/.test(target)) fail("\u6D3B\u52A8\u8BC1\u4E66\u94FE\u63A5\u6307\u5411\u72B6\u6001\u76EE\u5F55\u4E4B\u5916");
  const release = join(root, target);
  const actual = await realpath(release).catch(() => fail("\u6D3B\u52A8\u8BC1\u4E66\u7248\u672C\u76EE\u5F55\u7F3A\u5931"));
  if (!actual.startsWith(join(root, "releases") + "/")) fail("\u6D3B\u52A8\u8BC1\u4E66\u7248\u672C\u76EE\u5F55\u8D8A\u754C");
  return { cert: join(actual, "fullchain.pem"), key: join(actual, "privkey.pem"), link: target };
}
async function publish(root, data, ip) {
  const releases = join(root, "releases");
  await mkdir(releases, { recursive: true, mode: 448 });
  const id = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-") + "-" + process.pid;
  const release = join(releases, id);
  await mkdir(release, { mode: 448 });
  try {
    await writeFile(join(release, "fullchain.pem"), data.cert, { mode: 420, flag: "wx" });
    await writeFile(join(release, "privkey.pem"), data.key, { mode: 384, flag: "wx" });
    await writeFile(join(release, "metadata.json"), JSON.stringify({ ip, notBefore: data.notBefore, notAfter: data.notAfter }) + "\n", { mode: 384, flag: "wx" });
    const active = join(root, "active"), current = await activePaths(root), temp = join(root, ".active-" + process.pid + "-" + Date.now());
    await symlink("releases/" + id, temp);
    try {
      await rename(temp, active);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return { cert: join(active, "fullchain.pem"), key: join(active, "privkey.pem"), release: "releases/" + id, previous: current?.link };
  } catch (error) {
    await rm(release, { recursive: true, force: true });
    throw error;
  }
}
function output(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
async function main() {
  const parsed = options(process.argv.slice(2));
  const { operation, values } = parsed;
  if (operation === "uninstall-timer") {
    output({ state: await uninstallTimer() ? "timer-removed" : "timer-not-installed" });
    return;
  }
  const stateDir = await stateDirectory(values["--state-dir"], { create: !["status", "install-timer"].includes(operation) });
  if (!stateDir) {
    if (operation === "install-timer") fail("\u8BF7\u5148\u6210\u529F\u7B7E\u53D1\u8BC1\u4E66\uFF0C\u518D\u5B89\u88C5\u81EA\u52A8\u7EED\u671F");
    output({ state: "not-configured" });
    return;
  }
  const root = owned(stateDir), marker = await readMarker(stateDir);
  if (operation === "install-timer") {
    if (!marker?.config) fail("\u8BF7\u5148\u6210\u529F\u7B7E\u53D1\u8BC1\u4E66\uFF0C\u518D\u5B89\u88C5\u81EA\u52A8\u7EED\u671F");
    const saved = marker.config;
    const config2 = validateConfig({ ip: saved.ip, email: saved.email, webroot: saved.webroot, stateDir, challengePort: 80, relayPort: saved.relayPort, confirmPublicIp: true, certbot: saved.certbot });
    config2.webroot = await existingDirectory(config2.webroot, "webroot", true);
    const paths = await activePaths(root);
    if (!paths) fail("\u5C1A\u65E0\u672C\u5DE5\u5177\u7BA1\u7406\u7684\u6709\u6548\u8BC1\u4E66\uFF0C\u8BF7\u5148\u8FD0\u884C issue");
    await readCertificate(paths.cert, paths.key, config2.ip, { allowExpired: true });
    await installTimer(config2, stateDir);
    output({ state: "timer-installed", timer: TIMER_UNIT, relayUnit: RELAY_UNIT });
    return;
  }
  if (operation === "status") {
    if (!marker) {
      output({ state: "not-configured" });
      return;
    }
    const config2 = marker.config;
    if (!config2) {
      output({ state: "not-configured" });
      return;
    }
    const paths = await activePaths(root);
    if (!paths) {
      output({ state: "certificate-missing", config: config2 });
      return;
    }
    const data = await readCertificate(paths.cert, paths.key, config2.ip, { allowExpired: true });
    output({ state: data.expired ? "expired" : "ready", ...config2, notBefore: data.notBefore, notAfter: data.notAfter, daysRemaining: data.daysRemaining, cert: paths.cert, key: paths.key, renewalRecommended: data.daysRemaining <= 2 });
    return;
  }
  const config = validateConfig({ ip: values["--ip"], email: values["--email"], webroot: values["--webroot"], stateDir, challengePort: portNumber(values["--challenge-port"]), relayPort: portNumber(values["--relay-port"]), confirmPublicIp: values["--confirm-public-ip"] === "true", certbot: values["--certbot"] });
  config.webroot = await existingDirectory(config.webroot, "webroot", true);
  if (operation === "renew" && (!marker?.config || !await activePaths(root))) fail("\u5C1A\u65E0\u672C\u5DE5\u5177\u7BA1\u7406\u7684\u6709\u6548\u8BC1\u4E66\uFF0C\u8BF7\u5148\u8FD0\u884C issue");
  if (marker?.config && marker.config.ip !== config.ip) fail("\u540C\u4E00\u8BC1\u4E66\u72B6\u6001\u76EE\u5F55\u4E0D\u80FD\u66F4\u6362 IP\uFF0C\u8BF7\u4E3A\u65B0 IP \u4F7F\u7528\u72EC\u7ACB\u72B6\u6001\u76EE\u5F55");
  if (marker?.config && operation !== "issue" && (marker.config.webroot !== config.webroot || marker.config.relayPort !== config.relayPort)) fail("\u7EED\u671F\u914D\u7F6E\u5FC5\u987B\u4E0E\u5F53\u524D\u8BC1\u4E66\u7684 webroot \u548C\u4E2D\u7EE7\u7AEF\u53E3\u4E00\u81F4");
  const version = await certbotVersion(config.certbot);
  const managed = await ensureOwnedDir(stateDir);
  if (operation === "dry-run") {
    let hasLineage = false;
    try {
      await access(join(managed, "certbot/live", CERT_NAME, "fullchain.pem"));
      hasLineage = true;
    } catch {
    }
    await command(config.certbot, certbotArgs("dry-run", config, managed, hasLineage));
    await saveMarker(stateDir, { schemaVersion: 1, tool: "dsh-link-ip-certificate", certbot: version, config: { ip: config.ip, email: config.email, webroot: config.webroot, challengePort: 80, relayPort: config.relayPort, certbot: config.certbot } });
    output({ state: "dry-run-passed", certbot: version, challenge: "http-01", challengePort: 80, relayPort: config.relayPort });
    return;
  }
  const previousPaths = operation === "renew" ? await activePaths(root) : null;
  const previous = previousPaths ? await readCertificate(previousPaths.cert, previousPaths.key, config.ip, { allowExpired: true }) : null;
  await mkdir(join(managed, "certbot"), { recursive: true, mode: 448 });
  await mkdir(join(managed, "work"), { recursive: true, mode: 448 });
  await mkdir(join(managed, "logs"), { recursive: true, mode: 448 });
  await command(config.certbot, certbotArgs(operation, config, managed));
  const raw = await readCertificate(join(managed, "certbot/live", CERT_NAME, "fullchain.pem"), join(managed, "certbot/live", CERT_NAME, "privkey.pem"), config.ip);
  const changed = operation === "issue" || !previous || previous.cert !== raw.cert || previous.key !== raw.key;
  if (!changed) {
    if (values["--restart-relay-unit"]) await reloadRelayIfPending(root);
    output({ state: "ready", changed: false, certbot: version, challenge: "http-01", challengePort: 80, relayPort: config.relayPort, ip: config.ip, notBefore: raw.notBefore, notAfter: raw.notAfter, daysRemaining: raw.daysRemaining, cert: previousPaths.cert, key: previousPaths.key });
    return;
  }
  const nextMarker = { schemaVersion: 1, tool: "dsh-link-ip-certificate", certbot: version, config: { ip: config.ip, email: config.email, webroot: config.webroot, challengePort: 80, relayPort: config.relayPort, certbot: config.certbot } };
  await saveMarker(stateDir, nextMarker);
  const published = await publish(managed, raw, config.ip);
  if (values["--restart-relay-unit"]) {
    await markRelayReloadPending(root);
    await reloadRelayIfPending(root);
  }
  output({ state: "ready", changed: true, certbot: version, challenge: "http-01", challengePort: 80, relayPort: config.relayPort, ip: config.ip, notBefore: raw.notBefore, notAfter: raw.notAfter, daysRemaining: raw.daysRemaining, cert: published.cert, key: published.key });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write((error?.message ?? "\u8BC1\u4E66\u64CD\u4F5C\u5931\u8D25") + "\n");
    process.exitCode = 1;
  });
}
export {
  validateConfig
};
