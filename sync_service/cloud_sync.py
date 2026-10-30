import os
import json
import time
import base64
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional, Tuple

import requests

from sync_service.excel_manager import ExcelManager, DEFAULT_EXCEL_PATH

_HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(_HERE, "cloud_config.json")
GITHUB_META_PATH = os.path.join(_HERE, "github_meta.json")

GITHUB_API = "https://api.github.com"
COLLECTIONS = ("transactions", "accounts", "categories", "recurring")
VOLATILE_KEYS = {"current_balance", "updated_at"}
TOMBSTONE_TTL_MS = 365 * 24 * 60 * 60 * 1000


def load_cloud_config() -> Dict[str, Any]:
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "provider": "none",  # "github", "supabase", "webhook", "none"
        "supabase_url": "",
        "supabase_key": "",
        "webhook_url": "",
        "github_owner": "",
        "github_repo": "financas-data",
        "github_branch": "main",
        "github_path": "data/financas.json",
        "github_token": "",
    }


def save_cloud_config(config: Dict[str, Any]) -> Dict[str, Any]:
    current = load_cloud_config()
    current.update(config)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(current, f, indent=2, ensure_ascii=False)
    return current


# =============================================================================
# GITHUB (CLOUD 24/7): merge por id + updated_at, igual ao da app web (github-cloud.js)
# =============================================================================
class GitConflict(Exception):
    """Alguém escreveu no repositório entretanto (sha desatualizado)."""


def _normalize(value: Any) -> Any:
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: _normalize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalize(v) for v in value]
    return value


def _stable(value: Any) -> str:
    return json.dumps(_normalize(value), sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def entity_sig(entity: Dict[str, Any]) -> str:
    return _stable({k: v for k, v in entity.items() if k not in VOLATILE_KEYS})


def _empty_map() -> Dict[str, Dict[str, Any]]:
    return {c: {} for c in COLLECTIONS}


def new_meta(repo_key: str = "") -> Dict[str, Any]:
    return {
        "repo_key": repo_key,
        "initialized": False,
        "max_stamp": 0,
        "seen": _empty_map(),
        "stamps": _empty_map(),
        "tombstones": _empty_map(),
    }


def load_meta(repo_key: str, path: str = GITHUB_META_PATH) -> Dict[str, Any]:
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if raw.get("repo_key") == repo_key:
                meta = new_meta(repo_key)
                meta["initialized"] = bool(raw.get("initialized"))
                meta["max_stamp"] = int(raw.get("max_stamp") or 0)
                for key in ("seen", "stamps", "tombstones"):
                    for col in COLLECTIONS:
                        meta[key][col] = dict((raw.get(key) or {}).get(col) or {})
                return meta
        except Exception:
            pass
    return new_meta(repo_key)


def save_meta(meta: Dict[str, Any], path: str = GITHUB_META_PATH) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)


def max_stamp(snapshot: Optional[Dict[str, Any]]) -> int:
    """Maior carimbo (updated_at ou lápide) existente num snapshot."""
    top = 0.0
    if not snapshot:
        return 0
    for col in COLLECTIONS:
        for e in snapshot.get(col) or []:
            try:
                top = max(top, float(e.get("updated_at") or 0))
            except (TypeError, ValueError):
                pass
        for ts in ((snapshot.get("tombstones") or {}).get(col) or {}).values():
            try:
                top = max(top, float(ts or 0))
            except (TypeError, ValueError):
                pass
    return int(top)


def stamp_local_changes(state: Dict[str, List[Dict[str, Any]]], meta: Dict[str, Any], now_ms: int) -> None:
    """Carimba alterações do Excel desde a última sincronização e regista remoções (lápides).

    Relógio híbrido: nunca fica abaixo do maior carimbo já visto, para que um relógio
    adiantado noutro dispositivo não faça esse dispositivo "ganhar" para sempre.
    """
    clock = max(now_ms, int(meta.get("max_stamp") or 0) + 1)
    changed = False
    for col in COLLECTIONS:
        seen, stamps, tombs = meta["seen"][col], meta["stamps"][col], meta["tombstones"][col]
        present = set()
        for entity in state.get(col, []):
            if entity.get("id") in (None, ""):
                continue
            eid = str(entity["id"])
            present.add(eid)
            sig = entity_sig(entity)
            if not meta["initialized"]:
                seen[eid] = sig
                stamps.setdefault(eid, 0)
            elif seen.get(eid) != sig:
                seen[eid] = sig
                stamps[eid] = clock
                changed = True
            entity["updated_at"] = stamps.get(eid, 0)
        if meta["initialized"]:
            for eid in list(seen.keys()):
                if eid not in present:
                    del seen[eid]
                    stamps.pop(eid, None)
                    tombs[eid] = clock
                    changed = True
    if changed:
        meta["max_stamp"] = clock
    meta["initialized"] = True


