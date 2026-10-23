import os
import re
import json
import uuid
import base64
import tempfile
import subprocess
import urllib.parse
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
import requests

from sync_service.cloud_sync import load_cloud_config, save_cloud_config

AGENT_DATA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_data.json")

# Dicionário de correção rápida de acentuação e termos frequentes (Técnico, FST, Dia-a-dia)
PORTUGUESE_FIXES: Dict[str, str] = {
    "alinea": "Alínea",
    "alínea": "Alínea",
    "alineas": "Alíneas",
    "mecanico": "Mecânico",
    "mecanicos": "Mecânicos",
    "mecânicos": "Mecânicos",
    "mecanica": "Mecânica",
    "eletrico": "Elétrico",
    "eletricos": "Elétricos",
    "eletronica": "Eletrónica",
    "eletrónica": "Eletrónica",
    "relatorio": "Relatório",
    "relatorios": "Relatórios",
    "laboratorio": "Laboratório",
    "reuniao": "Reunião",
    "reunioes": "Reuniões",
    "simulacao": "Simulação",
    "simulacoes": "Simulações",
    "calculo": "Cálculo",
    "calculos": "Cálculos",
    "equacao": "Equação",
    "equacoes": "Equações",
    "apresentacao": "Apresentação",
    "revisao": "Revisão",
    "preparacao": "Preparação",
    "exercicio": "Exercício",
    "exercicios": "Exercícios",
    "teorica": "Teórica",
    "pratica": "Prática",
    "suspensao": "Suspensão",
    "direcao": "Direção",
    "travoes": "Travões",
    "aerodinamica": "Aerodinâmica",
    "fabricacao": "Fabricação",
    "laminacao": "Laminação",
    "manutencao": "Manutenção",
    "inspecao": "Inspeção",
    "validacao": "Validação",
    "otimizacao": "Otimização",
    "configuracao": "Configuração",
    "documentacao": "Documentação",
    "submissao": "Submissão",
    "correcao": "Correção",
    "inscricao": "Inscrição",
    "frequencia": "Frequência",
    "grafico": "Gráfico",
    "graficos": "Gráficos",
    "analise": "Análise",
    "conclusao": "Conclusão",
    "conclusoes": "Conclusões",
    "introducao": "Introdução",
    "codigo": "Código",
    "metodo": "Método",
    "metodos": "Métodos",
    "horario": "Horário",
    "medico": "Médico",
    "ginasio": "Ginásio",
}

ACRONYMS = {
    "mc": "MC",
    "fst": "FST",
    "ist": "IST",
    "fem": "FEM",
    "fea": "FEA",
    "cad": "CAD",
    "cam": "CAM",
    "cfd": "CFD",
    "pcb": "PCB",
    "bms": "BMS",
    "ecu": "ECU",
    "hv": "HV",
    "lv": "LV",
    "tp": "TP",
    "pb": "PB",
    "map": "MAP",
    "map15": "MAP15",
    "map30": "MAP30",
    "map45": "MAP45",
    "matlab": "MATLAB",
    "simulink": "Simulink",
    "solidworks": "SolidWorks",
    "ansys": "ANSYS",
    "python": "Python",
    "pdf": "PDF",
}

TECNICO_KEYWORDS = {
    "tecnico", "técnico", "ist", "projeto", "projecto", "alinea", "alínea",
    "ficha", "problema", "problemas", "serie", "série", "exame", "teste",
    "map", "map15", "map30", "map45", "laboratorio", "laboratório", "lab",
    "relatorio", "relatório", "cadeira", "aula", "teorica", "teórica",
    "pratica", "prática", "pb", "tp", "estudar", "entregar", "submeter",
    "fenix", "fénix", "mc", "mecanica", "mecânica", "fem", "termo",
    "termodinamica", "fluidos", "controlo", "sinais", "matlab", "simulink",
    "calculo", "cálculo", "algebra", "álgebra", "fisica", "física", "exercicio", "exercício"
}

FST_KEYWORDS = {
    "fst", "formula", "checks", "check", "mecanicos", "mecânicos", "box",
    "oficina", "chassi", "chassis", "suspensao", "suspensão", "bateria",
    "acumulador", "aero", "aerodinamica", "aerodinâmica", "powertrain",
    "pcb", "bms", "ecu", "scrutineering", "manufacturing", "fabrico",
    "fabricacao", "laminação", "laminacao", "carbono", "pista", "trackday",
    "sponsors", "patrocinios", "cost", "design", "monocoque", "inversor", "tsal",
    "alumni", "jota"
}

PESSOAL_KEYWORDS = {
    "pessoal", "jantar", "almoco", "almoço", "consulta", "medico", "médico",
    "dentista", "ginasio", "ginásio", "treino", "aniversario", "aniversário",
    "cinema", "viagem", "ferias", "férias", "familia", "família", "compras",
    "barbeiro", "cabeleireiro", "festa", "cafe", "café"
}

EVENT_KEYWORDS = {
    "checks", "check", "reuniao", "reunião", "meeting", "call", "aula",
    "turno", "exame", "teste", "map", "map15", "map30", "map45", "consulta",
    "jantar", "almoco", "almoço", "treino", "box", "oficina", "apresentacao",
    "apresentação", "defesa", "entrevista", "sessao", "sessão", "workshop", "trackday",
    "evento", "palestra", "seminario", "seminário"
}

TASK_KEYWORDS = {
    "fazer", "resolver", "estudar", "entregar", "submeter", "escrever",
    "redigir", "acabar", "terminar", "rever", "ler", "preparar", "alinea",
    "alínea", "relatorio", "relatório", "ficha", "codigo", "código",
    "script", "simular", "calcular", "desenhar", "modelar", "comprar", "enviar"
}

WEEKDAYS_PT = {
    "segunda": 0, "segunda-feira": 0, "2a": 0, "2ª": 0,
    "terca": 1, "terça": 1, "terça-feira": 1, "3a": 1, "3ª": 1,
    "quarta": 2, "quarta-feira": 2, "4a": 2, "4ª": 2,
    "quinta": 3, "quinta-feira": 3, "5a": 3, "5ª": 3,
    "sexta": 4, "sexta-feira": 4, "6a": 4, "6ª": 4,
    "sabado": 5, "sábado": 5, "sab": 5, "sáb": 5,
    "domingo": 6, "dom": 6,
}

