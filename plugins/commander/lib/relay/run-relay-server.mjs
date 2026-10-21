// plugins/link/scripts/run-relay-server.mjs
import { readFile, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";

// plugins/link/src/transport/relay-server.mjs
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createSecureServer } from "node:http2";
import { WebSocketServer } from "ws";

// plugins/link/src/transport/relay-protocol.mjs
var RELAY_CONTROL_PATH = "/__link/relay/control";
var RELAY_DATA_PATH = "/__link/relay/data";
var RELAY_WORKBENCH_PATH = "/link/workbench/";
var RELAY_VOICE_PATH = "/link/workbench/api/voice/realtime";
var RELAY_CHUNK_BYTES = 48 * 1024;
function relayPathAllowed(method, path) {
  if (typeof method !== "string" || typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /%(?:2f|5c|00)/i.test(path)) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(path.split("?")[0]);
  } catch {
    return false;
  }
  if (decoded.split("/").some((part) => part === "." || part === "..")) return false;
  const pathname = path.split("?")[0];
  if (pathname === "/link/api/info") return method === "GET";
  if (["/link/api/pair", "/link/api/pair/status", "/link/api/rpc", "/link/api/workbench"].includes(pathname)) return method === "POST";
  if (["/link", "/link/", "/link/index.html", "/link/app.js", "/link/app.css"].includes(pathname)) return method === "GET" || method === "HEAD";
  if (!pathname.startsWith(RELAY_WORKBENCH_PATH) || !["GET", "HEAD", "POST"].includes(method)) return false;
  const route = pathname.slice(RELAY_WORKBENCH_PATH.length);
  return !/^(?:api\/commander-(?:link|devices)|api\/(?:owner|admin)(?:\/|$))/i.test(route);
}