def merge_snapshots(local: Dict[str, Any], remote: Optional[Dict[str, Any]], now_ms: Optional[int] = None) -> Dict[str, Any]:
    """Ganha o `updated_at` maior (empate: remoto); lápide >= updated_at apaga; mais recente ressuscita."""
    remote = remote or {}
    clock = now_ms if now_ms is not None else int(time.time() * 1000)
    out: Dict[str, Any] = {"tombstones": {}}

    def stamp(e: Dict[str, Any]) -> float:
        try:
            return float(e.get("updated_at") or 0)
        except (TypeError, ValueError):
            return 0.0

    for col in COLLECTIONS:
        tomb: Dict[str, float] = {}
        for src in ((local.get("tombstones") or {}).get(col) or {}, (remote.get("tombstones") or {}).get(col) or {}):
            for eid, ts in src.items():
                tomb[eid] = max(tomb.get(eid, 0), float(ts or 0))

        merged: Dict[str, Dict[str, Any]] = {}
        for e in remote.get(col) or []:
            if e.get("id") not in (None, ""):
                merged[str(e["id"])] = e
        for e in local.get(col) or []:
            if e.get("id") in (None, ""):
                continue
            key = str(e["id"])
            current = merged.get(key)
            if current is None or stamp(e) > stamp(current):
                merged[key] = e

        items = []
        for key, entity in merged.items():
            if key in tomb and tomb[key] >= stamp(entity):
                continue
            items.append(entity)
            tomb.pop(key, None)

        for eid in list(tomb.keys()):
            if tomb[eid] > 0 and clock - tomb[eid] > TOMBSTONE_TTL_MS:
                del tomb[eid]

        out[col] = items
        out["tombstones"][col] = {k: (int(v) if float(v).is_integer() else v) for k, v in tomb.items()}
    if isinstance(remote.get("quick_amounts"), list):
        out["quick_amounts"] = remote["quick_amounts"]
        out["quick_amounts_updated_at"] = int(remote.get("quick_amounts_updated_at") or 0)
    elif isinstance(local.get("quick_amounts"), list):
        out["quick_amounts"] = local["quick_amounts"]
        out["quick_amounts_updated_at"] = int(local.get("quick_amounts_updated_at") or 0)
    return out


def canonical(snapshot: Dict[str, Any]) -> str:
    view: Dict[str, Any] = {"tombstones": {}}
    if isinstance(snapshot.get("quick_amounts"), list):
        view["quick_amounts"] = snapshot["quick_amounts"]
        view["quick_amounts_updated_at"] = int(snapshot.get("quick_amounts_updated_at") or 0)
    for col in COLLECTIONS:
        view[col] = sorted(snapshot.get(col) or [], key=lambda e: str(e.get("id")))
        view["tombstones"][col] = (snapshot.get("tombstones") or {}).get(col) or {}
    return _stable(view)


def same_content(a: Optional[Dict[str, Any]], b: Optional[Dict[str, Any]]) -> bool:
    if a is None or b is None:
        return False
    return canonical(a) == canonical(b)


