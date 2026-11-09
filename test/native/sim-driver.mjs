// Drives test/native/sim.c (the real glasses plugin on a fake Host) from Node.
import { spawn } from 'node:child_process';
import { CH_DOWN } from '../../phone/native-link.js';

const toHex = (bytes) => Buffer.from(bytes).toString('hex');

export class GlassesSim {
  static all = new Set();

  static killAll() {
    for (const sim of GlassesSim.all) sim.proc.kill();
    GlassesSim.all.clear();
  }

  constructor(exe) {
    this.proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    GlassesSim.all.add(this);
    this.buffer = '';
    this.waiters = [];
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      // Each response is zero or more lines followed by a line holding only ".".
      for (;;) {
        let body;
        if (this.buffer.startsWith('.\n')) {
          body = [];
          this.buffer = this.buffer.slice(2);
        } else {
          const end = this.buffer.indexOf('\n.\n');
          if (end < 0) break;
          body = this.buffer.slice(0, end).split('\n');
          this.buffer = this.buffer.slice(end + 3);
        }
        this.waiters.shift()?.(body);
      }
    });
  }

  cmd(line) {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.proc.stdin.write(`${line}\n`);
    });
  }

  /** Deliver phone -> glasses messages (as NativeLink would). */
  async down(bytes, channel = CH_DOWN) {
    return this.cmd(`down ${toHex(bytes)} ${channel}`);
  }

  /** Messages the glasses sent since the last call: [{ channel, bytes }]. */
  async sent() {
    const lines = await this.cmd('sent');
    return lines.filter((l) => l.startsWith('S ')).map((l) => {
      const [, channel, hex] = l.split(' ');
      return { channel: Number(channel), bytes: Uint8Array.from(Buffer.from(hex || '', 'hex')) };
    });
  }

  /** Visible labels and images, top to bottom. */
  async screen() {
    await this.cmd('time 60');  // let one frame run: the plugin coalesces redraws
    const lines = await this.cmd('screen');
    return lines.map((l) => {
      const [type, y, x, extra, ...rest] = l.split(' ');
      if (type === 'L') return { type: 'label', y: Number(y), x: Number(x), grey: Number(extra), text: rest.join(' ').replace(/\\n/g, '\n') };
      return { type: 'image', y: Number(y), x: Number(x), size: extra, hash: rest[0] };
    });
  }

  async text() {
    return (await this.screen()).filter((i) => i.type === 'label').map((i) => i.text).join('\n');
  }

  async close() {
    GlassesSim.all.delete(this);
    this.proc.stdin.end();
    await new Promise((resolve) => this.proc.on('close', resolve));
  }
}