// plugins/link/src/transport/relay-server.mjs
var MAX_BUFFERED = 256 * 1024;
var MAX_STREAM_BYTES = 512 * 1024 * 1024;
var fail = (message, status = 400) => Object.assign(new Error(message), { status });
var digest = (value) => createHash("sha256").update(value).digest("hex");
var same = (a, b) => {
  const left = Buffer.from(digest(a));
  const right = Buffer.from(digest(b));
  return left.length === right.length && timingSafeEqual(left, right);
};
var json = (ws, value) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(value));
var workbenchCookie = (value) => typeof value === "string" ? value.split(";").map((item) => item.trim()).filter((item) => item.startsWith("dsh_link_workbench=")).join("; ") : "";
var send = async (ws, data, options) => {
  while (ws.readyState === ws.OPEN && ws.bufferedAmount > MAX_BUFFERED) await new Promise((resolve2) => setTimeout(resolve2, 5));
  if (ws.readyState !== ws.OPEN) throw new Error("\u4E2D\u7EE7\u901A\u9053\u5DF2\u5173\u95ED");
  await new Promise((resolve2, reject) => ws.send(data, options ?? {}, (error) => error ? reject(error) : resolve2()));
};
var requestHeaders = (headers, path) => {
  const result = {};
  for (const key of ["accept", "accept-language", "content-type", "content-length", "range", "if-none-match", "if-modified-since", "cookie"]) {
    if (typeof headers[key] === "string") result[key] = key === "cookie" ? workbenchCookie(headers[key]) : headers[key];
  }
  if (["/link/api/rpc", "/link/api/workbench"].includes(path) && typeof headers.authorization === "string") result.authorization = headers.authorization;
  return result;
};
var responseHeaders = (headers) => {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== void 0 && !["connection", "keep-alive", "transfer-encoding", "upgrade"].includes(key)) result[key] = value;
  }
  return result;
};
async function createRelayServer({ host = "0.0.0.0", port, identity, publicUrl, token, onError = () => {
} }) {
  if (!identity?.key || !identity?.cert) throw new Error("\u4E2D\u7EE7 TLS \u8BC1\u4E66\u65E0\u6548");
  if (typeof token !== "string" || token.length < 32 || token.length > 256) throw new Error("\u4E2D\u7EE7\u4E3B\u673A\u5BC6\u94A5\u81F3\u5C11\u9700\u8981 32 \u4E2A\u5B57\u7B26");
  const publicOrigin = new URL(publicUrl);
  if (publicOrigin.protocol !== "https:" || publicOrigin.origin !== publicUrl || publicOrigin.username || publicOrigin.password) throw new Error("\u4E2D\u7EE7\u516C\u7F51\u5730\u5740\u5FC5\u987B\u662F\u72EC\u7ACB HTTPS origin");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("\u4E2D\u7EE7\u76D1\u542C\u7AEF\u53E3\u65E0\u6548");
  let closed = false, activeHost;
  const tickets = /* @__PURE__ */ new Map(), transactions = /* @__PURE__ */ new Set(), sockets = /* @__PURE__ */ new Set();
  const controls = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const data = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  const voice = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const securityHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
  const ticket = () => {
    const value = randomBytes(32).toString("base64url");
    tickets.set(digest(value), { value, expires: Date.now() + 15e3 });
    return value;
  };
  const openTicket = (value) => {
    if (typeof value !== "string" || value.length > 128) return;
    const key = digest(value), entry = tickets.get(key);
    tickets.delete(key);
    if (!entry || entry.expires < Date.now() || !same(value, entry.value)) return;
    return entry;
  };
  const remove = (transaction) => {
    clearTimeout(transaction.attachTimer);
    clearTimeout(transaction.voiceTimer);
    tickets.delete(digest(transaction.ticket));
    transactions.delete(transaction);
  };
  const makeTransaction = (req, res, method, path, headers, kind = "http") => {
    if (!activeHost || activeHost.readyState !== activeHost.OPEN) throw fail("\u76EE\u6807\u8BBE\u5907\u79BB\u7EBF", 503);
    if (transactions.size >= 64) throw fail("\u4E2D\u7EE7\u8FDE\u63A5\u6570\u5DF2\u6EE1", 429);
    const value = ticket();
    let resolveData, rejectData;
    const dataReady = new Promise((resolve2, reject) => {
      resolveData = resolve2;
      rejectData = reject;
    });
    dataReady.catch(() => {
    });
    const transaction = { ticket: value, req, res, method, path, headers, kind, socket: void 0, dataReady, resolveData, rejectData, host: activeHost };
    transactions.add(transaction);
    req.once("close", () => {
      if (!req.complete) transaction.socket?.close(1001, "request closed");
    });
    res?.once("close", () => {
      if (!res.writableEnded) transaction.socket?.close(1001, "client closed");
    });
    const attachTimer = setTimeout(() => {
      remove(transaction);
      rejectData(new Error("\u4E3B\u673A\u63A5\u5165\u8D85\u65F6"));
      if (transaction.rawSocket && !transaction.rawSocket.destroyed) transaction.rawSocket.end("HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }, 15e3);
    attachTimer.unref?.();
    transaction.attachTimer = attachTimer;
    return transaction;
  };
  const relayHttp = async (req, res, path) => {
    const query = new URL(req.url, publicOrigin).search;
    if (!relayPathAllowed(req.method, path + query)) throw fail("Link \u8DEF\u5F84\u672A\u6388\u6743", 404);
    if (req.headers.origin && req.headers.origin !== publicOrigin.origin) throw fail("\u6765\u6E90\u672A\u6388\u6743", 403);
    const transaction = makeTransaction(req, res, req.method, path + query, requestHeaders(req.headers, path));
    json(activeHost, { type: "http", ticket: transaction.ticket, method: transaction.method, path: transaction.path, headers: transaction.headers });
    let timer = setTimeout(() => transaction.socket?.close(1011, "relay timeout"), 12e4);
    timer.unref?.();
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => transaction.socket?.close(1011, "relay timeout"), 12e4);
      timer.unref?.();
    };
    let requestBytes = 0, responseBytes = 0;
    try {
      transaction.socket = await transaction.dataReady;
      if (transaction.socket.readyState !== transaction.socket.OPEN) throw new Error("\u4E2D\u7EE7\u6570\u636E\u901A\u9053\u5DF2\u5173\u95ED");
      transaction.socket.on("message", (raw, binary) => {
        if (binary) {
          if (!res.headersSent) {
            transaction.socket.close(1002, "response headers missing");
            return;
          }
          responseBytes += raw.length;
          if (responseBytes > MAX_STREAM_BYTES) {
            transaction.socket.close(1009, "response too large");
            return;
          }
          touch();
          if (!res.write(raw)) {
            transaction.socket.pause();
            res.once("drain", () => transaction.socket?.resume());
          }
          return;
        }
        let frame;
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          transaction.socket.close(1002, "invalid frame");
          return;
        }
        if (frame.type === "response" && !res.headersSent && Number.isInteger(frame.status) && frame.status >= 100 && frame.status <= 599 && frame.headers && typeof frame.headers === "object") res.writeHead(frame.status, { ...responseHeaders(frame.headers), ...securityHeaders });
        else if (frame.type === "end") {
          clearTimeout(timer);
          if (!res.headersSent) res.writeHead(502, securityHeaders);
          res.end();
          remove(transaction);
          transaction.socket.close(1e3);
        } else if (frame.type === "error") {
          clearTimeout(timer);
          if (!res.headersSent) {
            res.writeHead(502, securityHeaders);
            res.end("\u76EE\u6807\u8BBE\u5907\u8BF7\u6C42\u5931\u8D25");
          } else res.destroy();
          remove(transaction);
          transaction.socket.close();
        } else {
          transaction.socket.close(1002, "unexpected frame");
        }
      });
      transaction.socket.once("close", () => {
        clearTimeout(timer);
        if (transactions.has(transaction)) {
          if (!res.headersSent) {
            res.writeHead(502, securityHeaders);
            res.end("\u76EE\u6807\u8BBE\u5907\u8FDE\u63A5\u4E2D\u65AD");
          } else if (!res.writableEnded) res.destroy();
          remove(transaction);
        }
      });
      for await (const chunk of req) {
        requestBytes += chunk.length;
        if (requestBytes > MAX_STREAM_BYTES) throw fail("\u8BF7\u6C42\u8FC7\u5927", 413);
        touch();
        for (let offset = 0; offset < chunk.length; offset += RELAY_CHUNK_BYTES) await send(transaction.socket, chunk.subarray(offset, offset + RELAY_CHUNK_BYTES), { binary: true });
      }
      json(transaction.socket, { type: "request-end" });
    } catch (error) {
      clearTimeout(timer);
      remove(transaction);
      transaction.socket?.close(1009, "request aborted");
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(error.status ?? 502, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
        res.end(error.status ? error.message : "\u76EE\u6807\u8BBE\u5907\u8FDE\u63A5\u4E2D\u65AD");
      }
    }
  };
  const server = createSecureServer({ key: identity.key, cert: identity.cert, minVersion: "TLSv1.2", allowHTTP1: true }, (req, res) => {
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
    try {
      const authority = req.headers[":authority"] || req.headers.host;
      if (closed || authority !== publicOrigin.host) throw fail("\u4E2D\u7EE7\u5730\u5740\u672A\u6388\u6743", 403);
      const raw = req.url || "/";
      if (!relayPathAllowed(req.method, raw)) throw fail("Link \u8DEF\u5F84\u672A\u6388\u6743", 404);
      const url = new URL(raw, publicOrigin);
      if (url.origin !== publicOrigin.origin || !(url.pathname === "/link" || url.pathname.startsWith("/link/"))) throw fail("Link \u8DEF\u5F84\u672A\u6388\u6743", 404);
      void relayHttp(req, res, url.pathname).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(error.status ?? 502, { ...securityHeaders, ...headers });
          res.end(error.status ? error.message : "\u76EE\u6807\u8BBE\u5907\u8FDE\u63A5\u5931\u8D25");
        } else res.destroy();
      });
    } catch (error) {
      res.writeHead(error.status ?? 400, headers);
      res.end(error.message);
    }
  });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {
    });
    const reject = (status) => socket.end(`HTTP/1.1 ${status} Rejected\r
Connection: close\r
Content-Length: 0\r
\r
`);
    if (req.url === RELAY_CONTROL_PATH) {
      const supplied2 = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (!supplied2 || !same(supplied2, token)) {
        socket.destroy();
        return;
      }
      if (closed || req.headers.host !== publicOrigin.host || req.headers.origin && req.headers.origin !== publicOrigin.origin) return reject(403);
      controls.handleUpgrade(req, socket, head, (ws) => {
        const previous = activeHost;
        activeHost = ws;
        previous?.close(1012, "host replaced");
        ws.on("message", () => ws.close(1008, "control messages are server initiated"));
        ws.on("error", () => {
        });
        ws.once("close", () => {
          if (activeHost === ws) activeHost = void 0;
          for (const entry2 of transactions) if (entry2.host === ws) {
            entry2.data?.close(1011, "host disconnected");
            entry2.browser?.close(1011, "host disconnected");
            entry2.rejectData?.(new Error("\u4E3B\u673A\u5DF2\u65AD\u5F00"));
            entry2.res?.destroy();
            entry2.rawSocket?.destroy();
            remove(entry2);
          }
        });
      });
      return;
    }
    if (req.url !== RELAY_DATA_PATH) {
      if (req.url !== RELAY_VOICE_PATH || req.headers.host !== publicOrigin.host || req.headers.origin !== publicOrigin.origin || closed || !activeHost || activeHost.readyState !== activeHost.OPEN) return reject(403);
      let transaction;
      try {
        transaction = makeTransaction(req, void 0, "GET", RELAY_VOICE_PATH, {}, "voice");
      } catch (error) {
        return reject(error.status ?? 502);
      }
      transaction.rawSocket = socket;
      json(activeHost, { type: "voice", ticket: transaction.ticket, path: RELAY_VOICE_PATH, cookie: workbenchCookie(req.headers.cookie).slice(0, 4096) });
      transaction.attachVoice = (dataSocket) => {
        clearTimeout(transaction.attachTimer);
        transaction.data = dataSocket;
        const timeout = transaction.voiceTimer = setTimeout(() => {
          if (!transaction.browser) {
            reject(504);
            remove(transaction);
            dataSocket.terminate();
          }
        }, 12e3);
        timeout.unref?.();
        dataSocket.on("message", (raw, binary) => {
          if (!transaction.browser) {
            if (binary) {
              dataSocket.close(1002, "unexpected voice data");
              return;
            }
            let frame;
            try {
              frame = JSON.parse(raw.toString());
            } catch {
              dataSocket.close(1002, "invalid voice handshake");
              return;
            }
            if (frame.type !== "voice-ready") {
              dataSocket.close(1002, "invalid voice handshake");
              return;
            }
            clearTimeout(timeout);
            voice.handleUpgrade(req, socket, head, (browser) => {
              transaction.browser = browser;
              browser.on("message", (value, isBinary) => {
                const payload = Buffer.from(value), framed = Buffer.allocUnsafe(payload.length + 1);
                framed[0] = isBinary ? 1 : 0;
                payload.copy(framed, 1);
                if (dataSocket.readyState !== dataSocket.OPEN || dataSocket.bufferedAmount + framed.length > MAX_BUFFERED * 4) {
                  browser.close(1009, "voice buffer full");
                  return;
                }
                dataSocket.send(framed, { binary: true });
              });
              dataSocket.on("message", (value, isBinary) => {
                if (!isBinary) {
                  dataSocket.close(1002, "invalid voice payload");
                  return;
                }
                const payload = Buffer.from(value);
                if (payload.length < 1 || payload[0] > 1 || browser.readyState !== browser.OPEN || browser.bufferedAmount + payload.length > MAX_BUFFERED * 4) {
                  browser.close(1009, "voice frame invalid");
                  return;
                }
                browser.send(payload.subarray(1), { binary: payload[0] === 1 });
              });
              const close = () => {
                browser.terminate();
                dataSocket.terminate();
                remove(transaction);
              };
              browser.once("close", close);
              dataSocket.once("close", close);
              browser.on("error", close);
              dataSocket.on("error", close);
            });
          }
        });
        dataSocket.once("close", () => {
          clearTimeout(timeout);
          if (!transaction.browser) reject(502);
          remove(transaction);
          socket.destroy();
        });
      };
      return;
    }
    if (closed || req.headers.host !== publicOrigin.host || req.headers.origin && req.headers.origin !== publicOrigin.origin) return reject(403);
    const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const entry = openTicket(supplied);
    if (!entry) {
      socket.destroy();
      return;
    }
    data.handleUpgrade(req, socket, head, (ws) => {
      const transaction = [...transactions].find((value) => value.ticket === entry.value);
      if (!transaction) {
        ws.close(1008);
        return;
      }
      clearTimeout(transaction.attachTimer);
      transaction.data = ws;
      transaction.socket = ws;
      transaction.resolveData(ws);
      if (transaction.kind === "voice") transaction.attachVoice(ws);
      ws.on("error", () => {
        transaction.res?.destroy();
        transaction.rawSocket?.destroy();
        remove(transaction);
      });
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.requestTimeout = 0;
  server.headersTimeout = 15e3;
  server.keepAliveTimeout = 1e4;
  await new Promise((resolve2, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve2();
    });
  });
  server.on("error", onError);
  return {
    port: server.address().port,
    origin: publicOrigin.origin,
    async close() {
      closed = true;
      activeHost?.close(1001, "relay closed");
      for (const transaction of transactions) {
        transaction.data?.close(1001, "relay closed");
        transaction.browser?.close(1001, "relay closed");
        transaction.res?.destroy();
        transaction.rawSocket?.destroy();
        transaction.rejectData?.(new Error("relay closed"));
        remove(transaction);
      }
      tickets.clear();
      const done = new Promise((resolve2) => server.close(resolve2));
      for (const socket of sockets) socket.destroy();
      controls.close();
      data.close();
      voice.close();
      await done;
    }
  };
}
var relayRoutes = Object.freeze({ control: RELAY_CONTROL_PATH, data: RELAY_DATA_PATH, workbench: RELAY_WORKBENCH_PATH, voice: RELAY_VOICE_PATH });