MONTHS_PT_EN = {
    "janeiro": 1, "jan": 1, "january": 1,
    "fevereiro": 2, "fev": 2, "feb": 2, "february": 2,
    "marco": 3, "março": 3, "mar": 3, "march": 3,
    "abril": 4, "abr": 4, "apr": 4, "april": 4,
    "maio": 5, "mai": 5, "may": 5,
    "junho": 6, "jun": 6, "june": 6,
    "julho": 7, "jul": 7, "july": 7,
    "agosto": 8, "ago": 8, "aug": 8, "august": 8,
    "setembro": 9, "set": 9, "sep": 9, "september": 9,
    "outubro": 10, "out": 10, "oct": 10, "october": 10,
    "novembro": 11, "nov": 11, "november": 11,
    "dezembro": 12, "dez": 12, "dec": 12, "december": 12,
}


def load_agent_data() -> Dict[str, Any]:
    if os.path.exists(AGENT_DATA_PATH):
        try:
            with open(AGENT_DATA_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                data.setdefault("agent_webhook_url", "")
                data.setdefault("ics_url", "")
                data.setdefault("gemini_api_key", "")
                data.setdefault("auto_open_gcal", False)
                data.setdefault("history", [])
                data.setdefault("external_events", [])
                return data
        except Exception:
            pass
    return {
        "agent_webhook_url": "",
        "ics_url": "",
        "gemini_api_key": "",
        "auto_open_gcal": False,
        "history": [],
        "external_events": [],
    }


def save_agent_data(data: Dict[str, Any]) -> Dict[str, Any]:
    current = load_agent_data()
    current.update(data)
    with open(AGENT_DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(current, f, indent=2, ensure_ascii=False)
    return current


class SmartTextOrganizer:
    """
    Motor inteligente que transforma texto 'rough' num título estruturado (sem emojis),
    deteta a aba/contexto (Técnico, FST, Pessoal), separa ou gera subtarefas
    e sugere a melhor altura para realizar a tarefa/evento.
    """

    @classmethod
    def organize(
        cls,
        raw_title: str,
        raw_subtasks: str = "",
        forced_type: str = "auto",
        forced_context: str = "auto",
        forced_date: str = "",
        forced_time: str = "",
        duration_minutes: int = 90,
        auto_generate_subtasks: bool = False,
        create_time_block: bool = False,
    ) -> Dict[str, Any]:
        now = datetime.now()
        text = (raw_title or "").strip()
        if not text:
            return {
                "clean_title": "",
                "item_type": "task",
                "context": "Técnico",
                "task_list_name": "Técnico",
                "subtasks": [],
                "date": forced_date or now.strftime("%Y-%m-%d"),
                "start_time": forced_time or "09:30",
                "end_time": "11:00",
                "recommended_slot": cls._recommend_slot("Técnico", "task", ""),
            }

        cleaned_text, extracted_date, extracted_time, extracted_end_time = cls._extract_datetime_from_text(text, now)
        context = forced_context if forced_context not in ("", "auto") else cls._detect_context(text)
        item_type = forced_type if forced_type not in ("", "auto") else cls._detect_type(text, extracted_time is not None)
        recommended = cls._recommend_slot(context, item_type, cleaned_text)

        final_date = forced_date or extracted_date or now.strftime("%Y-%m-%d")
        final_start_time = forced_time or extracted_time or recommended["start_time"]

        if extracted_end_time and not forced_time:
            final_end_time = extracted_end_time
        else:
            final_end_time = cls._add_minutes(final_start_time, duration_minutes or recommended["duration_minutes"])

        clean_title = cls._format_smart_title(cleaned_text, context, item_type)

        subtasks = cls._process_subtasks(
            raw_subtasks=raw_subtasks,
            clean_title=clean_title,
            raw_title=cleaned_text,
            context=context,
            item_type=item_type,
            auto_generate=auto_generate_subtasks,
        )

        return {
            "raw_title": raw_title,
            "clean_title": clean_title,
            "item_type": item_type,
            "create_time_block": create_time_block,
            "context": context,
            "task_list_name": context,
            "date": final_date,
            "start_time": final_start_time,
            "end_time": final_end_time,
            "duration_minutes": duration_minutes or recommended["duration_minutes"],
            "subtasks": subtasks,
            "recommended_slot": recommended,
            "google_calendar_template_url": cls.build_gcal_url(
                title=clean_title,
                date_str=final_date,
                start_time=final_start_time,
                end_time=final_end_time,
                subtasks=subtasks,
                context=context,
            ),
        }

    @classmethod
    def _detect_context(cls, text: str) -> str:
        tokens = set(re.findall(r"[a-zA-ZÀ-ÿ0-9]+", text.lower()))
        if tokens & FST_KEYWORDS or "fst" in text.lower():
            return "FST"
        if tokens & PESSOAL_KEYWORDS:
            return "Pessoal"
        if tokens & TECNICO_KEYWORDS:
            return "Técnico"
        return "Técnico"

    @classmethod
    def _detect_type(cls, text: str, has_explicit_time: bool) -> str:
        tokens = set(re.findall(r"[a-zA-ZÀ-ÿ0-9]+", text.lower()))
        if tokens & EVENT_KEYWORDS:
            return "event"
        if tokens & TASK_KEYWORDS:
            return "task"
        if has_explicit_time:
            return "event"
        return "task"

    @classmethod
    def _extract_datetime_from_text(cls, text: str, now: datetime):
        working = text
        extracted_date: Optional[str] = None
        extracted_time: Optional[str] = None
        extracted_end_time: Optional[str] = None

        # Intervalo horário: "das 14h às 16h", "14h-16h", "14:00 as 16:30", "14:00 - 16:00"
        m_range = re.search(
            r"\b(?:das?\s+)?(\d{1,2})(?:[:h](\d{2}))?\s*(?:h)?\s*(?:às|as|a|-|–|até)\s*(\d{1,2})(?:[:h](\d{2}))?\s*h?\b",
            working,
            flags=re.IGNORECASE,
        )
        if m_range:
            h1, m1, h2, m2 = m_range.groups()
            if 0 <= int(h1) <= 23 and 0 <= int(h2) <= 23:
                extracted_time = f"{int(h1):02d}:{int(m1 or 0):02d}"
                extracted_end_time = f"{int(h2):02d}:{int(m2 or 0):02d}"
                working = working[: m_range.start()] + " " + working[m_range.end() :]

        if not extracted_time:
            m_time = re.search(
                r"\b(?:às|as|pelas|para\s+as)?\s*(\d{1,2})\s*(?:h|:)\s*(\d{2})?\b",
                working,
                flags=re.IGNORECASE,
            )
            if m_time:
                hh = int(m_time.group(1))
                mm = int(m_time.group(2) or 0)
                if 0 <= hh <= 23 and 0 <= mm <= 59:
                    extracted_time = f"{hh:02d}:{mm:02d}"
                    working = working[: m_time.start()] + " " + working[m_time.end() :]

        # Datas explícitas YYYY-MM-DD ou DD/MM/YYYY ou DD-MM-YYYY
        m_iso = re.search(r"\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b", working)
        if m_iso:
            y, m, d = int(m_iso.group(1)), int(m_iso.group(2)), int(m_iso.group(3))
            try:
                extracted_date = datetime(y, m, d).strftime("%Y-%m-%d")
                working = working[: m_iso.start()] + " " + working[m_iso.end() :]
            except ValueError:
                pass

        if not extracted_date:
            m_dmy = re.search(r"\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b", working)
            if m_dmy:
                d, m, y = int(m_dmy.group(1)), int(m_dmy.group(2)), int(m_dmy.group(3))
                try:
                    extracted_date = datetime(y, m, d).strftime("%Y-%m-%d")
                    working = working[: m_dmy.start()] + " " + working[m_dmy.end() :]
                except ValueError:
                    pass

        # Datas com nome do mês: "25 de outubro", "25 Out", "25 oct"
        if not extracted_date:
            months_pattern = "|".join(re.escape(k) for k in sorted(MONTHS_PT_EN.keys(), key=len, reverse=True))
            m_named = re.search(
                rf"\b(?:dia\s+)?(\d{{1,2}})\s*(?:de\s+|\s+)({months_pattern})\.?(?:\s+(?:de\s+)?(20\d{{2}}))?\b",
                working,
                flags=re.IGNORECASE,
            )
            if m_named:
                day = int(m_named.group(1))
                month_str = m_named.group(2).lower().rstrip(".")
                year = int(m_named.group(3)) if m_named.group(3) else now.year
                month = MONTHS_PT_EN.get(month_str, now.month)
                try:
                    dt = datetime(year, month, day)
                    if not m_named.group(3) and dt.date() < (now - timedelta(days=30)).date():
                        dt = datetime(year + 1, month, day)
                    extracted_date = dt.strftime("%Y-%m-%d")
                    working = working[: m_named.start()] + " " + working[m_named.end() :]
                except ValueError:
                    pass

        # Datas relativas: "depois de amanhã", "amanhã", "hoje"
        if not extracted_date:
            if re.search(r"\bdepois\s+de\s+amanh[aã]\b", working, flags=re.IGNORECASE):
                extracted_date = (now + timedelta(days=2)).strftime("%Y-%m-%d")
                working = re.sub(r"\bdepois\s+de\s+amanh[aã]\b", "", working, flags=re.IGNORECASE)
            elif re.search(r"\bamanh[aã]\b", working, flags=re.IGNORECASE):
                extracted_date = (now + timedelta(days=1)).strftime("%Y-%m-%d")
                working = re.sub(r"\bamanh[aã]\b", "", working, flags=re.IGNORECASE)
            elif re.search(r"\bhoje\b", working, flags=re.IGNORECASE):
                extracted_date = now.strftime("%Y-%m-%d")
                working = re.sub(r"\bhoje\b", "", working, flags=re.IGNORECASE)
            else:
                for wd_name, wd_idx in WEEKDAYS_PT.items():
                    pattern = rf"\b(?:na|no|pr[oó]xim[ao]|esta|este)?\s*{re.escape(wd_name)}(?:-feira)?\b"
                    if re.search(pattern, working, flags=re.IGNORECASE):
                        days_ahead = (wd_idx - now.weekday() + 7) % 7
                        if days_ahead == 0:
                            days_ahead = 7
                        extracted_date = (now + timedelta(days=days_ahead)).strftime("%Y-%m-%d")
                        working = re.sub(pattern, "", working, flags=re.IGNORECASE)
                        break

        # Data explícita curta: "28/10" ou "dia 28"
        if not extracted_date:
            m_dm = re.search(r"\b(\d{1,2})/(\d{1,2})\b", working)
            if m_dm:
                day, month = int(m_dm.group(1)), int(m_dm.group(2))
                try:
                    dt = datetime(now.year, month, day)
                    if dt.date() < (now - timedelta(days=30)).date():
                        dt = datetime(now.year + 1, month, day)
                    extracted_date = dt.strftime("%Y-%m-%d")
                    working = working[: m_dm.start()] + " " + working[m_dm.end() :]
                except ValueError:
                    pass
            else:
                m_day = re.search(r"\bdia\s+(\d{1,2})\b", working, flags=re.IGNORECASE)
                if m_day:
                    day = int(m_day.group(1))
                    try:
                        dt = datetime(now.year, now.month, day)
                        if dt.date() < now.date():
                            next_m = now.month + 1 if now.month < 12 else 1
                            next_y = now.year if now.month < 12 else now.year + 1
                            dt = datetime(next_y, next_m, day)
                        extracted_date = dt.strftime("%Y-%m-%d")
                        working = working[: m_day.start()] + " " + working[m_day.end() :]
                    except ValueError:
                        pass

        working = re.sub(r"\s+", " ", working).strip(" -–,.:;")
        return working or text, extracted_date, extracted_time, extracted_end_time

    @classmethod
    def _format_smart_title(cls, cleaned_text: str, context: str, item_type: str) -> str:
        words = cleaned_text.split()
        detected_tag = None
        remaining_words = []

        subject_aliases = {
            "mc": "MC",
            "fem": "FEM",
            "cad": "CAD",
            "cfd": "CFD",
            "termo": "Termo",
            "termodinamica": "Termo",
            "controlo": "Controlo",
            "fluidos": "Fluidos",
            "mflu": "MFlu",
            "fst": "FST",
            "aero": "FST-Aero",
            "bms": "FST-BMS",
            "pcb": "FST-PCB",
        }

        for w in words:
            w_clean = w.strip(".,;()[]").lower()
            if w_clean in subject_aliases and not detected_tag:
                detected_tag = subject_aliases[w_clean]
                continue
            remaining_words.append(w)

        if not remaining_words:
            remaining_words = words

        small_words = {"de", "da", "do", "das", "dos", "e", "em", "na", "no", "nas", "nos", "para", "com", "a", "o", "ao"}
        formatted_words = []
        i = 0
        while i < len(remaining_words):
            w = remaining_words[i]
            w_low = w.lower().strip(".,;:")

            if w_low in ("alinea", "alínea") and i + 1 < len(remaining_words):
                next_w = remaining_words[i + 1].strip(").,:;")
                if len(next_w) <= 2 and next_w.isalnum():
                    formatted_words.append(f"Alínea {next_w.lower()})")
                    i += 2
                    continue

            if w_low in ACRONYMS:
                formatted_words.append(ACRONYMS[w_low])
            elif w_low in PORTUGUESE_FIXES:
                formatted_words.append(PORTUGUESE_FIXES[w_low])
            elif i > 0 and w_low in small_words:
                formatted_words.append(w_low)
            else:
                formatted_words.append(w[0].upper() + w[1:] if len(w) > 1 else w.upper())
            i += 1

        if len(formatted_words) >= 2 and formatted_words[0].lower() == "fazer":
            second_low = formatted_words[1].lower()
            if second_low.startswith("alínea") or second_low in ("ficha", "exercício", "exercícios", "problema", "série"):
                formatted_words[0] = "Resolver"
            elif second_low in ("relatório", "apresentação", "documentação", "resumo"):
                formatted_words[0] = "Elaborar"
            elif second_low in ("projeto", "código", "script", "simulação", "modelo"):
                formatted_words[0] = "Desenvolver"
            elif second_low in ("checks", "inspeção", "testes", "revisão"):
                formatted_words.pop(0)

        body = " ".join(formatted_words)
        body = re.sub(
            r"(Alínea\s+[a-z0-9]\))\s+(?:do\s+|da\s+)?(Projeto|Ficha|Laboratório|Relatório|Série)",
            r"\1 — \2",
            body,
            flags=re.IGNORECASE,
        )

        # Se já tiver um prefixo [TAG] fechado válido, não duplicar; caso contrário limpar parênteses retos soltos de OCR
        if re.match(r"^\[[^\]]+\]\s+", body):
            return body.strip()
        body = body.replace("[", "").replace("]", "").strip()

        tag_prefix = f"[{detected_tag}]" if detected_tag else (f"[{context}]" if context in ("FST", "Técnico") else "")
        if tag_prefix:
            return f"{tag_prefix} {body}".strip()
        return body.strip()

    @classmethod
    def _process_subtasks(
        cls,
        raw_subtasks: str,
        clean_title: str,
        raw_title: str,
        context: str,
        item_type: str,
        auto_generate: bool = False,
    ) -> List[str]:
        raw = (raw_subtasks or "").strip()
        if raw:
            parts = [p.strip(" -•*1234567890.)\t") for p in re.split(r"[\n;,]+", raw) if p.strip()]
            cleaned_list = []
            for p in parts:
                words = p.split()
                fixed_words = []
                for idx, w in enumerate(words):
                    wl = w.lower().strip(".,;:")
                    if wl in ACRONYMS:
                        fixed_words.append(ACRONYMS[wl])
                    elif wl in PORTUGUESE_FIXES:
                        fixed_words.append(PORTUGUESE_FIXES[wl] if idx == 0 else PORTUGUESE_FIXES[wl].lower())
                    elif idx == 0:
                        fixed_words.append(w[0].upper() + w[1:])
                    else:
                        fixed_words.append(w)
                item_str = " ".join(fixed_words)
                if item_str:
                    cleaned_list.append(item_str)
            if cleaned_list:
                return cleaned_list

        if not auto_generate:
            return []

        low = (raw_title + " " + clean_title).lower()
        if "alínea" in low or "projeto" in low or "ficha" in low:
            return [
                "Rever enunciado, dados e condições do problema",
                "Desenvolver formulação teórica e cálculos / script",
                "Validar resultados obtidos e redigir resposta final",
            ]
        if "relatório" in low or "laboratório" in low or "lab" in low:
            return [
                "Organizar dados experimentais, tabelas e gráficos",
                "Redigir análise crítica de resultados e discussão",
                "Rever formatação e submeter PDF final",
            ]
        if "checks" in low or "mecânicos" in low or "mecanicos" in low:
            return [
                "Verificar checklist mecânica, apertos e fixações críticas",
                "Inspecionar folgas, cablagem e sistemas de segurança",
                "Registar anomalias e validar prontidão do carro",
            ]
        if context == "FST":
            return [
                "Alinhar objetivos e requisitos técnicos com a equipa FST",
                "Executar tarefa técnica / trabalho na box",
                "Documentar progresso e atualizar estado",
            ]
        return [
            "Preparar materiais e requisitos necessários",
            "Executar etapa principal",
            "Rever e concluir",
        ]

    @classmethod
    def _recommend_slot(cls, context: str, item_type: str, text: str) -> Dict[str, Any]:
        low = text.lower()
        if context == "FST" or "checks" in low or "box" in low or "oficina" in low:
            return {
                "label": "Bloco Oficina / Fim de Tarde (17:00 – 19:00)",
                "start_time": "17:00",
                "end_time": "19:00",
                "duration_minutes": 120,
                "reason": "Ideal para trabalhos práticos, checks mecânicos e reuniões na box da FST após aulas.",
            }
        if "alínea" in low or "projeto" in low or "estudar" in low or "ficha" in low or "cálculo" in low:
            return {
                "label": "Bloco de Foco Analítico (09:30 – 11:30)",
                "start_time": "09:30",
                "end_time": "11:30",
                "duration_minutes": 120,
                "reason": "Período de maior foco cognitivo para resolução de problemas e projetos do Técnico.",
            }
        if "relatório" in low or "lab" in low:
            return {
                "label": "Bloco de Escrita & Tarde (14:30 – 16:30)",
                "start_time": "14:30",
                "end_time": "16:30",
                "duration_minutes": 120,
                "reason": "Ótimo bloco para tratamento de dados, gráficos e redação de relatórios.",
            }
        return {
            "label": "Bloco Produtivo (15:00 – 16:30)",
            "start_time": "15:00",
            "end_time": "16:30",
            "duration_minutes": 90,
            "reason": "Horário equilibrado para concluir tarefas e eventos sem sobrecarregar a noite.",
        }

    @staticmethod
    def _add_minutes(time_str: str, minutes: int) -> str:
        try:
            hh, mm = [int(x) for x in time_str.split(":")]
            dt = datetime(2026, 1, 1, hh, mm) + timedelta(minutes=minutes)
            return dt.strftime("%H:%M")
        except Exception:
            return "11:00"

    @staticmethod
    def build_gcal_url(
        title: str,
        date_str: str,
        start_time: str,
        end_time: str,
        subtasks: List[str],
        context: str,
    ) -> str:
        try:
            d_clean = date_str.replace("-", "")
            s_clean = start_time.replace(":", "") + "00"
            e_clean = end_time.replace(":", "") + "00"
            dates_param = f"{d_clean}T{s_clean}/{d_clean}T{e_clean}"
        except Exception:
            dates_param = ""

        desc_lines = [f"Contexto: {context}"]
        if subtasks:
            desc_lines.append("\nSubtarefas / Notas:")
            for idx, st in enumerate(subtasks, 1):
                desc_lines.append(f"- {idx}. {st}")

        params = {
            "action": "TEMPLATE",
            "text": title,
            "dates": dates_param,
            "details": "\n".join(desc_lines),
        }
        return "https://calendar.google.com/calendar/render?" + urllib.parse.urlencode(params)


class SmartScreenshotAgent:
    """
    Agente que lê uma Print / Screenshot (via Gemini Vision se API Key disponível
    ou via Motor Nativo de OCR do Windows WinRT sem necessidade de chave externa)
    e extrai automaticamente Título, Data, Hora de Início/Fim, Contexto e Notas.
    """

    PS_WINRT_OCR = r"""
param([string]$ImagePath)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
foreach ($line in $result.Lines) { Write-Output $line.Text }
"""

    STATUS_BAR_NOISE = re.compile(
        r"^(\d{1,2}:\d{2}\s*(?:AM|PM|Ign|5G|4G|LTE|Wi-Fi)?|\d{1,3}%|5G|4G|LTE|Vodafone|MEO|NOS|DIGI|<|Voltar|Responder|Mensagem\.{0,3}|Enviar|Cancelar|OK|Editar|Partilhar)$",
        flags=re.IGNORECASE,
    )

    @classmethod
    def extract_event_from_windows_clipboard(
        cls,
        default_context: str = "auto",
        default_date: str = "",
    ) -> Optional[Dict[str, Any]]:
        try:
            import io
            from PIL import ImageGrab, Image

            grabbed = ImageGrab.grabclipboard()
            if isinstance(grabbed, Image.Image):
                buf = io.BytesIO()
                grabbed.save(buf, format="PNG")
                b64_str = base64.b64encode(buf.getvalue()).decode("utf-8")
                return cls.extract_event_from_base64_image(
                    image_base64=b64_str,
                    default_context=default_context,
                    default_date=default_date,
                )
            elif isinstance(grabbed, list) and len(grabbed) > 0 and os.path.isfile(str(grabbed[0])):
                with open(str(grabbed[0]), "rb") as f:
                    b64_str = base64.b64encode(f.read()).decode("utf-8")
                return cls.extract_event_from_base64_image(
                    image_base64=b64_str,
                    default_context=default_context,
                    default_date=default_date,
                )
        except Exception:
            pass
        return None

    @classmethod
    def extract_event_from_base64_image(
        cls,
        image_base64: str,
        default_context: str = "auto",
        default_date: str = "",
    ) -> Dict[str, Any]:
        if "," in image_base64 and image_base64.strip().startswith("data:"):
            header, b64_data = image_base64.split(",", 1)
            mime_match = re.search(r"data:(image/[a-zA-Z0-9+.-]+);base64", header)
            mime_type = mime_match.group(1) if mime_match else "image/png"
        else:
            b64_data = image_base64.strip()
            mime_type = "image/png"

        raw_bytes = base64.b64decode(b64_data)

        # 1. Tentar Gemini Vision se houver API Key configurada
        agent_cfg = load_agent_data()
        api_key = (
            agent_cfg.get("gemini_api_key")
            or os.environ.get("GEMINI_API_KEY")
            or os.environ.get("GOOGLE_API_KEY")
            or ""
        ).strip()

        if api_key:
            gemini_res = cls._try_gemini_vision(b64_data, mime_type, api_key, default_context, default_date)
            if gemini_res:
                return gemini_res

        # 2. Motor Nativo Windows WinRT OCR + Parser Semântico de Eventos
        ocr_lines = cls._run_windows_ocr(raw_bytes)
        return cls.parse_ocr_lines_to_event(
            lines=ocr_lines,
            default_context=default_context,
            default_date=default_date,
        )

    @classmethod
    def _try_gemini_vision(
        cls,
        b64_data: str,
        mime_type: str,
        api_key: str,
        default_context: str,
        default_date: str,
    ) -> Optional[Dict[str, Any]]:
        today_str = datetime.now().strftime("%Y-%m-%d")
        prompt = (
            f"Hoje é {today_str}. Lê esta captura de ecrã (print) e extrai os dados do evento ou tarefa para agendar no calendário. "
            "Responde APENAS num objeto JSON válido com as chaves: "
            '{"title": "Título limpo do evento", "context": "Técnico" | "FST" | "Pessoal", '
            '"item_type": "event" | "task", "date": "YYYY-MM-DD", "start_time": "HH:MM", '
            '"end_time": "HH:MM", "subtasks": ["detalhe ou sala 1", "detalhe 2"]}.'
        )
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": prompt},
                        {"inline_data": {"mime_type": mime_type, "data": b64_data}},
                    ]
                }
            ],
            "generationConfig": {"responseMimeType": "application/json"},
        }
        try:
            resp = requests.post(url, json=payload, timeout=15)
            if resp.status_code == 200:
                candidates = resp.json().get("candidates", [])
                if candidates:
                    txt = candidates[0]["content"]["parts"][0]["text"]
                    parsed = json.loads(txt)
                    ctx = default_context if default_context not in ("", "auto") else parsed.get("context", "Técnico")
                    title = parsed.get("title") or "Evento extraído de Print"
                    date_val = parsed.get("date") or default_date or today_str
                    s_time = parsed.get("start_time") or "09:30"
                    e_time = parsed.get("end_time") or SmartTextOrganizer._add_minutes(s_time, 90)
                    subs = parsed.get("subtasks") or []
                    clean_title = SmartTextOrganizer._format_smart_title(title, ctx, "event")
                    return {
                        "raw_title": title,
                        "clean_title": clean_title,
                        "item_type": parsed.get("item_type") or "event",
                        "context": ctx,
                        "task_list_name": ctx,
                        "date": date_val,
                        "start_time": s_time,
                        "end_time": e_time,
                        "subtasks": subs,
                        "ocr_text": title,
                        "engine": "gemini_vision",
                    }
        except Exception:
            pass
        return None

    @classmethod
    def _run_windows_ocr(cls, image_bytes: bytes) -> List[str]:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp.write(image_bytes)
            tmp_path = tmp.name

        try:
            res = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    f"& {{ {cls.PS_WINRT_OCR} }} -ImagePath '{tmp_path}'",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
            )
            lines = [ln.strip() for ln in (res.stdout or "").splitlines() if ln.strip()]
            return lines
        except Exception:
            return []
        finally:
            try:
                os.remove(tmp_path)
            except Exception:
                pass

    @classmethod
    def parse_ocr_lines_to_event(
        cls,
        lines: List[str],
        default_context: str = "auto",
        default_date: str = "",
    ) -> Dict[str, Any]:
        now = datetime.now()
        meaningful_lines: List[str] = []

        for idx, ln in enumerate(lines):
            clean_ln = ln.strip()
            if not clean_ln:
                continue
            # Ignorar relógio de barra de estado do telemóvel na primeira linha (ex: "23:35" ou "23:35 Ign")
            if idx == 0 and re.match(r"^\d{1,2}:\d{2}(\s+[A-Za-z0-9%]{1,6})?$", clean_ln):
                continue
            if cls.STATUS_BAR_NOISE.match(clean_ln):
                continue
            if len(clean_ln) <= 1:
                continue
            meaningful_lines.append(clean_ln)

        full_text = " | ".join(meaningful_lines)
        if not meaningful_lines:
            fallback_date = default_date or now.strftime("%Y-%m-%d")
            return {
                "raw_title": "Evento extraído de Print",
                "clean_title": "[Técnico] Evento extraído de Print",
                "item_type": "event",
                "context": default_context if default_context not in ("", "auto") else "Técnico",
                "task_list_name": default_context if default_context not in ("", "auto") else "Técnico",
                "date": fallback_date,
                "start_time": "10:00",
                "end_time": "11:30",
                "subtasks": [],
                "ocr_text": "",
                "engine": "windows_ocr",
            }

        # Extrair data e hora do conjunto do texto da print
        _, extracted_date, extracted_time, extracted_end_time = SmartTextOrganizer._extract_datetime_from_text(
            full_text, now
        )

        # Se ainda não encontrou hora, procurar padrão HH:MM em qualquer linha de conteúdo
        if not extracted_time:
            for ln in meaningful_lines:
                m_t = re.search(r"\b(\d{1,2})[:h](\d{2})\b", ln, flags=re.IGNORECASE)
                if m_t:
                    hh, mm = int(m_t.group(1)), int(m_t.group(2))
                    if 0 <= hh <= 23 and 0 <= mm <= 59:
                        extracted_time = f"{hh:02d}:{mm:02d}"
                        break

        # Escolher a melhor linha para Título Principal e as restantes como Subtarefas / Detalhes
        candidate_titles: List[str] = []
        detail_lines: List[str] = []

        for ln in meaningful_lines:
            # Limpar datas/horas isoladas para ver se a linha tem texto substantivo
            stripped_dt, _, _, _ = SmartTextOrganizer._extract_datetime_from_text(ln, now)
            stripped_dt = re.sub(r"^[\s\-•*|:.,]+|[\s\-•*|:.,]+$", "", stripped_dt)
            # Se a linha era apenas uma data ou hora (ex: "23 Out. 14:30 - 16:00"), não usar como título
            if not stripped_dt or re.match(r"^[\d\s/:.\-hH]+$", stripped_dt):
                continue
            if not candidate_titles and len(stripped_dt) >= 3:
                candidate_titles.append(stripped_dt)
            elif len(stripped_dt) >= 3:
                detail_lines.append(stripped_dt)

        raw_title = candidate_titles[0] if candidate_titles else meaningful_lines[0]
        context = (
            default_context
            if default_context not in ("", "auto")
            else SmartTextOrganizer._detect_context(full_text)
        )
        final_date = extracted_date or default_date or now.strftime("%Y-%m-%d")
        final_start = extracted_time or "10:00"
        final_end = extracted_end_time or SmartTextOrganizer._add_minutes(final_start, 90)
        clean_title = SmartTextOrganizer._format_smart_title(raw_title, context, "event")

        subtasks = [d for d in detail_lines[:4] if d.lower() != raw_title.lower()]

        return {
            "raw_title": raw_title,
            "clean_title": clean_title,
            "item_type": "event",
            "context": context,
            "task_list_name": context,
            "date": final_date,
            "start_time": final_start,
            "end_time": final_end,
            "subtasks": subtasks,
            "ocr_text": "\n".join(meaningful_lines),
            "engine": "windows_ocr",
            "google_calendar_template_url": SmartTextOrganizer.build_gcal_url(
                title=clean_title,
                date_str=final_date,
                start_time=final_start,
                end_time=final_end,
                subtasks=subtasks,
                context=context,
            ),
        }


