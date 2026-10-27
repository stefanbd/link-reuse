export function allowsLearning(value, policy) {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > policy.maxURLBytes) return false;
  try {
    const url = new URL(value);
    const normalized = value => value.toLowerCase().replace(/[-_]/g, '');
    const sensitivePath = value => value.split(/[/?&=#!]/).some(part => policy.blockedPathSegments.includes(normalized(part)));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        policy.blockedHostPrefixes.some(prefix => url.hostname.startsWith(prefix)) || sensitivePath(decodeURIComponent(url.pathname))) return false;
    const fragment = decodeURIComponent(url.hash.slice(1));
    if (fragment.includes('=') || fragment.includes('?') || sensitivePath(fragment)) return false;
    for (const key of url.searchParams.keys()) {
      const name = normalized(key);
      if (policy.blockedQueryKeys.includes(name) || policy.blockedQueryPrefixes.some(prefix => name.startsWith(prefix))) return false;
    }
    return true;
  } catch { return false; }
}

export class PendingObservations {
  constructor(policy) { this.policy = policy; this.items = new Map(); this.bytes = 0; this.sequence = 0; this.dropped = 0; }
  add(record) {
    if (!allowsLearning(record.source, this.policy) || (record.destination !== null && !allowsLearning(record.destination, this.policy))) return;
    const key = record.kind + '\n' + record.source;
    const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
    this.remove(key);
    if (bytes > this.policy.maxPendingBytes) { this.dropped++; return; }
    this.items.set(key, { key, sequence: ++this.sequence, bytes, record });
    this.bytes += bytes;
    while (this.items.size > this.policy.maxPendingRecords || this.bytes > this.policy.maxPendingBytes) {
      this.remove(this.items.keys().next().value);
      this.dropped++;
    }
  }
  remove(key) { const old = this.items.get(key); if (old) { this.bytes -= old.bytes; this.items.delete(key); } }
  batch() { return [...this.items.values()].slice(0, this.policy.maxBatchRecords); }
  acknowledge(items) { for (const item of items) if (this.items.get(item.key)?.sequence === item.sequence) this.remove(item.key); }
  clear() { this.items.clear(); this.bytes = 0; }
}
