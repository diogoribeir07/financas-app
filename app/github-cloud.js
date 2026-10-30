/*
 * github-cloud.js
 * Sincronização 24/7 da app de Finanças com um repositório PRIVADO do GitHub.
 *
 * - Guarda um único ficheiro JSON (data/financas.json) com transações, contas,
 *   categorias, recorrentes e "lápides" (tombstones) dos registos apagados.
 * - Faz merge entre dispositivos (PC + iPhone) por id + carimbo `updated_at`.
 * - Funciona em qualquer origem (localhost, IP local ou GitHub Pages) porque a
 *   API do GitHub aceita CORS.
 *
 * Expõe o objeto global `FinCloud`.
 */
(function (root) {
  "use strict";

  const COLLECTIONS = ["transactions", "accounts", "categories", "recurring"];
  const VOLATILE_KEYS = ["current_balance", "updated_at"];
  const TOMBSTONE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
  const SNAPSHOT_VERSION = 1;

  // ---------------------------------------------------------------------------
  // Utilitários puros (testáveis sem rede)
  // ---------------------------------------------------------------------------
  function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
    return (
      "{" +
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k]))
        .join(",") +
      "}"
    );
  }

  function entitySig(entity) {
    const copy = {};
    Object.keys(entity).forEach((k) => {
      if (!VOLATILE_KEYS.includes(k)) copy[k] = entity[k];
    });
    return stableStringify(copy);
  }

  function cleanEntity(entity) {
    const copy = Object.assign({}, entity);
    delete copy.current_balance;
    return copy;
  }

  function emptyCollectionMap() {
    const out = {};
    COLLECTIONS.forEach((c) => (out[c] = {}));
    return out;
  }

  function newMeta(repoKey) {
    return {
      repoKey: repoKey || "",
      initialized: false,
      maxStamp: 0,
      quickAmountsStamp: 0,
      seen: emptyCollectionMap(),
      tombstones: emptyCollectionMap()
    };
  }

  function normalizeMeta(meta, repoKey) {
    if (!meta || typeof meta !== "object" || (repoKey && meta.repoKey !== repoKey)) {
      return newMeta(repoKey);
    }
    const out = newMeta(meta.repoKey);
    out.initialized = !!meta.initialized;
    out.maxStamp = Number(meta.maxStamp) || 0;
    out.quickAmountsStamp = Number(meta.quickAmountsStamp) || 0;
    COLLECTIONS.forEach((c) => {
      out.seen[c] = Object.assign({}, (meta.seen || {})[c]);
      out.tombstones[c] = Object.assign({}, (meta.tombstones || {})[c]);
    });
    return out;
  }

  /** Maior carimbo (updated_at ou lápide) existente num snapshot. */
  function maxStamp(snapshot) {
    let max = 0;
    if (!snapshot) return max;
    const qaStamp = Number(snapshot.quick_amounts_updated_at) || 0;
    if (qaStamp > max) max = qaStamp;
    COLLECTIONS.forEach((col) => {
      (snapshot[col] || []).forEach((e) => {
        const v = Number(e && e.updated_at) || 0;
        if (v > max) max = v;
      });
      const tombs = (snapshot.tombstones || {})[col] || {};
      Object.keys(tombs).forEach((id) => {
        const v = Number(tombs[id]) || 0;
        if (v > max) max = v;
      });
    });
    return max;
  }

  /**
   * Deteta alterações locais desde a última vez que viu os dados e carimba-as.
   * - Entidades novas/editadas recebem updated_at = relógio.
   * - Entidades desaparecidas geram uma lápide com o mesmo relógio.
   * O relógio é "híbrido": nunca fica abaixo do maior carimbo já visto (meta.maxStamp),
   * por isso um dispositivo com a hora errada não consegue "ganhar" para sempre.
   * Na primeira chamada (meta.initialized = false) apenas "semeia" o estado,
   * com updated_at = 0, para que dados já existentes não ganhem a edições reais.
   * Devolve true se algo mudou.
   */
  function stampLocalChanges(data, meta, now) {
    let changed = false;
    const clock = Math.max(now, (Number(meta.maxStamp) || 0) + 1);
    COLLECTIONS.forEach((col) => {
      const seen = meta.seen[col];
      const present = new Set();
      (data[col] || []).forEach((e) => {
        if (!e || e.id === undefined || e.id === null) return;
        const id = String(e.id);
        present.add(id);
        const sig = entitySig(e);
        if (!meta.initialized) {
          seen[id] = sig;
          if (e.updated_at === undefined || e.updated_at === null) e.updated_at = 0;
          return;
        }
        if (seen[id] !== sig) {
          e.updated_at = clock;
          seen[id] = sig;
          changed = true;
        }
      });
      if (meta.initialized) {
        Object.keys(seen).forEach((id) => {
          if (!present.has(id)) {
            delete seen[id];
            meta.tombstones[col][id] = clock;
            changed = true;
          }
        });
      }
    });
    if (changed) meta.maxStamp = clock;
    meta.initialized = true;
    return changed;
  }

  /** Atualiza meta.seen com o estado atual (usado após aplicar um merge). */
  function markAllSeen(data, meta) {
    COLLECTIONS.forEach((col) => {
      meta.seen[col] = {};
      (data[col] || []).forEach((e) => {
        if (e && e.id !== undefined && e.id !== null) meta.seen[col][String(e.id)] = entitySig(e);
      });
    });
    meta.initialized = true;
  }

  function buildSnapshot(data, meta, deviceName) {
    const snap = {
      app: "financas-pessoais",
      version: SNAPSHOT_VERSION,
      updated_at: new Date().toISOString(),
      updated_by: deviceName || "",
      tombstones: {}
    };
    if (Array.isArray(data.quickAmounts) && data.quickAmounts.length > 0) {
      snap.quick_amounts = data.quickAmounts.map((n) => Number(n)).filter((n) => !Number.isNaN(n) && n !== 0);
      snap.quick_amounts_updated_at = Number(meta && meta.quickAmountsStamp) || 0;
    }
    COLLECTIONS.forEach((col) => {
      snap[col] = (data[col] || [])
        .filter((e) => e && e.id !== undefined && e.id !== null)
        .map(cleanEntity);
      snap.tombstones[col] = Object.assign({}, (meta.tombstones || {})[col]);
    });
    return snap;
  }

  /**
   * Merge de dois snapshots (local + remoto).
   * Regras por id:
   *  - ganha o registo com `updated_at` maior; em empate ganha o remoto;
   *  - uma lápide com timestamp >= updated_at apaga o registo;
   *  - um registo mais recente que a lápide "ressuscita" e remove a lápide.
   */
  function mergeSnapshots(local, remote, now) {
    local = local || {};
    remote = remote || {};
    const clock = now === undefined ? Date.now() : now;
    const out = {
      app: "financas-pessoais",
      version: SNAPSHOT_VERSION,
      tombstones: {}
    };
    const stamp = (e) => Number(e.updated_at) || 0;

    COLLECTIONS.forEach((col) => {
      const tomb = {};
      [(local.tombstones || {})[col] || {}, (remote.tombstones || {})[col] || {}].forEach((src) => {
        Object.keys(src).forEach((id) => {
          tomb[id] = Math.max(tomb[id] || 0, Number(src[id]) || 0);
        });
      });

      const map = new Map();
      (remote[col] || []).forEach((e) => {
        if (e && e.id !== undefined && e.id !== null) map.set(String(e.id), e);
      });
      (local[col] || []).forEach((e) => {
        if (!e || e.id === undefined || e.id === null) return;
        const key = String(e.id);
        const current = map.get(key);
        if (!current || stamp(e) > stamp(current)) map.set(key, e);
      });

      const items = [];
      map.forEach((entity, key) => {
        if (tomb[key] !== undefined && tomb[key] >= stamp(entity)) return;
        items.push(entity);
        if (tomb[key] !== undefined) delete tomb[key];
      });

      Object.keys(tomb).forEach((id) => {
        if (tomb[id] > 0 && clock - tomb[id] > TOMBSTONE_TTL_MS) delete tomb[id];
      });

      out[col] = items;
      out.tombstones[col] = tomb;
    });

    const lQa = Array.isArray(local.quick_amounts) ? local.quick_amounts : null;
    const rQa = Array.isArray(remote.quick_amounts) ? remote.quick_amounts : null;
    const lQaTs = Number(local.quick_amounts_updated_at) || 0;
    const rQaTs = Number(remote.quick_amounts_updated_at) || 0;
    if (lQa && rQa) {
      if (lQaTs > rQaTs) {
        out.quick_amounts = lQa;
        out.quick_amounts_updated_at = lQaTs;
      } else {
        out.quick_amounts = rQa;
        out.quick_amounts_updated_at = rQaTs;
      }
    } else if (rQa) {
      out.quick_amounts = rQa;
      out.quick_amounts_updated_at = rQaTs;
    } else if (lQa) {
      out.quick_amounts = lQa;
      out.quick_amounts_updated_at = lQaTs;
    }

    return out;
  }

  function sortTransactions(list) {
    return list.slice().sort((a, b) => {
      const ka = `${a.date || ""} ${a.time || ""} ${a.id}`;
      const kb = `${b.date || ""} ${b.time || ""} ${b.id}`;
      return ka < kb ? 1 : ka > kb ? -1 : 0;
    });
  }

  /** Forma canónica (ordem estável) para comparar snapshots sem ruído. */
  function canonical(snapshot) {
    const view = { tombstones: {} };
    if (Array.isArray(snapshot.quick_amounts)) {
      view.quick_amounts = snapshot.quick_amounts;
      view.quick_amounts_updated_at = Number(snapshot.quick_amounts_updated_at) || 0;
    }
    COLLECTIONS.forEach((col) => {
      view[col] = (snapshot[col] || [])
        .slice()
        .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
      view.tombstones[col] = (snapshot.tombstones || {})[col] || {};
    });
    return stableStringify(view);
  }

  function sameContent(a, b) {
    if (!a || !b) return false;
    return canonical(a) === canonical(b);
  }

  // ---------------------------------------------------------------------------
  // Base64 UTF-8
  // ---------------------------------------------------------------------------
  function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function fromBase64(b64) {
    const bin = atob(String(b64).replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ---------------------------------------------------------------------------
  // Cliente da API do GitHub (Contents API)
  // ---------------------------------------------------------------------------
  const API = "https://api.github.com";

  function makeError(message, status, extra) {
    const err = new Error(message);
    err.status = status;
    if (extra) Object.assign(err, extra);
    return err;
  }

  function explain(status, fallback) {
    if (status === 401) return "Token inválido ou expirado. Cria um novo token no GitHub.";
    if (status === 403) return "Sem permissão (ou limite de pedidos). O token precisa de 'Contents: Read and write' neste repositório.";
    if (status === 404) return "Repositório não encontrado. Confirma o utilizador, o nome do repositório e as permissões do token.";
    return fallback || `Erro do GitHub (${status}).`;
  }

  class GitHubStore {
    constructor(cfg) {
      this.owner = String(cfg.github_owner || "").trim();
      this.repo = String(cfg.github_repo || "").trim();
      this.branch = String(cfg.github_branch || "main").trim() || "main";
      this.path = String(cfg.github_path || "data/financas.json").trim().replace(/^\/+/, "");
      this.token = String(cfg.github_token || "").trim();
    }

    isConfigured() {
      return !!(this.owner && this.repo && this.token);
    }

    repoKey() {
      return `${this.owner}/${this.repo}@${this.branch}:${this.path}`;
    }

    _repoUrl() {
      return `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
    }

    _contentsUrl(withRef) {
      const p = this.path.split("/").map(encodeURIComponent).join("/");
      return `${this._repoUrl()}/contents/${p}` + (withRef ? `?ref=${encodeURIComponent(this.branch)}` : "");
    }

    async _request(method, url, body, accept) {
      const headers = {
        Authorization: `Bearer ${this.token}`,
        Accept: accept || "application/vnd.github+json"
      };
      const opts = { method, headers, cache: "no-store" };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
      }
      let res;
      try {
        res = await fetch(url, opts);
      } catch (e) {
        throw makeError("Sem ligação à internet.", 0, { offline: true });
      }
      return res;
    }

    /** Verifica o repositório: existência, permissões de escrita e se é privado. */
    async testConnection() {
      const res = await this._request("GET", this._repoUrl());
      if (!res.ok) throw makeError(explain(res.status), res.status);
      const info = await res.json();
      return {
        ok: true,
        isPrivate: !!info.private,
        canWrite: !!(info.permissions && (info.permissions.push || info.permissions.admin)),
        fullName: info.full_name
      };
    }

    /** Lê o snapshot. Devolve { snapshot: null, sha: null } se o ficheiro ainda não existe. */
    async read() {
      const res = await this._request("GET", this._contentsUrl(true));
      if (res.status === 404) {
        await this.testConnection(); // lança erro claro se o repo não existir
        return { snapshot: null, sha: null };
      }
      if (!res.ok) throw makeError(explain(res.status), res.status);
      const info = await res.json();
      let text;
      if (info.content && info.encoding === "base64") {
        text = fromBase64(info.content);
      } else {
        const raw = await this._request("GET", this._contentsUrl(true), undefined, "application/vnd.github.raw+json");
        if (!raw.ok) throw makeError(explain(raw.status), raw.status);
        text = await raw.text();
      }
      let snapshot;
      try {
        snapshot = JSON.parse(text);
      } catch (e) {
        throw makeError("O ficheiro na cloud está corrompido. Não foi alterado.", 0);
      }
      return { snapshot, sha: info.sha };
    }

    /** Escreve o snapshot. Em conflito (alguém escreveu entretanto) lança erro com .conflict = true. */
    async write(snapshot, sha, message) {
      const body = {
        message: message || "Atualização das finanças",
        content: toBase64(JSON.stringify(snapshot, null, 1)),
        branch: this.branch
      };
      if (sha) body.sha = sha;
      const res = await this._request("PUT", this._contentsUrl(false), body);
      if (res.status === 409 || res.status === 422) {
        throw makeError("Conflito de versão na cloud.", res.status, { conflict: true });
      }
      if (!res.ok) throw makeError(explain(res.status), res.status);
      const info = await res.json();
      return { sha: info.content && info.content.sha };
    }
  }

  root.FinCloud = {
    COLLECTIONS,
    stableStringify,
    entitySig,
    cleanEntity,
    newMeta,
    normalizeMeta,
    maxStamp,
    stampLocalChanges,
    markAllSeen,
    buildSnapshot,
    mergeSnapshots,
    sortTransactions,
    canonical,
    sameContent,
    toBase64,
    fromBase64,
    GitHubStore
  };
})(typeof window !== "undefined" ? window : globalThis);
