// @ts-check
"use strict";
/**
 * Your key, kept with the gateway it was saved for (no `vscode`, tested under node).
 *
 * There's one saved key. It used to go to whatever address the endpoint setting held, so typing a new gateway's
 * address sent the old gateway's key there at once (the models are listed as soon as the address is saved), before
 * you'd been asked for anything. A key now goes only to the gateway it was saved for: its scheme, host and port. For
 * any other, there's no key until you give one.
 */

/** A gateway as a key is tied to it: scheme, host and port ("" for an address that isn't one). @param {unknown} endpoint */
function gatewayOf(endpoint) {
  try {
    const url = new URL(String(endpoint ?? "").trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin.toLowerCase() : "";
  } catch { return ""; }
}

class SavedKey {
  /**
   * @param {{get(name: string): PromiseLike<string | undefined>, store(name: string, value: string): PromiseLike<void>, delete(name: string): PromiseLike<void>}} secrets
   *   VS Code's secret storage
   * @param {string} name the secret's name; the gateway it's for is kept beside it
   * @param {() => {endpoint: string, trusted?: boolean}} now the endpoint as it's set now, and whether your organization
   *   sets it (then the key follows the address: it's theirs to move)
   */
  constructor(secrets, name, now) {
    this.secrets = secrets;
    this.name = name;
    this.forName = name + ".gateway";
    this.now = now;
  }

  /** Whether any key is saved, whichever gateway it's for. */
  async any() {
    return !!((await this.secrets.get(this.name)) ?? "");
  }

  /**
   * The key for a gateway (the one set now, unless given): "" when none is saved, or the one saved is another
   * gateway's. A key saved before Solder kept the gateway with it is taken as this gateway's, once.
   * @param {string} [endpoint]
   */
  async get(endpoint) {
    const set = this.now();
    const gateway = gatewayOf(endpoint ?? set.endpoint);
    const key = (await this.secrets.get(this.name)) ?? "";
    if (!key || !gateway) return "";
    const saved = (await this.secrets.get(this.forName)) ?? "";
    if (saved === gateway) return key;
    // Your organization's address (and only the one it sets) takes the key with it.
    const follows = !!set.trusted && gateway === gatewayOf(set.endpoint);
    if (saved && !follows) return "";
    await this.secrets.store(this.forName, gateway);
    return key;
  }

  /** Whether a key is saved, but for another gateway than this one (so this one has none yet). @param {string} [endpoint] */
  async elsewhere(endpoint) {
    if (!gatewayOf(endpoint ?? this.now().endpoint)) return false; // no gateway set: nothing to be another's
    return (await this.any()) && !(await this.get(endpoint));
  }

  /** Save a key for a gateway (the one set now, unless given); "" removes the saved key. @param {string} key @param {string} [endpoint] */
  async save(key, endpoint) {
    const value = String(key ?? "").trim();
    if (!value) { await this.secrets.delete(this.name); await this.secrets.delete(this.forName); return; }
    const gateway = gatewayOf(endpoint ?? this.now().endpoint);
    await this.secrets.store(this.name, value);
    // No gateway set yet: the key is the first one's.
    if (gateway) await this.secrets.store(this.forName, gateway);
    else await this.secrets.delete(this.forName);
  }
}

module.exports = { SavedKey, gatewayOf };