class GitHubRepoStore:
    """Cliente mínimo da Contents API do GitHub para um único ficheiro JSON."""

    def __init__(self, cfg: Dict[str, Any]):
        self.owner = str(cfg.get("github_owner") or "").strip()
        self.repo = str(cfg.get("github_repo") or "").strip()
        self.branch = str(cfg.get("github_branch") or "main").strip() or "main"
        self.path = str(cfg.get("github_path") or "data/financas.json").strip().lstrip("/")
        self.token = str(cfg.get("github_token") or "").strip()

    def is_configured(self) -> bool:
        return bool(self.owner and self.repo and self.token)

    def repo_key(self) -> str:
        return f"{self.owner}/{self.repo}@{self.branch}:{self.path}"

    def _headers(self, accept: str = "application/vnd.github+json") -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "Accept": accept}

    def _repo_url(self) -> str:
        return f"{GITHUB_API}/repos/{self.owner}/{self.repo}"

    def _contents_url(self) -> str:
        return f"{self._repo_url()}/contents/{self.path}"

    @staticmethod
    def _explain(status: int) -> str:
        if status == 401:
            return "Token GitHub inválido ou expirado."
        if status == 403:
            return "Sem permissão (ou limite de pedidos). O token precisa de 'Contents: Read and write'."
        if status == 404:
            return "Repositório não encontrado. Confirma utilizador, nome do repositório e permissões do token."
        return f"Erro do GitHub ({status})."

    def check_repo(self) -> Dict[str, Any]:
        res = requests.get(self._repo_url(), headers=self._headers(), timeout=20)
        if not res.ok:
            raise RuntimeError(self._explain(res.status_code))
        info = res.json()
        perms = info.get("permissions") or {}
        return {
            "private": bool(info.get("private")),
            "can_write": bool(perms.get("push") or perms.get("admin")),
            "full_name": info.get("full_name"),
        }

    def read(self) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        res = requests.get(self._contents_url(), headers=self._headers(), params={"ref": self.branch}, timeout=30)
        if res.status_code == 404:
            self.check_repo()  # levanta erro claro se o repositório não existir
            return None, None
        if not res.ok:
            raise RuntimeError(self._explain(res.status_code))
        info = res.json()
        if info.get("content") and info.get("encoding") == "base64":
            text = base64.b64decode(info["content"]).decode("utf-8")
        else:
            raw = requests.get(
                self._contents_url(),
                headers=self._headers("application/vnd.github.raw+json"),
                params={"ref": self.branch},
                timeout=60,
            )
            if not raw.ok:
                raise RuntimeError(self._explain(raw.status_code))
            text = raw.content.decode("utf-8")
        try:
            return json.loads(text), info.get("sha")
        except ValueError:
            raise RuntimeError("O ficheiro na cloud está corrompido. Não foi alterado.")

    def write(self, snapshot: Dict[str, Any], sha: Optional[str], message: str) -> None:
        body = {
            "message": message,
            "content": base64.b64encode(json.dumps(snapshot, ensure_ascii=False, indent=1).encode("utf-8")).decode("ascii"),
            "branch": self.branch,
        }
        if sha:
            body["sha"] = sha
        res = requests.put(self._contents_url(), headers=self._headers(), json=body, timeout=60)
        if res.status_code in (409, 422):
            raise GitConflict()
        if not res.ok:
            raise RuntimeError(self._explain(res.status_code))


def _read_excel_state(excel: ExcelManager) -> Dict[str, List[Dict[str, Any]]]:
    accounts = [{k: v for k, v in a.items() if k != "current_balance"} for a in excel.get_accounts()]
    return {
        "transactions": excel.get_all_transactions(),
        "accounts": accounts,
        "categories": excel.get_categories(),
        "recurring": excel.get_recurring(),
    }


