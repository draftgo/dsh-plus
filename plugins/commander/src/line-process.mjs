import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

// The child never owns a shell. Framing, request lifetime and process lifetime
// are shared; product methods belong to the individual provider adapters.
export class LineProcess extends EventEmitter {
  constructor(command, args, { cwd, env, dialect = 'jsonrpc', timeout = 30_000 } = {}) {
    super();
    this.dialect = dialect;
    this.timeout = timeout;
    this.pending = new Map();
    this.sequence = 0;
    this.tail = '';
    this.stderr = '';
    this.closed = false;
    this.child = spawn(command, args, {
      cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, detached: process.platform !== 'win32',
    });
    this.exited = new Promise(resolve => {
      this.child.once('close', (code, signal) => {
        this.fail(new Error(`Agent process exited (${code ?? signal})${this.stderr ? `: ${this.stderr.slice(-1500)}` : ''}`));
        resolve();
      });
    });
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-8192); });
    this.child.stdout.on('data', chunk => {
      this.tail += chunk;
      if (Buffer.byteLength(this.tail) > 16 * 1024 * 1024) {
        this.fail(new Error('Agent exceeded JSONL frame limit'));
        void this.close();
        return;
      }
      let end;
      while ((end = this.tail.indexOf('\n')) !== -1) {
        const line = this.tail.slice(0, end).trim();
        this.tail = this.tail.slice(end + 1);
        if (!line) continue;
        try { this.receive(JSON.parse(line)); }
        catch (error) { this.fail(new Error(`Invalid agent protocol: ${error.message}`)); void this.close(); return; }
      }
    });
  }

  receive(message) {
    const response = this.dialect === 'pi' ? message.type === 'response' : !message.method;
    const waiter = response && this.pending.get(message.id);
    if (waiter) {
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      const error = message.error || (message.success === false && 'Pi command failed');
      if (error) waiter.reject(new Error(typeof error === 'string' ? error : error.message ?? JSON.stringify(error)));
      else waiter.resolve(this.dialect === 'pi' ? message.data : message.result);
    } else if (this.dialect === 'jsonrpc' && message.method && message.id !== undefined) {
      this.emit('request', message);
    } else {
      this.emit('notification', message);
    }
  }

  send(message) {
    if (this.closed) throw new Error('Agent transport is closed');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params = {}, timeout = this.timeout) {
    if (this.closed) return Promise.reject(new Error('Agent transport is closed'));
    const id = `commander-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent request timed out: ${method}; execution outcome may be unknown`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(this.dialect === 'pi' ? { ...params, type: method, id } : { jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }

  notify(method, params = {}) { this.send({ jsonrpc: '2.0', method, params }); }
  respond(id, result) { this.send({ jsonrpc: '2.0', id, result }); }
  reject(id, message) { this.send({ jsonrpc: '2.0', id, error: { code: -32601, message } }); }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
    this.emit('failure', error);
  }

  kill(signal) {
    if (!this.child.pid) return;
    try {
      if (process.platform === 'win32') this.child.kill(signal);
      else process.kill(-this.child.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }

  async close() {
    this.fail(new Error('Agent transport closed'));
    this.child.stdin.end();
    this.kill('SIGTERM');
    const timer = setTimeout(() => this.kill('SIGKILL'), 1500);
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}
