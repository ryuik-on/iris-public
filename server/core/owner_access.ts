import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const localSessionTokenPath = () => path.join(os.homedir(), 'Library/Application Support/IRIS/local-session-token');

export function localAuthHeaders(base = 'http://127.0.0.1:3002'): Record<string, string> {
  const u = new URL(base);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.port !== '3002' || u.username || u.password) {
    throw new Error('端末の認証情報は IRIS のローカル接続にしか使えません。');
  }
  const token = fs.readFileSync(localSessionTokenPath(), 'utf8').trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function localApiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(localAuthHeaders(url))) headers.set(name, value);
  return fetch(url, { ...init, headers, redirect: 'error' });
}

/** An owner-authenticated launcher lends one browser a short, single-use ticket. */
export class LaunchTickets {
  private tickets = new Map<string, number>();
  constructor(private now = () => Date.now()) {}
  mint(): string {
    for (const [ticket, expires] of this.tickets) if (expires <= this.now()) this.tickets.delete(ticket);
    if (this.tickets.size >= 16) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, this.now() + 30_000);
    return ticket;
  }
  redeem(ticket: unknown): boolean {
    if (typeof ticket !== 'string') return false;
    const expires = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return expires !== undefined && expires > this.now();
  }
}