class GoogleCalendarTasksBridge:
    """
    Gere a ligação bidirecional com o Google Calendar / Google Tasks:
    - Envia novos eventos e tarefas para o Google Apps Script Webhook (24/7).
    - Importa eventos do Google Calendar (via Webhook `list_events` ou via feed iCal `.ics`).
    - Permite testar a ligação e sincronizar eventos pendentes.
    """

    @staticmethod
    def get_webhook_url() -> str:
        agent_cfg = load_agent_data()
        if agent_cfg.get("agent_webhook_url"):
            return agent_cfg["agent_webhook_url"].strip()
        cloud_cfg = load_cloud_config()
        return (cloud_cfg.get("webhook_url") or "").strip()

    @staticmethod
    def get_ics_url() -> str:
        agent_cfg = load_agent_data()
        return (agent_cfg.get("ics_url") or "").strip()

    @classmethod
    def create_item(cls, item: Dict[str, Any]) -> Dict[str, Any]:
        record_id = item.get("id") or f"AG-{uuid.uuid4().hex[:8].upper()}"
        item["id"] = record_id
        item["created_at"] = item.get("created_at") or datetime.now().isoformat()

        if not item.get("google_calendar_template_url"):
            item["google_calendar_template_url"] = SmartTextOrganizer.build_gcal_url(
                title=item.get("clean_title") or item.get("raw_title") or "Evento",
                date_str=item.get("date") or datetime.now().strftime("%Y-%m-%d"),
                start_time=item.get("start_time") or "09:30",
                end_time=item.get("end_time") or "11:00",
                subtasks=item.get("subtasks") or [],
                context=item.get("context") or "Técnico",
            )

        webhook_url = cls.get_webhook_url()
        synced_google = False
        google_response = None
        sync_error = None

        if webhook_url:
            try:
                payload = {
                    "action": "agent_create",
                    "item": item,
                }
                resp = requests.post(webhook_url, json=payload, timeout=15)
                if resp.status_code < 400:
                    synced_google = True
                    try:
                        google_response = resp.json()
                    except Exception:
                        google_response = {"raw": resp.text[:200]}
                else:
                    sync_error = f"HTTP {resp.status_code}"
            except Exception as e:
                sync_error = str(e)

        item["synced_google"] = synced_google
        item["sync_error"] = sync_error

        data = load_agent_data()
        history = data.get("history", [])
        history = [h for h in history if h.get("id") != record_id]
        history.insert(0, item)
        data["history"] = history[:250]
        save_agent_data(data)

        return {
            "status": "synced_google" if synced_google else "saved_local",
            "item": item,
            "google_response": google_response,
            "webhook_configured": bool(webhook_url),
        }

    @classmethod
    def sync_all_pending_to_google(cls) -> Dict[str, Any]:
        webhook_url = cls.get_webhook_url()
        if not webhook_url:
            return {"synced_count": 0, "webhook_configured": False}

        data = load_agent_data()
        history = data.get("history", [])
        synced_count = 0

        for item in history:
            if not item.get("synced_google"):
                try:
                    resp = requests.post(
                        webhook_url,
                        json={"action": "agent_create", "item": item},
                        timeout=12,
                    )
                    if resp.status_code < 400:
                        item["synced_google"] = True
                        item["sync_error"] = None
                        synced_count += 1
                except Exception as e:
                    item["sync_error"] = str(e)

        save_agent_data(data)
        return {"synced_count": synced_count, "webhook_configured": True}

    @classmethod
    def fetch_external_calendar_events(cls) -> List[Dict[str, Any]]:
        """
        Importa eventos reais do Google Calendar do utilizador:
        1. Via Google Apps Script (`action: "list_events"`) se configurado.
        2. Via endereço iCal `.ics` (Google Calendar ou Fénix IST) se configurado.
        """
        external: List[Dict[str, Any]] = []
        seen_keys = set()

        webhook_url = cls.get_webhook_url()
        if webhook_url:
            try:
                resp = requests.post(
                    webhook_url,
                    json={"action": "list_events"},
                    timeout=12,
                )
                if resp.status_code == 200:
                    body = resp.json()
                    for ev in body.get("events", []):
                        key = f"{ev.get('title')}_{ev.get('date')}_{ev.get('start_time')}"
                        if key not in seen_keys and ev.get("date"):
                            seen_keys.add(key)
                            external.append({
                                "id": ev.get("id") or f"GCAL-{uuid.uuid4().hex[:8]}",
                                "clean_title": ev.get("title") or "Evento Google Calendar",
                                "raw_title": ev.get("title") or "Evento Google Calendar",
                                "item_type": "event",
                                "context": SmartTextOrganizer._detect_context(ev.get("title") or ""),
                                "date": ev.get("date"),
                                "start_time": ev.get("start_time") or "09:00",
                                "end_time": ev.get("end_time") or "10:00",
                                "subtasks": [ev.get("location")] if ev.get("location") else [],
                                "synced_google": True,
                                "source": "google_calendar",
                            })
            except Exception:
                pass

        ics_url = cls.get_ics_url()
        if ics_url:
            try:
                resp = requests.get(ics_url, timeout=12)
                if resp.status_code == 200:
                    ics_events = cls.parse_ics_content(resp.text)
                    for ev in ics_events:
                        key = f"{ev.get('clean_title')}_{ev.get('date')}_{ev.get('start_time')}"
                        if key not in seen_keys:
                            seen_keys.add(key)
                            external.append(ev)
            except Exception:
                pass

        data = load_agent_data()
        data["external_events"] = external[:300]
        save_agent_data(data)
        return external

    @classmethod
    def parse_ics_content(cls, ics_text: str) -> List[Dict[str, Any]]:
        """Parser nativo de ficheiros/streams iCalendar (.ics) do Google Calendar e Fénix IST."""
        unfolded = re.sub(r"\r?\n[ \t]", "", ics_text or "")
        blocks = re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", unfolded, flags=re.DOTALL)
        events: List[Dict[str, Any]] = []
        now = datetime.now()
        min_date = (now - timedelta(days=45)).strftime("%Y-%m-%d")
        max_date = (now + timedelta(days=90)).strftime("%Y-%m-%d")

        for blk in blocks:
            summary_m = re.search(r"^SUMMARY(?:;[^:]*)?:(.*)$", blk, flags=re.MULTILINE)
            dtstart_m = re.search(r"^DTSTART(?:;[^:]*)?:([0-9T]+Z?)$", blk, flags=re.MULTILINE)
            dtend_m = re.search(r"^DTEND(?:;[^:]*)?:([0-9T]+Z?)$", blk, flags=re.MULTILINE)
            loc_m = re.search(r"^LOCATION(?:;[^:]*)?:(.*)$", blk, flags=re.MULTILINE)
            uid_m = re.search(r"^UID(?:;[^:]*)?:(.*)$", blk, flags=re.MULTILINE)

            if not summary_m or not dtstart_m:
                continue

            title = summary_m.group(1).strip().replace("\\,", ",").replace("\\n", " ")
            raw_start = dtstart_m.group(1).strip()
            raw_end = dtend_m.group(1).strip() if dtend_m else ""

            date_str, start_time = cls._parse_ics_datetime(raw_start)
            _, end_time = cls._parse_ics_datetime(raw_end) if raw_end else (date_str, SmartTextOrganizer._add_minutes(start_time, 60))

            if not date_str or date_str < min_date or date_str > max_date:
                continue

            loc = loc_m.group(1).strip().replace("\\,", ",") if loc_m else ""
            uid = uid_m.group(1).strip() if uid_m else uuid.uuid4().hex[:8]
            ctx = SmartTextOrganizer._detect_context(title)

            events.append({
                "id": f"ICS-{uid[:16]}",
                "clean_title": title,
                "raw_title": title,
                "item_type": "event",
                "context": ctx,
                "date": date_str,
                "start_time": start_time,
                "end_time": end_time,
                "subtasks": [loc] if loc else [],
                "synced_google": True,
                "source": "ics_feed",
            })

        return events

    @staticmethod
    def _parse_ics_datetime(val: str):
        if not val or len(val) < 8:
            return ("", "09:00")
        date_part = f"{val[0:4]}-{val[4:6]}-{val[6:8]}"
        if "T" in val and len(val) >= 13:
            t_idx = val.index("T") + 1
            hh = val[t_idx : t_idx + 2]
            mm = val[t_idx + 2 : t_idx + 4]
            return (date_part, f"{hh}:{mm}")
        return (date_part, "09:00")

    @classmethod
    def test_connection(cls) -> Dict[str, Any]:
        webhook_url = cls.get_webhook_url()
        ics_url = cls.get_ics_url()
        webhook_ok = False
        ics_ok = False
        calendar_name = ""
        error_msg = None

        if webhook_url:
            try:
                resp = requests.post(webhook_url, json={"action": "ping"}, timeout=12)
                if resp.status_code < 400:
                    webhook_ok = True
                    try:
                        j = resp.json()
                        calendar_name = j.get("calendar_name") or "Google Calendar"
                    except Exception:
                        calendar_name = "Google Calendar (Webhook Ativo)"
                else:
                    error_msg = f"Webhook respondeu HTTP {resp.status_code}"
            except Exception as e:
                error_msg = f"Erro ao contactar Webhook: {e}"

        if ics_url:
            try:
                resp = requests.get(ics_url, timeout=12)
                if resp.status_code == 200 and "BEGIN:VCALENDAR" in resp.text:
                    ics_ok = True
                else:
                    error_msg = "O endereço .ics não devolveu um calendário iCal válido."
            except Exception as e:
                error_msg = f"Erro ao ler endereço .ics: {e}"

        pending_sync = cls.sync_all_pending_to_google() if webhook_ok else {"synced_count": 0}
        ext_events = cls.fetch_external_calendar_events() if (webhook_ok or ics_ok) else []

        return {
            "connected": webhook_ok or ics_ok,
            "webhook_ok": webhook_ok,
            "ics_ok": ics_ok,
            "calendar_name": calendar_name,
            "synced_pending_count": pending_sync.get("synced_count", 0),
            "imported_events_count": len(ext_events),
            "error": error_msg,
        }

    @staticmethod
    def get_google_apps_script_code() -> str:
        return '''// ============================================================================
// AGENTE BIDIRECIONAL GOOGLE CALENDAR + GOOGLE TASKS (TÉCNICO, FST, PESSOAL)
// ============================================================================
// COMO LIGAR AO TEU GOOGLE CALENDAR EM 1 MINUTO:
// 1. Abre https://script.google.com/home/start e clica em "Novo Projeto".
// 2. (Opcional para Google Tasks) Em "Serviços (+)" à esquerda, adiciona "Tasks API".
// 3. Apaga o código existente, cola este código e clica em "Guardar".
// 4. Clica em "Implementar" -> "Nova implementação" -> Tipo: "App Web".
// 5. Em "Quem tem acesso", seleciona "Qualquer pessoa" e clica em "Implementar".
// 6. Copia o URL da App Web gerado e cola-o em "Configurar Google" na tua App!

function getOrCreateTaskList(listName) {
  var target = (listName || "Técnico").trim();
  var lists = Tasks.Tasklists.list().items || [];
  for (var i = 0; i < lists.length; i++) {
    if (lists[i].title.toLowerCase() === target.toLowerCase()) {
      return lists[i].id;
    }
  }
  var created = Tasks.Tasklists.insert({ title: target });
  return created.id;
}

function listCalendarEvents() {
  var cal = CalendarApp.getDefaultCalendar();
  var now = new Date();
  var start = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  var end = new Date(now.getTime() + 60 * 24 * 3600 * 1000);
  var events = cal.getEvents(start, end);
  var out = [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var s = ev.getStartTime();
    var e = ev.getEndTime();
    var yyyy = s.getFullYear();
    var mm = ("0" + (s.getMonth() + 1)).slice(-2);
    var dd = ("0" + s.getDate()).slice(-2);
    var sh = ("0" + s.getHours()).slice(-2) + ":" + ("0" + s.getMinutes()).slice(-2);
    var eh = ("0" + e.getHours()).slice(-2) + ":" + ("0" + e.getMinutes()).slice(-2);
    out.push({
      id: ev.getId(),
      title: ev.getTitle(),
      date: yyyy + "-" + mm + "-" + dd,
      start_time: sh,
      end_time: eh,
      location: ev.getLocation() || ""
    });
  }
  return out;
}

function doGet(e) {
  try {
    var cal = CalendarApp.getDefaultCalendar();
    return ContentService.createTextOutput(JSON.stringify({
      ok: true,
      calendar_name: cal.getName(),
      events: listCalendarEvents()
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action || "agent_create";
    var cal = CalendarApp.getDefaultCalendar();

    if (action === "ping") {
      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        calendar_name: cal.getName()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "list_events") {
      return ContentService.createTextOutput(JSON.stringify({
        ok: true,
        calendar_name: cal.getName(),
        events: listCalendarEvents()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "agent_create" && body.item) {
      var item = body.item;
      var result = { ok: true, created_task: false, created_event: false };

      // 1. CRIAR TAREFA NO GOOGLE TASKS (SE SERVIÇO TASKS ATIVO)
      if (item.item_type === "task" || item.item_type === "both") {
        try {
          var listId = getOrCreateTaskList(item.task_list_name || item.context || "Técnico");
          var dueIso = item.date ? (item.date + "T" + (item.start_time || "09:30") + ":00.000Z") : null;
          var notesArr = [];
          if (item.start_time) notesArr.push("Bloco: " + item.start_time + " - " + (item.end_time || ""));
          if (item.notes) notesArr.push(item.notes);

          var mainTask = {
            title: item.clean_title || item.raw_title,
            notes: notesArr.join("\\n")
          };
          if (dueIso) mainTask.due = dueIso;

          var insertedMain = Tasks.Tasks.insert(mainTask, listId);
          result.created_task = true;
          result.task_id = insertedMain.id;

          var subtasks = item.subtasks || [];
          for (var s = subtasks.length - 1; s >= 0; s--) {
            Tasks.Tasks.insert({ title: subtasks[s] }, listId, { parent: insertedMain.id });
          }
        } catch (taskErr) {
          // Se Tasks API não tiver sido ativada, garante que cria no Google Calendar!
          item.create_time_block = true;
        }
      }

      // 2. CRIAR EVENTO NO GOOGLE CALENDAR
      if (item.item_type === "event" || item.item_type === "both" || item.create_time_block || !result.created_task) {
        var startParts = (item.date + "T" + (item.start_time || "09:30") + ":00").split(/[-T:]/);
        var endParts = (item.date + "T" + (item.end_time || "11:00") + ":00").split(/[-T:]/);

        var startDate = new Date(startParts[0], startParts[1] - 1, startParts[2], startParts[3], startParts[4]);
        var endDate = new Date(endParts[0], endParts[1] - 1, endParts[2], endParts[3], endParts[4]);
        if (endDate <= startDate) {
          endDate = new Date(startDate.getTime() + 90 * 60000);
        }

        var descLines = ["Contexto: " + (item.context || "Geral")];
        if (item.subtasks && item.subtasks.length > 0) {
          descLines.push("\\nSubtarefas / Notas:");
          for (var k = 0; k < item.subtasks.length; k++) {
            descLines.push("- " + (k + 1) + ". " + item.subtasks[k]);
          }
        }

        var ev = cal.createEvent(item.clean_title || item.raw_title, startDate, endDate, {
          description: descLines.join("\\n")
        });

        if ((item.context || "").toLowerCase().indexOf("fst") !== -1) {
          ev.setColor("11");
        } else {
          ev.setColor("9");
        }
        result.created_event = true;
        result.event_id = ev.getId();
      }

      return ContentService.createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
'''