def _same_tx(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    def txt(v: Any) -> str:
        return "" if v is None else str(v)

    keys = ("date", "type", "account", "to_account", "category", "payment_method")
    return (
        all(txt(a.get(k)) == txt(b.get(k)) for k in keys)
        and txt(a.get("description")).strip() == txt(b.get("description")).strip()
        and txt(a.get("time"))[:5] == txt(b.get("time"))[:5]
        and round(float(a.get("amount") or 0), 2) == round(float(b.get("amount") or 0), 2)
    )


_CATALOG_FIELDS = {
    "accounts": ("name", "initial_balance", "description"),
    "categories": ("name", "type", "budget", "chips"),
    "recurring": ("description", "type", "category", "account", "amount", "day_of_month", "active", "last_processed_month"),
}


def _same_catalog(col: str, a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    def norm(field: str, v: Any) -> Any:
        if field == "chips":
            if isinstance(v, str):
                v = [c.strip() for c in v.split(",") if c.strip()]
            return [str(c) for c in (v or [])]
        if field in ("initial_balance", "budget", "amount"):
            return round(float(v or 0), 2)
        if field == "day_of_month":
            return int(v or 1)
        if field == "active":
            return bool(True if v is None else v)
        return "" if v is None else str(v)

    return all(norm(f, a.get(f)) == norm(f, b.get(f)) for f in _CATALOG_FIELDS[col])


def _tx_payload(t: Dict[str, Any]) -> Dict[str, Any]:
    keys = ("id", "date", "time", "type", "account", "to_account", "category", "description", "amount", "payment_method", "month_year")
    return {k: t.get(k) for k in keys if k in t}


def apply_to_excel(excel: ExcelManager, merged: Dict[str, Any]) -> Dict[str, int]:
    """Faz o Excel refletir o estado fundido (a cloud é a fonte de verdade)."""
    stats = {"added": 0, "updated": 0, "deleted": 0}

    # Transações: adições em lote (1 gravação), edições/remoções individuais.
    current = {str(t["id"]): t for t in excel.get_all_transactions()}
    merged_ids = set()
    to_add = []
    for t in merged.get("transactions") or []:
        tid = str(t["id"])
        merged_ids.add(tid)
        cur = current.get(tid)
        if cur is None:
            to_add.append(_tx_payload(t))
        elif not _same_tx(cur, t):
            excel.update_transaction(tid, _tx_payload(t))
            stats["updated"] += 1
    if to_add:
        excel.sync_transactions_batch(to_add)
        stats["added"] += len(to_add)
    for tid in current:
        if tid not in merged_ids:
            if excel.delete_transaction(tid):
                stats["deleted"] += 1

    # Contas, categorias e recorrentes.
    catalogs = {
        "accounts": (excel.get_accounts, excel.save_account, excel.delete_account),
        "categories": (excel.get_categories, excel.save_category, excel.delete_category),
        "recurring": (excel.get_recurring, excel.save_recurring, excel.delete_recurring),
    }
    for col, (getter, saver, deleter) in catalogs.items():
        merged_items = merged.get(col) or []
        if col in ("accounts", "categories") and not merged_items:
            continue  # nunca esvaziar contas/categorias
        existing = {str(e["id"]): e for e in getter()}
        merged_ids = set()
        for item in merged_items:
            eid = str(item["id"])
            merged_ids.add(eid)
            cur = existing.get(eid)
            if cur is None or not _same_catalog(col, cur, item):
                saver({k: v for k, v in item.items() if k not in VOLATILE_KEYS})
                stats["updated" if cur is not None else "added"] += 1
        for eid in existing:
            if eid not in merged_ids:
                if deleter(eid):
                    stats["deleted"] += 1
    return stats


def _refresh_meta_after_apply(excel: ExcelManager, merged: Dict[str, Any], meta: Dict[str, Any]) -> None:
    """Depois de aplicar, o que está no Excel passa a ser o 'visto' (evita falsas alterações)."""
    state = _read_excel_state(excel)
    for col in COLLECTIONS:
        ts_by_id = {str(e["id"]): e.get("updated_at") or 0 for e in merged.get(col) or []}
        meta["seen"][col] = {}
        meta["stamps"][col] = {}
        for entity in state[col]:
            eid = str(entity["id"])
            meta["seen"][col][eid] = entity_sig(entity)
            meta["stamps"][col][eid] = ts_by_id.get(eid, 0)
    meta["tombstones"] = {col: dict((merged.get("tombstones") or {}).get(col) or {}) for col in COLLECTIONS}
    meta["max_stamp"] = max(int(meta.get("max_stamp") or 0), max_stamp(merged))
    meta["initialized"] = True


def sync_with_github(
    excel: ExcelManager,
    cfg: Optional[Dict[str, Any]] = None,
    store: Optional[Any] = None,
    meta_path: str = GITHUB_META_PATH,
    now_ms: Optional[int] = None,
) -> Dict[str, Any]:
    """Sincronização bidirecional Excel <-> GitHub. Devolve contagens do que mudou no Excel."""
    cfg = cfg or load_cloud_config()
    store = store or GitHubRepoStore(cfg)
    if not store.is_configured():
        return {"status": "skipped", "reason": "GitHub não configurado (utilizador, repositório e token)."}

    if isinstance(store, GitHubRepoStore):
        info = store.check_repo()
        if not info["private"]:
            raise RuntimeError("O repositório de dados é PÚBLICO. Torna-o privado antes de sincronizar.")
        if not info["can_write"]:
            raise RuntimeError("O token não tem permissão de escrita no repositório.")

    meta = load_meta(store.repo_key(), meta_path)
    now = now_ms if now_ms is not None else int(time.time() * 1000)

    for _ in range(4):
        remote, sha = store.read()
        meta["max_stamp"] = max(int(meta.get("max_stamp") or 0), max_stamp(remote))
        state = _read_excel_state(excel)
        stamp_local_changes(state, meta, now)
        local = dict(state)
        local["tombstones"] = meta["tombstones"]
        merged = merge_snapshots(local, remote, now)

        if remote is None or not same_content(merged, remote):
            to_write = dict(merged)
            to_write.update(
                {
                    "app": "financas-pessoais",
                    "version": 1,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                    "updated_by": "PC (Excel)",
                }
            )
            to_write["transactions"] = sorted(
                merged["transactions"], key=lambda t: (t.get("date") or "", t.get("time") or "", str(t.get("id"))), reverse=True
            )
            try:
                store.write(to_write, sha, "Atualização do PC (Excel)")
            except GitConflict:
                continue

        stats = apply_to_excel(excel, merged)
        _refresh_meta_after_apply(excel, merged, meta)
        save_meta(meta, meta_path)
        return {"status": "ok", "provider": "github", **stats, "total": len(merged["transactions"])}

    raise RuntimeError("Conflito repetido na cloud. Tenta novamente.")


class CloudSyncService:
    def __init__(self, excel_manager: Optional[ExcelManager] = None):
        self.excel = excel_manager or ExcelManager(DEFAULT_EXCEL_PATH)

    def pull_from_cloud(self) -> Dict[str, Any]:
        """Puxa dados da Cloud (GitHub, Supabase ou Google Apps Script Webhook) e guarda no Excel local."""
        cfg = load_cloud_config()
        provider = cfg.get("provider", "none")

        if provider == "github":
            return sync_with_github(self.excel, cfg)

        if provider == "supabase" and cfg.get("supabase_url") and cfg.get("supabase_key"):
            url = f"{cfg['supabase_url'].rstrip('/')}/rest/v1/transactions?select=*&order=date.desc"
            headers = {
                "apikey": cfg["supabase_key"],
                "Authorization": f"Bearer {cfg['supabase_key']}",
            }
            resp = requests.get(url, headers=headers, timeout=15)
            resp.raise_for_status()
            cloud_txs = resp.json()
            result = self.excel.sync_transactions_batch(cloud_txs)
            return {"status": "ok", "provider": "supabase", **result}

        elif provider == "webhook" and cfg.get("webhook_url"):
            resp = requests.get(cfg["webhook_url"], timeout=15)
            resp.raise_for_status()
            data = resp.json()
            cloud_txs = data if isinstance(data, list) else data.get("transactions", [])
            result = self.excel.sync_transactions_batch(cloud_txs)
            return {"status": "ok", "provider": "webhook", **result}

        return {"status": "skipped", "reason": "Nenhum fornecedor cloud configurado ainda."}

    def push_to_cloud(self, tx: Dict[str, Any]) -> Dict[str, Any]:
        """Envia uma transação para a Cloud 24/7 se configurada."""
        cfg = load_cloud_config()
        provider = cfg.get("provider", "none")

        if provider == "github":
            # No modo GitHub é a própria app (browser) que sincroniza; o servidor só espelha o Excel.
            return {"status": "deferred", "provider": "github"}

        if provider == "supabase" and cfg.get("supabase_url") and cfg.get("supabase_key"):
            url = f"{cfg['supabase_url'].rstrip('/')}/rest/v1/transactions"
            headers = {
                "apikey": cfg["supabase_key"],
                "Authorization": f"Bearer {cfg['supabase_key']}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates",
            }
            resp = requests.post(url, headers=headers, json=tx, timeout=10)
            resp.raise_for_status()
            return {"status": "synced", "provider": "supabase"}

        elif provider == "webhook" and cfg.get("webhook_url"):
            resp = requests.post(cfg["webhook_url"], json={"action": "add", "transaction": tx}, timeout=10)
            resp.raise_for_status()
            return {"status": "synced", "provider": "webhook"}

        return {"status": "local_only"}


if __name__ == "__main__":
    import sys
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    print("A sincronizar dados da Cloud com o ficheiro Gestao_Financeira.xlsx...")
    service = CloudSyncService()
    try:
        res = service.pull_from_cloud()
        if res.get("status") == "ok" and res.get("provider") == "github":
            print(
                "Sincronizacao concluida! "
                f"Novas no Excel: {res.get('added', 0)} | Atualizadas: {res.get('updated', 0)} | "
                f"Apagadas: {res.get('deleted', 0)} | Total de movimentos: {res.get('total', 0)}"
            )
            print(f"Ficheiro Excel atualizado em: {service.excel.excel_path}")
        elif res.get("status") == "ok":
            print(f"Sincronizacao concluida! Novas transacoes adicionadas ao Excel: {res.get('added', 0)} (Total: {res.get('total', 0)})")
        else:
            print(f"Info: {res.get('reason')}")
            print(f"Ficheiro Excel verificado em: {service.excel.excel_path}")
    except Exception as e:
        print(f"Erro ao sincronizar com a cloud: {e}")
