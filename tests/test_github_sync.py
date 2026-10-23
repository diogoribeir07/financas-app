import os
import tempfile
import unittest

from sync_service.excel_manager import ExcelManager
from sync_service import cloud_sync as cs


class FakeStore:
    """Repositório GitHub simulado em memória (com controlo de versão por sha)."""

    def __init__(self, snapshot=None):
        self.snapshot = snapshot
        self.version = 0 if snapshot is None else 1
        self.writes = 0
        self.fail_next_write = False

    def is_configured(self):
        return True

    def repo_key(self):
        return "fake/repo@main:data/financas.json"

    def read(self):
        if self.snapshot is None:
            return None, None
        import copy
        return copy.deepcopy(self.snapshot), f"sha-{self.version}"

    def write(self, snapshot, sha, message):
        if self.fail_next_write:
            self.fail_next_write = False
            raise cs.GitConflict()
        expected = None if self.snapshot is None else f"sha-{self.version}"
        if sha != expected:
            raise cs.GitConflict()
        import copy
        self.snapshot = copy.deepcopy(snapshot)
        self.version += 1
        self.writes += 1


def tx(tid, amount, **extra):
    base = {
        "id": tid, "date": "2026-10-23", "time": "10:00", "type": "Despesa",
        "account": "Dinheiro Geral", "to_account": "", "category": "Alimentação",
        "description": "teste", "amount": amount, "payment_method": "MBWay", "month_year": "2026-10",
    }
    base.update(extra)
    return base


class TestMergeLogic(unittest.TestCase):
    def empty(self):
        return {"transactions": [], "accounts": [], "categories": [], "recurring": [], "tombstones": {}}

    def test_newest_wins_and_tie_goes_remote(self):
        local, remote = self.empty(), self.empty()
        local["transactions"] = [tx("A", 10, updated_at=3000)]
        remote["transactions"] = [tx("A", 20, updated_at=2000)]
        self.assertEqual(cs.merge_snapshots(local, remote, 4000)["transactions"][0]["amount"], 10)
        local["transactions"][0]["updated_at"] = 2000
        self.assertEqual(cs.merge_snapshots(local, remote, 4000)["transactions"][0]["amount"], 20)

    def test_tombstone_deletes_and_resurrection(self):
        local, remote = self.empty(), self.empty()
        local["transactions"] = [tx("A", 1, updated_at=1000)]
        remote["tombstones"] = {"transactions": {"A": 5000}}
        merged = cs.merge_snapshots(local, remote, 10000)
        self.assertEqual(merged["transactions"], [])
        local["transactions"][0]["updated_at"] = 9000
        merged = cs.merge_snapshots(local, remote, 10000)
        self.assertEqual(len(merged["transactions"]), 1)
        self.assertNotIn("A", merged["tombstones"]["transactions"])

    def test_union_and_ttl_pruning(self):
        local, remote = self.empty(), self.empty()
        local["transactions"] = [tx("L", 1, updated_at=10)]
        remote["transactions"] = [tx("R", 2, updated_at=20)]
        remote["tombstones"] = {"transactions": {"OLD": 1000}}
        merged = cs.merge_snapshots(local, remote, 500 * 24 * 3600 * 1000)
        self.assertEqual({t["id"] for t in merged["transactions"]}, {"L", "R"})
        self.assertNotIn("OLD", merged["tombstones"]["transactions"])

    def test_same_content_ignores_order_and_int_float(self):
        a, b = self.empty(), self.empty()
        a["transactions"] = [tx("A", 5.0), tx("B", 2)]
        b["transactions"] = [tx("B", 2.0), tx("A", 5)]
        self.assertTrue(cs.same_content(a, b))