// plugins/link/scripts/run-relay-server.mjs
var fail2 = (message) => {
  process.stderr.write(message + "\n");
  process.exitCode = 1;
};
var args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--config") {
  fail2("\u7528\u6CD5: node run-relay-server.mjs --config /path/to/relay.json");
} else {
  let relay;
  try {
    const configPath = resolve(args[1]), configStat = await stat(configPath);
    if (configStat.mode & 63 || typeof process.getuid === "function" && configStat.uid !== process.getuid()) throw new Error("\u4E2D\u7EE7\u914D\u7F6E\u6587\u4EF6\u5FC5\u987B\u7531\u5F53\u524D\u670D\u52A1\u7528\u6237\u62E5\u6709\u4E14\u6743\u9650\u4E3A 0600");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (!Number.isInteger(config.port) || config.port < 2e4 || config.port > 49151) throw new Error("\u4E2D\u7EE7\u5FC5\u987B\u4F7F\u7528 20000\u201349151 \u7684\u4E13\u7528\u7AEF\u53E3");
    for (const field of ["keyFile", "certFile"]) if (typeof config[field] !== "string" || !config[field]) throw new Error("\u9700\u914D\u7F6E TLS keyFile \u4E0E certFile");
    const keyPath = resolve(dirname(configPath), config.keyFile), certPath = resolve(dirname(configPath), config.certFile);
    const keyStat = await stat(keyPath);
    if (keyStat.mode & 63 || typeof process.getuid === "function" && keyStat.uid !== process.getuid()) throw new Error("TLS \u79C1\u94A5\u5FC5\u987B\u7531\u5F53\u524D\u670D\u52A1\u7528\u6237\u62E5\u6709\u4E14\u6743\u9650\u4E3A 0600");
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
    relay = await createRelayServer({ host: config.host || "0.0.0.0", port: config.port, publicUrl: config.publicUrl, token: config.token, identity: { key, cert } });
    process.stdout.write(`Link \u81EA\u5EFA\u4E2D\u7EE7\u5DF2\u76D1\u542C ${relay.origin}\uFF0CTLS \u5728\u4E2D\u7EE7\u7EC8\u6B62\u3002
`);
    const stop = () => {
      void relay.close().finally(() => process.exit());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    fail2(error.message);
  }
}
