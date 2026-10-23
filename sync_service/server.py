import os
import sys
import socket
from datetime import datetime
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

from sync_service.excel_manager import ExcelManager, DEFAULT_EXCEL_PATH
from sync_service.cloud_sync import CloudSyncService, load_cloud_config, save_cloud_config
from sync_service.agent_service import (
    SmartTextOrganizer,
    SmartScreenshotAgent,
    GoogleCalendarTasksBridge,
    load_agent_data,
    save_agent_data,
)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_DIR = os.path.join(BASE_DIR, "app")

app = FastAPI(title="Gestão Pessoal Multi-Contas - API & Excel Sync", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def disable_static_cache(request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/api/download-excel"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response

excel_manager = ExcelManager(DEFAULT_EXCEL_PATH)
cloud_service = CloudSyncService(excel_manager)


class TransactionPayload(BaseModel):
    id: Optional[str] = None
    date: Optional[str] = None
    time: Optional[str] = None
    type: str = "Despesa"  # "Despesa", "Receita", "Transferência"
    account: str = "Dinheiro Geral"
    to_account: Optional[str] = ""
    category: str = "Outros"
    description: Optional[str] = ""
    amount: float
    payment_method: Optional[str] = "MBWay"
    month_year: Optional[str] = None


class AccountPayload(BaseModel):
    id: Optional[str] = None
    name: str
    icon: Optional[str] = "💳"
    initial_balance: float = 0.0
    color: Optional[str] = "#6366F1"
    description: Optional[str] = ""


class CategoryPayload(BaseModel):
    id: Optional[str] = None
    name: str
    icon: Optional[str] = "📌"
    type: str = "Despesa"
    budget: float = 100.0
    color: Optional[str] = "#6366F1"
    chips: Optional[Any] = ""


class RecurringPayload(BaseModel):
    id: Optional[str] = None
    description: str
    type: str = "Despesa"
    category: str = "Subscrições"
    account: str = "Dinheiro Geral"
    amount: float
    frequency: str = "Mensal"
    day_of_month: int = 1
    payment_method: Optional[str] = "Débito Direto"
    last_processed_month: Optional[str] = ""
    active: bool = True


class BatchSyncRequest(BaseModel):
    transactions: List[Dict[str, Any]]
    accounts: Optional[List[Dict[str, Any]]] = None
    categories: Optional[List[Dict[str, Any]]] = None
    recurring: Optional[List[Dict[str, Any]]] = None


class CloudConfigUpdate(BaseModel):
    provider: str
    supabase_url: Optional[str] = ""
    supabase_key: Optional[str] = ""
    webhook_url: Optional[str] = ""
    github_owner: Optional[str] = ""
    github_repo: Optional[str] = "financas-data"
    github_branch: Optional[str] = "main"
    github_path: Optional[str] = "data/financas.json"
    github_token: Optional[str] = ""


class AgentParseRequest(BaseModel):
    raw_title: str
    raw_subtasks: Optional[str] = ""
    forced_type: Optional[str] = "auto"
    forced_context: Optional[str] = "auto"
    forced_date: Optional[str] = ""
    forced_time: Optional[str] = ""
    duration_minutes: Optional[int] = 90
    auto_generate_subtasks: Optional[bool] = False
    create_time_block: Optional[bool] = False


class AgentCreateRequest(BaseModel):
    id: Optional[str] = None
    raw_title: Optional[str] = ""
    clean_title: str
    item_type: str = "task"  # "task", "event", "both"
    create_time_block: bool = False
    context: str = "Técnico"
    task_list_name: Optional[str] = "Técnico"
    date: str
    start_time: Optional[str] = "09:30"
    end_time: Optional[str] = "11:00"
    subtasks: Optional[List[str]] = []
    notes: Optional[str] = ""


class AgentConfigUpdate(BaseModel):
    agent_webhook_url: Optional[str] = ""
    ics_url: Optional[str] = ""
    gemini_api_key: Optional[str] = ""
    auto_open_gcal: Optional[bool] = False


class AgentScreenshotRequest(BaseModel):
    image_base64: str
    default_context: Optional[str] = "auto"
    default_date: Optional[str] = ""
    auto_create: Optional[bool] = True


class AgentClipboardRequest(BaseModel):
    default_context: Optional[str] = "auto"
    default_date: Optional[str] = ""
    auto_create: Optional[bool] = True


@app.get("/api/health")
def health_check():
    # Processar automaticamente deduções recorrentes vencidas
    auto_processed = excel_manager.process_due_recurring()
    return {
        "status": "online",
        "excel_path": excel_manager.excel_path,
        "excel_exists": os.path.exists(excel_manager.excel_path),
        "auto_processed_recurring": len(auto_processed),
        "timestamp": datetime.now().isoformat(),
    }


# --- CONTAS ---
@app.get("/api/accounts")
def list_accounts():
    return excel_manager.get_accounts()


@app.post("/api/accounts")
def upsert_account(payload: AccountPayload):
    saved = excel_manager.save_account(payload.model_dump())
    return {"account": saved, "accounts": excel_manager.get_accounts()}


@app.delete("/api/accounts/{acc_id}")
def delete_account(acc_id: str):
    deleted = excel_manager.delete_account(acc_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Conta não encontrada.")
    return {"deleted": True, "accounts": excel_manager.get_accounts()}


# --- CATEGORIAS (TIPOS DE GASTO) ---
@app.get("/api/categories")
def get_categories():
    return excel_manager.get_categories()


@app.post("/api/categories")
def upsert_category(payload: CategoryPayload):
    saved = excel_manager.save_category(payload.model_dump())
    return {"category": saved, "categories": excel_manager.get_categories()}


@app.delete("/api/categories/{cat_id}")
def delete_category(cat_id: str):
    deleted = excel_manager.delete_category(cat_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Categoria não encontrada.")
    return {"deleted": True, "categories": excel_manager.get_categories()}


# --- TRANSAÇÕES & TRANSFERÊNCIAS ---
@app.get("/api/transactions")
def list_transactions(month: Optional[str] = None, account: Optional[str] = None):
    txs = excel_manager.get_all_transactions()
    if month:
        txs = [t for t in txs if t.get("month_year") == month or t.get("date", "").startswith(month)]
    if account:
        txs = [t for t in txs if t.get("account") == account or t.get("to_account") == account]
    return txs


@app.post("/api/transactions")
def create_transaction(payload: TransactionPayload):
    if payload.amount <= 0:
        raise HTTPException(status_code=400, detail="O valor deve ser superior a 0.")
    if payload.type == "Transferência" and (not payload.to_account or payload.to_account == payload.account):
        raise HTTPException(status_code=400, detail="Selecione uma conta de destino diferente da conta de origem.")

    tx_data = payload.model_dump()
    saved_tx = excel_manager.add_transaction(tx_data)

    cloud_status = "local_only"
    try:
        res = cloud_service.push_to_cloud(saved_tx)
        cloud_status = res.get("status", "local_only")
    except Exception:
        cloud_status = "cloud_pending"

    return {
        "transaction": saved_tx,
        "accounts": excel_manager.get_accounts(),
        "cloud_status": cloud_status,
    }


@app.put("/api/transactions/{tx_id}")
def edit_transaction(tx_id: str, payload: TransactionPayload):
    updated = excel_manager.update_transaction(tx_id, payload.model_dump())
    if not updated:
        raise HTTPException(status_code=404, detail="Transação não encontrada.")
    return {
        "transaction": updated,
        "accounts": excel_manager.get_accounts(),
    }


@app.delete("/api/transactions/{tx_id}")
def remove_transaction(tx_id: str):
    deleted = excel_manager.delete_transaction(tx_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Transação não encontrada.")
    return {
        "deleted": True,
        "id": tx_id,
        "accounts": excel_manager.get_accounts(),
    }


# --- DEDUÇÕES RECORRENTES ---
@app.get("/api/recurring")
def list_recurring():
    return excel_manager.get_recurring()


@app.post("/api/recurring")
def upsert_recurring(payload: RecurringPayload):
    saved = excel_manager.save_recurring(payload.model_dump())
    return {"recurring": saved, "all_recurring": excel_manager.get_recurring()}


@app.delete("/api/recurring/{rec_id}")
def remove_recurring(rec_id: str):
    deleted = excel_manager.delete_recurring(rec_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Dedução recorrente não encontrada.")
    return {"deleted": True, "all_recurring": excel_manager.get_recurring()}


@app.post("/api/recurring/process")
def process_recurring_now(force: bool = False):
    created = excel_manager.process_due_recurring(force_all_active=force)
    return {
        "processed_count": len(created),
        "created_transactions": created,
        "all_recurring": excel_manager.get_recurring(),
        "accounts": excel_manager.get_accounts(),
        "transactions": excel_manager.get_all_transactions(),
    }


# --- BATCH SYNC & CLOUD ---
@app.post("/api/sync/batch")
def sync_batch(payload: BatchSyncRequest):
    excel_manager.process_due_recurring()
    res = excel_manager.sync_transactions_batch(payload.transactions)
    return {
        "added_to_excel": res["added"],
        "total_in_excel": res["total"],
        "transactions": excel_manager.get_all_transactions(),
        "accounts": excel_manager.get_accounts(),
        "categories": excel_manager.get_categories(),
        "recurring": excel_manager.get_recurring(),
    }


@app.post("/api/sync/cloud")
def trigger_cloud_sync():
    try:
        res = cloud_service.pull_from_cloud()
        return res
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/cloud-config")
def get_cloud_cfg():
    cfg = dict(load_cloud_config())
    if cfg.get("github_token"):
        cfg["github_token"] = "***"  # nunca devolver o token em claro
    return cfg


@app.post("/api/cloud-config")
def update_cloud_cfg(cfg: CloudConfigUpdate):
    data = cfg.model_dump()
    if data.get("github_token") in ("", "***", None):
        data.pop("github_token", None)  # mantém o token já guardado
    saved = dict(save_cloud_config(data))
    if saved.get("github_token"):
        saved["github_token"] = "***"
    return saved


# --- AGENTE INTELIGENTE DE AGENDA (GOOGLE CALENDAR) & TAREFAS (GOOGLE TASKS) ---
@app.post("/api/agent/parse")
def agent_parse_text(payload: AgentParseRequest):
    return SmartTextOrganizer.organize(
        raw_title=payload.raw_title,
        raw_subtasks=payload.raw_subtasks or "",
        forced_type=payload.forced_type or "auto",
        forced_context=payload.forced_context or "auto",
        forced_date=payload.forced_date or "",
        forced_time=payload.forced_time or "",
        duration_minutes=payload.duration_minutes or 90,
        auto_generate_subtasks=bool(payload.auto_generate_subtasks),
        create_time_block=bool(payload.create_time_block),
    )


@app.post("/api/agent/create")
def agent_create_item(payload: AgentCreateRequest):
    item_dict = payload.model_dump()
    item_dict["google_calendar_template_url"] = SmartTextOrganizer.build_gcal_url(
        title=item_dict["clean_title"],
        date_str=item_dict["date"],
        start_time=item_dict.get("start_time") or "09:30",
        end_time=item_dict.get("end_time") or "11:00",
        subtasks=item_dict.get("subtasks") or [],
        context=item_dict.get("context") or "Técnico",
    )
    return GoogleCalendarTasksBridge.create_item(item_dict)


@app.post("/api/agent/from-clipboard")
def agent_from_clipboard(payload: AgentClipboardRequest):
    extracted = SmartScreenshotAgent.extract_event_from_windows_clipboard(
        default_context=payload.default_context or "auto",
        default_date=payload.default_date or "",
    )
    if not extracted:
        raise HTTPException(
            status_code=400,
            detail="Nenhuma print/imagem encontrada na área de transferência. Tira uma print (Win + Shift + S) primeiro.",
        )
    if payload.auto_create:
        created_res = GoogleCalendarTasksBridge.create_item(extracted)
        return {
            "status": created_res["status"],
            "auto_created": True,
            "item": created_res["item"],
            "ocr_text": extracted.get("ocr_text", ""),
            "engine": extracted.get("engine", "windows_ocr"),
            "webhook_configured": created_res.get("webhook_configured", False),
        }
    return {
        "status": "parsed_only",
        "auto_created": False,
        "item": extracted,
        "ocr_text": extracted.get("ocr_text", ""),
        "engine": extracted.get("engine", "windows_ocr"),
    }


@app.post("/api/agent/from-screenshot")
def agent_from_screenshot(payload: AgentScreenshotRequest):
    if not payload.image_base64:
        raise HTTPException(status_code=400, detail="Imagem não fornecida.")
    extracted = SmartScreenshotAgent.extract_event_from_base64_image(
        image_base64=payload.image_base64,
        default_context=payload.default_context or "auto",
        default_date=payload.default_date or "",
    )
    if payload.auto_create:
        created_res = GoogleCalendarTasksBridge.create_item(extracted)
        return {
            "status": created_res["status"],
            "auto_created": True,
            "item": created_res["item"],
            "ocr_text": extracted.get("ocr_text", ""),
            "engine": extracted.get("engine", "windows_ocr"),
            "webhook_configured": created_res.get("webhook_configured", False),
        }
    return {
        "status": "parsed_only",
        "auto_created": False,
        "item": extracted,
        "ocr_text": extracted.get("ocr_text", ""),
        "engine": extracted.get("engine", "windows_ocr"),
    }


@app.get("/api/agent/history")
def agent_get_history():
    data = load_agent_data()
    webhook_url = GoogleCalendarTasksBridge.get_webhook_url()
    ics_url = GoogleCalendarTasksBridge.get_ics_url()
    return {
        "history": data.get("history", []),
        "external_events": data.get("external_events", []),
        "agent_webhook_url": webhook_url,
        "ics_url": ics_url,
        "auto_open_gcal": bool(data.get("auto_open_gcal", False)),
        "connected": bool(webhook_url or ics_url),
    }


@app.delete("/api/agent/history/{item_id}")
def agent_delete_history(item_id: str):
    data = load_agent_data()
    history = [h for h in data.get("history", []) if h.get("id") != item_id]
    data["history"] = history
    save_agent_data(data)
    return {"deleted": True, "history": history}


@app.post("/api/agent/config")
def agent_save_config(cfg: AgentConfigUpdate):
    current = load_agent_data()
    update_dict: Dict[str, Any] = {
        "agent_webhook_url": (cfg.agent_webhook_url or "").strip(),
        "ics_url": (cfg.ics_url if cfg.ics_url is not None else current.get("ics_url", "")).strip(),
        "auto_open_gcal": bool(cfg.auto_open_gcal) if cfg.auto_open_gcal is not None else bool(current.get("auto_open_gcal", False)),
    }
    if cfg.gemini_api_key is not None and cfg.gemini_api_key.strip():
        update_dict["gemini_api_key"] = cfg.gemini_api_key.strip()
    saved = save_agent_data(update_dict)
    test_res = GoogleCalendarTasksBridge.test_connection() if (saved.get("agent_webhook_url") or saved.get("ics_url")) else {"connected": False}
    return {
        "status": "ok",
        "agent_webhook_url": saved.get("agent_webhook_url", ""),
        "ics_url": saved.get("ics_url", ""),
        "auto_open_gcal": saved.get("auto_open_gcal", False),
        "connection": test_res,
        "history": load_agent_data().get("history", []),
        "external_events": load_agent_data().get("external_events", []),
    }


@app.post("/api/agent/test-connection")
def agent_test_connection():
    res = GoogleCalendarTasksBridge.test_connection()
    data = load_agent_data()
    res["history"] = data.get("history", [])
    res["external_events"] = data.get("external_events", [])
    return res


@app.post("/api/agent/sync-google")
def agent_sync_google():
    pending_res = GoogleCalendarTasksBridge.sync_all_pending_to_google()
    ext_events = GoogleCalendarTasksBridge.fetch_external_calendar_events()
    data = load_agent_data()
    return {
        "status": "ok",
        "synced_pending_count": pending_res.get("synced_count", 0),
        "imported_events_count": len(ext_events),
        "history": data.get("history", []),
        "external_events": ext_events,
    }


@app.get("/api/agent/gas-script")
def agent_get_gas_script():
    return {
        "script": GoogleCalendarTasksBridge.get_google_apps_script_code()
    }


@app.get("/api/download-excel")
def download_excel():
    excel_manager.ensure_workbook()
    return FileResponse(
        path=excel_manager.excel_path,
        filename="Gestao_Financeira.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


if os.path.exists(APP_DIR):
    app.mount("/", StaticFiles(directory=APP_DIR, html=True), name="static")


def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


if __name__ == "__main__":
    import uvicorn

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    local_ip = get_local_ip()
    print("=" * 65)
    print("GESTAO FINANCEIRA PESSOAL MULTI-CONTAS (PC + iPhone + Excel)")
    print("=" * 65)
    print(f"Base de Dados Excel: {excel_manager.excel_path}")
    print(f"Abrir no PC:         http://localhost:8000")
    print(f"Abrir no iPhone:     http://{local_ip}:8000")
    print("=" * 65)
    uvicorn.run(app, host="0.0.0.0", port=8000)