class TestGithubExcelSync(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.excel = ExcelManager(os.path.join(self.tmp.name, "Gestao.xlsx"))
        self.meta_path = os.path.join(self.tmp.name, "meta.json")

    def tearDown(self):
        self.tmp.cleanup()

    def run_sync(self, store, now):
        return cs.sync_with_github(self.excel, cfg={}, store=store, meta_path=self.meta_path, now_ms=now)

    def test_first_push_creates_remote_with_excel_data(self):
        self.excel.add_transaction(tx("TX-1", 12.5))
        store = FakeStore()
        res = self.run_sync(store, 1000)
        self.assertEqual(res["status"], "ok")
        ids = {t["id"] for t in store.snapshot["transactions"]}
        self.assertIn("TX-1", ids)
        self.assertGreaterEqual(len(store.snapshot["accounts"]), 3)

    def test_phone_additions_edits_and_deletes_reach_excel(self):
        self.excel.add_transaction(tx("TX-PC", 5))
        self.excel.add_transaction(tx("TX-DEL", 9))
        store = FakeStore()
        self.run_sync(store, 1000)

        # iPhone: adiciona TX-PHONE, edita TX-PC, apaga TX-DEL
        snap = store.snapshot
        snap["transactions"].append(tx("TX-PHONE", 3.2, updated_at=2000))
        for t in snap["transactions"]:
            if t["id"] == "TX-PC":
                t["amount"] = 7.5
                t["updated_at"] = 2000
        snap["transactions"] = [t for t in snap["transactions"] if t["id"] != "TX-DEL"]
        snap["tombstones"]["transactions"]["TX-DEL"] = 2000
        store.version += 1

        res = self.run_sync(store, 3000)
        by_id = {t["id"]: t for t in self.excel.get_all_transactions()}
        self.assertIn("TX-PHONE", by_id)
        self.assertEqual(by_id["TX-PC"]["amount"], 7.5)
        self.assertNotIn("TX-DEL", by_id)
        self.assertEqual((res["added"], res["updated"], res["deleted"]), (1, 1, 1))

    def test_excel_changes_are_pushed_and_second_run_is_idempotent(self):
        self.excel.add_transaction(tx("TX-1", 10))
        store = FakeStore()
        self.run_sync(store, 1000)
        writes_after_first = store.writes

        self.excel.update_transaction("TX-1", {"amount": 11.0})
        self.excel.add_transaction(tx("TX-2", 4))
        self.run_sync(store, 2000)
        remote = {t["id"]: t for t in store.snapshot["transactions"]}
        self.assertEqual(remote["TX-1"]["amount"], 11.0)
        self.assertIn("TX-2", remote)
        self.assertEqual(store.writes, writes_after_first + 1)

        # Sem alterações: não deve escrever outra vez
        self.run_sync(store, 3000)
        self.assertEqual(store.writes, writes_after_first + 1)

    def test_excel_delete_creates_tombstone(self):
        self.excel.add_transaction(tx("TX-1", 10))
        self.excel.add_transaction(tx("TX-2", 4))
        store = FakeStore()
        self.run_sync(store, 1000)
        self.excel.delete_transaction("TX-1")
        self.run_sync(store, 2000)
        ids = {t["id"] for t in store.snapshot["transactions"]}
        self.assertNotIn("TX-1", ids)
        self.assertIn("TX-1", store.snapshot["tombstones"]["transactions"])

    def test_catalog_changes_from_phone_reach_excel(self):
        store = FakeStore()
        self.run_sync(store, 1000)
        snap = store.snapshot
        snap["accounts"].append(
            {"id": "poupanca", "name": "Poupança", "icon": "PO", "initial_balance": 50.0, "color": "#71717A", "description": "", "updated_at": 2000}
        )
        snap["categories"] = [c for c in snap["categories"] if c["id"] != "outros"]
        snap["tombstones"]["categories"]["outros"] = 2000
        store.version += 1
        self.run_sync(store, 3000)
        self.assertIn("Poupança", [a["name"] for a in self.excel.get_accounts()])
        self.assertNotIn("outros", [c["id"] for c in self.excel.get_categories()])

    def test_conflict_is_retried(self):
        self.excel.add_transaction(tx("TX-1", 10))
        store = FakeStore()
        store.fail_next_write = True
        res = self.run_sync(store, 1000)
        self.assertEqual(res["status"], "ok")
        self.assertIsNotNone(store.snapshot)


if __name__ == "__main__":
    unittest.main()
