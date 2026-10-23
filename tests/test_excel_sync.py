import os
import tempfile
import unittest
import openpyxl
from sync_service.excel_manager import ExcelManager, DEFAULT_EXCEL_PATH


class TestExcelMultiAccountAndRecurring(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.test_excel = os.path.join(self.temp_dir.name, "Test_Gestao.xlsx")
        self.manager = ExcelManager(self.test_excel)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_workbook_sheets_and_default_accounts(self):
        wb = openpyxl.load_workbook(self.test_excel)
        for sheet in ("Dashboard", "Transacoes", "Contas", "Categorias", "Recorrentes"):
            self.assertIn(sheet, wb.sheetnames)
        wb.close()

        accounts = self.manager.get_accounts()
        names = [a["name"] for a in accounts]
        self.assertIn("Dinheiro Geral", names)
        self.assertIn("Comida Mãe", names)
        self.assertIn("Comida Pai", names)
        self.assertIn("Bolsa & Grandes Volumes", names)

    def test_accounts_crud_and_transfers(self):
        # Criar uma nova conta
        new_acc = self.manager.save_account({
            "id": "poupanca_extra",
            "name": "Poupança Férias",
            "icon": "🏖️",
            "initial_balance": 100.0,
        })
        self.assertEqual(new_acc["name"], "Poupança Férias")

        # Receita na conta Bolsa & Grandes Volumes
        self.manager.add_transaction({
            "id": "TX-BOLSA-1",
            "date": "2026-10-22",
            "type": "Receita",
            "account": "Bolsa & Grandes Volumes",
            "category": "Bolsa & Apoios",
            "description": "Bolsa Outubro",
            "amount": 800.0,
        })

        # Transferência de 250€ da Bolsa para Comida Mãe
        self.manager.add_transaction({
            "id": "TX-TRANSF-1",
            "date": "2026-10-22",
            "type": "Transferência",
            "account": "Bolsa & Grandes Volumes",
            "to_account": "Comida Mãe",
            "category": "Transferência",
            "description": "Reforço Comida Mãe",
            "amount": 250.0,
        })

        # Despesa de 40€ na conta Comida Mãe
        self.manager.add_transaction({
            "id": "TX-COMIDA-1",
            "date": "2026-10-22",
            "type": "Despesa",
            "account": "Comida Mãe",
            "category": "Supermercado",
            "description": "Continente",
            "amount": 40.0,
        })

        accs = {a["name"]: a["current_balance"] for a in self.manager.get_accounts()}
        self.assertEqual(accs["Bolsa & Grandes Volumes"], 550.0)
        self.assertEqual(accs["Comida Mãe"], 210.0)
        self.assertEqual(accs["Poupança Férias"], 100.0)

        # Eliminar a conta extra
        self.assertTrue(self.manager.delete_account("poupanca_extra"))

    def test_edit_category_and_edit_transaction(self):
        tx = self.manager.add_transaction({
            "id": "TX-EDIT-1",
            "date": "2026-10-22",
            "type": "Despesa",
            "account": "Dinheiro Geral",
            "category": "Alimentação",
            "description": "Almoço",
            "amount": 10.0,
        })
        # Editar transação (mudar categoria, conta e valor)
        updated = self.manager.update_transaction("TX-EDIT-1", {
            "category": "Supermercado",
            "account": "Comida (Mãe & Pai)",
            "amount": 15.50,
            "description": "Almoço Pais",
        })
        self.assertEqual(updated["category"], "Supermercado")
        self.assertEqual(updated["account"], "Comida (Mãe & Pai)")
        self.assertEqual(updated["amount"], 15.50)

        # Criar e editar categoria
        cat = self.manager.save_category({
            "id": "cat_custom",
            "name": "Gastos Faculdade",
            "icon": "📚",
            "type": "Despesa",
            "budget": 90.0,
            "chips": ["Fotocópias", "Livros"],
        })
        self.assertEqual(cat["name"], "Gastos Faculdade")
        self.assertTrue(self.manager.delete_category("cat_custom"))

    def test_recurring_deductions(self):
        rec = self.manager.save_recurring({
            "id": "REC-SPOTIFY",
            "description": "Spotify Mensal",
            "type": "Despesa",
            "category": "Subscrições",
            "account": "Dinheiro Geral",
            "amount": 7.99,
            "day_of_month": 1,
            "active": True,
        })
        self.assertEqual(rec["amount"], 7.99)

        # Processar recorrentes vencidas
        created = self.manager.process_due_recurring(force_all_active=True)
        self.assertEqual(len(created), 1)
        self.assertEqual(created[0]["amount"], 7.99)

        # Chamar novamente no mesmo mês não deve duplicar
        created_again = self.manager.process_due_recurring(force_all_active=True)
        self.assertEqual(len(created_again), 0)

        self.assertTrue(self.manager.delete_recurring("REC-SPOTIFY"))

    def test_upgrade_production_excel(self):
        prod = ExcelManager(DEFAULT_EXCEL_PATH)
        accs = prod.get_accounts()
        self.assertGreaterEqual(len(accs), 3)


if __name__ == "__main__":
    unittest.main()
