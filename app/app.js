const DEFAULT_ACCOUNTS = [
  { id: "geral", name: "Dinheiro Geral", icon: "DG", initial_balance: 370.43, color: "#71717A", description: "Gastos do dia-a-dia e dinheiro geral (Cofrinho)" },
  { id: "comida_mae", name: "Comida Mãe", icon: "CM", initial_balance: 0, color: "#52525B", description: "Gastos de comida e supermercado (Mãe)" },
  { id: "comida_pai", name: "Comida Pai", icon: "CP", initial_balance: 56.68, color: "#52525B", description: "Gastos de comida e supermercado (Pai)" },
  { id: "bolsa_volumes", name: "Bolsa & Grandes Volumes", icon: "BV", initial_balance: 0, color: "#3F3F46", description: "Bolsa, poupanças e grandes volumes" }
];

const DEFAULT_CATEGORIES = [
  { id: "alimentacao", name: "Alimentação", icon: "AL", type: "Despesa", budget: 250, color: "#71717A", chips: ["Café", "Almoço", "Jantar", "Padaria", "Uber Eats"] },
  { id: "supermercado", name: "Supermercado", icon: "SM", type: "Despesa", budget: 300, color: "#71717A", chips: ["Continente", "Pingo Doce", "Lidl", "Mercadona", "Talho"] },
  { id: "transportes", name: "Transportes", icon: "TR", type: "Despesa", budget: 150, color: "#71717A", chips: ["Gasolina", "Portagem", "Uber / Bolt", "Passe", "Estacionamento"] },
  { id: "habitacao", name: "Habitação & Contas", icon: "HC", type: "Despesa", budget: 600, color: "#71717A", chips: ["Renda", "Eletricidade", "Água", "Internet"] },
  { id: "lazer", name: "Lazer & Saídas", icon: "LZ", type: "Despesa", budget: 150, color: "#71717A", chips: ["Cinema", "Jantar Fora", "Copos", "Viagem", "Desporto"] },
  { id: "saude", name: "Saúde & Bem-estar", icon: "SB", type: "Despesa", budget: 80, color: "#71717A", chips: ["Farmácia", "Consulta", "Ginásio", "Barbeiro"] },
  { id: "subscricoes", name: "Subscrições", icon: "SU", type: "Despesa", budget: 50, color: "#71717A", chips: ["Spotify", "Netflix", "iCloud", "ChatGPT", "Telemóvel"] },
  { id: "compras", name: "Compras Pessoais", icon: "CP", type: "Despesa", budget: 120, color: "#71717A", chips: ["Roupa", "Calçado", "Amazon", "Tecnologia", "Presente"] },
  { id: "outros", name: "Outros", icon: "OU", type: "Despesa", budget: 100, color: "#71717A", chips: ["Multibanco", "Imprevisto", "Diversos"] },
  { id: "bolsa", name: "Bolsa & Apoios", icon: "BA", type: "Receita", budget: 0, color: "#71717A", chips: ["Bolsa Mensal", "Apoio", "Prémio"] },
  { id: "reforco_pais", name: "Reforço Mãe & Pai", icon: "RP", type: "Receita", budget: 0, color: "#71717A", chips: ["Transferência Mãe", "Transferência Pai", "Mesada Comida"] },
  { id: "salario", name: "Salário & Rendimento", icon: "SR", type: "Receita", budget: 0, color: "#71717A", chips: ["Salário", "Reembolso MBWay", "Trabalho Extra"] }
];

const DEFAULT_QUICK_AMOUNTS = [1.5, 5, 10, 20, -1.5, -5];

const STORAGE_KEYS = {
  TXS: "financas_transactions_v5",
  ACCOUNTS: "financas_accounts_v8",
  CATEGORIES: "financas_categories_v5",
  RECURRING: "financas_recurring_v5",
  QUICK_AMOUNTS: "financas_quick_amounts_v1",
  PENDING: "financas_pending_sync_v5",
  CLOUD_CFG: "financas_cloud_config_v1",
  GIT_META: "financas_git_meta_v1",
  THEME: "financas_theme_v1"
};

let state = {
  currentType: "Despesa",
  selectedAccount: "Dinheiro Geral",
  selectedToAccount: "Comida Mãe",
  activeAccountFilter: "Dinheiro Geral",
  selectedCategory: "Alimentação",
  selectedPayment: "MBWay",
  selectedMonth: new Date().toISOString().slice(0, 7),
  accounts: [...DEFAULT_ACCOUNTS],
  categories: [...DEFAULT_CATEGORIES],
  quickAmounts: [...DEFAULT_QUICK_AMOUNTS],
  recurring: [],
  transactions: [],
  pendingIds: new Set(),
  serverOnline: false,
  cloudStatus: { ok: false, error: "", at: 0 },
  cloudConfig: {
    provider: "none",
    supabase_url: "",
    supabase_key: "",
    webhook_url: "",
    github_owner: "",
    github_repo: "financas-data",
    github_branch: "main",
    github_path: "data/financas.json",
    github_token: ""
  }
};

// Estado interno da sincronização com o GitHub (meta = o que já foi visto/carimbado).
let gitMeta = FinCloud.newMeta("");
let localVersion = 0;
let suppressCloudSchedule = false;
let gitSyncTimer = null;
let syncInFlight = false;
let syncQueued = false;
let lastCloudAttempt = 0;
let lastMirrorKey = "";
const mirroredTxSigs = new Map();
let repoPrivacyChecked = "";

function formatEuro(val) {
  const num = Number(val) || 0;
  return num.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

function getMonogram(name, fallbackIcon) {
  if (fallbackIcon && /^[A-Za-z0-9]{1,3}$/.test(fallbackIcon.trim())) {
    return fallbackIcon.trim().toUpperCase();
  }
  const words = String(name || "CT")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }
  return String(words[0] || "CT").slice(0, 2).toUpperCase();
}

function stripEmojis(text) {
  return String(text || "")
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = stripEmojis(msg);
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2400);
}

// =========================================================================
// CALCULADORA DE SOMA E SUBTRAÇÃO DE PARCELAS
// =========================================================================
function parseAmountExpression(rawStr) {
  const cleaned = String(rawStr || "")
    .replace(/,/g, ".")
    .replace(/[^0-9.+\-\s]/g, "")
    .trim();
  if (!cleaned) {
    return { total: 0, hasOperator: false, terms: [], trailingOp: null, valid: false };
  }
  const hasOperator = /[+-]/.test(cleaned.slice(1)) || /[+-]\s*$/.test(cleaned);
  const trailingMatch = cleaned.match(/([+-])\s*$/);
  const trailingOp = trailingMatch ? trailingMatch[1] : null;
  const evaluable = cleaned.replace(/[+\-.\s]+$/, "");
  const matches = evaluable.match(/[+-]?\s*\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) {
    return { total: 0, hasOperator, terms: [], trailingOp, valid: false };
  }
  let sum = 0;
  const terms = [];
  matches.forEach((token, idx) => {
    const normalized = token.replace(/\s+/g, "");
    const num = parseFloat(normalized);
    if (!Number.isNaN(num)) {
      sum += num;
      const sign = normalized.startsWith("-") ? "-" : idx > 0 ? "+" : "";
      const absFormatted = Math.abs(num).toLocaleString("pt-PT", {
        minimumFractionDigits: normalized.includes(".") ? 2 : 0,
        maximumFractionDigits: 2
      });
      terms.push(sign ? `${sign} ${absFormatted}` : absFormatted);
    }
  });
  const total = Math.round(sum * 100) / 100;
  return {
    total,
    hasOperator: hasOperator || matches.length > 1,
    terms,
    trailingOp,
    valid: true
  };
}

function updateAmountCalcPreview() {
  const inp = document.getElementById("amountInput");
  const preview = document.getElementById("amountCalcPreview");
  const formulaEl = document.getElementById("calcFormulaText");
  const totalEl = document.getElementById("calcTotalText");
  if (!inp || !preview) return;

  const res = parseAmountExpression(inp.value);
  inp.classList.toggle("is-expression", inp.value.length > 7 || res.hasOperator);

  if (res.hasOperator) {
    preview.classList.remove("hidden");
    const formulaStr = res.terms.join(" ") + (res.trailingOp ? ` ${res.trailingOp} ...` : "");
    formulaEl.textContent = formulaStr || "0,00";
    totalEl.textContent = `= ${formatEuro(res.total)}`;
  } else {
    preview.classList.add("hidden");
  }
}

function appendOperatorToAmount(op) {
  const inp = document.getElementById("amountInput");
  if (!inp) return;
  let val = inp.value.trim();
  if (!val) {
    inp.focus();
    return;
  }
  if (/[+-]\s*$/.test(val)) {
    val = val.replace(/[+-]\s*$/, `${op} `);
  } else {
    val = `${val} ${op} `;
  }
  inp.value = val;
  updateAmountCalcPreview();
  inp.focus();
}

function resolveAmountExpression() {
  const inp = document.getElementById("amountInput");
  if (!inp) return;
  const res = parseAmountExpression(inp.value);
  if (res.valid && res.total > 0) {
    inp.value = res.total.toFixed(2).replace(".", ",");
  } else if (res.valid && res.total <= 0) {
    showToast("O total calculado tem de ser positivo");
    inp.value = "";
  }
  updateAmountCalcPreview();
}

function formatQuickNum(num) {
  const abs = Math.abs(Number(num) || 0);
  const hasCents = Math.round(abs * 100) % 100 !== 0;
  return abs.toLocaleString("pt-PT", {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2
  });
}

function applyQuickAmountDelta(delta) {
  const inp = document.getElementById("amountInput");
  if (!inp) return false;
  const num = Number(delta) || 0;
  if (num === 0) return false;
  const absStr = formatQuickNum(num);
  const val = inp.value.trim();
  let appended = false;

  if (!val) {
    if (num > 0) inp.value = absStr;
  } else if (/[+-]\s*$/.test(val)) {
    if (num < 0) {
      inp.value = val.replace(/[+-]\s*$/, `- ${absStr}`);
    } else {
      inp.value = `${val} ${absStr}`;
    }
    appended = true;
  } else {
    const op = num >= 0 ? "+" : "-";
    inp.value = `${val} ${op} ${absStr}`;
    appended = true;
  }
  updateAmountCalcPreview();
  return appended;
}

function parseChipItem(raw) {
  const str = String(raw || "").trim();
  if (!str) return { label: "", amount: null, raw: "" };
  const match = str.match(/^(.+?)\s*(?:[:=]|\()\s*(\d+(?:[.,]\d{1,2})?)\s*€?\s*\)?$/);
  if (match) {
    const label = match[1].trim();
    const amount = Math.round(parseFloat(match[2].replace(",", ".")) * 100) / 100;
    if (label && !Number.isNaN(amount) && amount > 0) {
      return { label, amount, raw: `${label}: ${amount}` };
    }
  }
  return { label: str, amount: null, raw: str };
}

function formatChipItem(label, amount) {
  const cleanLabel = String(label || "").replace(/[,:]/g, " ").trim();
  const num = amount !== null && amount !== undefined && String(amount).trim() !== ""
    ? Math.round(parseFloat(String(amount).replace(",", ".")) * 100) / 100
    : null;
  if (num && !Number.isNaN(num) && num > 0) {
    return `${cleanLabel}: ${num}`;
  }
  return cleanLabel;
}

// =========================================================================
// INICIALIZAÇÃO
// =========================================================================
document.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  loadLocalState();
  initInputs();
  processLocalRecurringIfNeeded();
  renderAll();
  bindEvents();

  await syncWithBackendAndCloud();

  window.addEventListener("online", () => syncWithBackendAndCloud());
  window.addEventListener("offline", () => updateSyncIndicator(state.serverOnline, isGitHubConfigured()));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      syncWithBackendAndCloud();
    }
  });
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (isGitHubConfigured()) {
      // Cloud GitHub: verifica alterações de outros dispositivos de 30 em 30 segundos.
      if (Date.now() - lastCloudAttempt >= 30000) syncWithBackendAndCloud();
      return;
    }
    if (!state.serverOnline || state.pendingIds.size > 0) {
      syncWithBackendAndCloud();
    }
  }, 10000);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js?v=17").catch(() => {});
  }
});

function initTheme() {
  const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME) || "dark";
  document.documentElement.setAttribute("data-theme", savedTheme);
}

function loadLocalState() {
  try {
    const rawTxs = localStorage.getItem(STORAGE_KEYS.TXS) || localStorage.getItem("financas_transactions_v3");
    if (rawTxs) state.transactions = JSON.parse(rawTxs);

    const rawAccs = localStorage.getItem(STORAGE_KEYS.ACCOUNTS);
    if (rawAccs) state.accounts = JSON.parse(rawAccs);

    const rawCats = localStorage.getItem(STORAGE_KEYS.CATEGORIES);
    if (rawCats) state.categories = JSON.parse(rawCats);

    const rawQa = localStorage.getItem(STORAGE_KEYS.QUICK_AMOUNTS);
    if (rawQa) {
      const parsedQa = JSON.parse(rawQa);
      if (Array.isArray(parsedQa) && parsedQa.length > 0) state.quickAmounts = parsedQa;
    }

    const rawRec = localStorage.getItem(STORAGE_KEYS.RECURRING) || localStorage.getItem("financas_recurring_v3");
    if (rawRec) state.recurring = JSON.parse(rawRec);

    const rawPending = localStorage.getItem(STORAGE_KEYS.PENDING);
    if (rawPending) state.pendingIds = new Set(JSON.parse(rawPending));

    const rawCfg = localStorage.getItem(STORAGE_KEYS.CLOUD_CFG);
    if (rawCfg) state.cloudConfig = { ...state.cloudConfig, ...JSON.parse(rawCfg) };

    const rawMeta = localStorage.getItem(STORAGE_KEYS.GIT_META);
    gitMeta = FinCloud.normalizeMeta(rawMeta ? JSON.parse(rawMeta) : null, currentRepoKey());
  } catch (e) {
    console.error("Erro ao carregar estado local:", e);
  }
}

function saveLocalState() {
  // Deteta e carimba alterações locais (edições / remoções) para o merge com a cloud.
  if (isGitHubConfigured()) {
    calculateAccountBalances(); // normaliza ícones para que o carimbo seja estável
    FinCloud.stampLocalChanges(state, gitMeta, Date.now());
  }
  localStorage.setItem(STORAGE_KEYS.TXS, JSON.stringify(state.transactions));
  localStorage.setItem(STORAGE_KEYS.ACCOUNTS, JSON.stringify(state.accounts));
  localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(state.categories));
  localStorage.setItem(STORAGE_KEYS.QUICK_AMOUNTS, JSON.stringify(state.quickAmounts));
  localStorage.setItem(STORAGE_KEYS.RECURRING, JSON.stringify(state.recurring));
  localStorage.setItem(STORAGE_KEYS.PENDING, JSON.stringify(Array.from(state.pendingIds)));
  localStorage.setItem(STORAGE_KEYS.CLOUD_CFG, JSON.stringify(state.cloudConfig));
  localStorage.setItem(STORAGE_KEYS.GIT_META, JSON.stringify(gitMeta));
  localVersion++;
  if (!suppressCloudSchedule) scheduleGitSync();
}

function initInputs() {
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById("dateInput").value = today;
  document.getElementById("globalMonthPicker").value = state.selectedMonth;

  const cfg = state.cloudConfig;
  document.getElementById("cloudProviderSelect").value = cfg.provider || "none";
  document.getElementById("webhookUrlInput").value = cfg.webhook_url || "";
  document.getElementById("supabaseUrlInput").value = cfg.supabase_url || "";
  document.getElementById("supabaseKeyInput").value = cfg.supabase_key || "";
  document.getElementById("githubOwnerInput").value = cfg.github_owner || "";
  document.getElementById("githubRepoInput").value = cfg.github_repo || "financas-data";
  document.getElementById("githubTokenInput").value = cfg.github_token || "";
  toggleCloudProviderInputs();
}

function toggleCloudProviderInputs() {
  const provider = document.getElementById("cloudProviderSelect").value;
  document.getElementById("webhookConfigBox").classList.toggle("hidden", provider !== "webhook");
  document.getElementById("supabaseConfigBox").classList.toggle("hidden", provider !== "supabase");
  document.getElementById("githubConfigBox").classList.toggle("hidden", provider !== "github");
}

// =========================================================================
// CÁLCULO DE SALDOS DE CONTAS E DEDUÇÕES RECORRENTES
// =========================================================================
function calculateAccountBalances() {
  state.accounts.forEach((acc) => {
    acc.icon = getMonogram(acc.name, acc.icon);
    let bal = Number(acc.initial_balance || 0);
    const accName = acc.name;
    state.transactions.forEach((t) => {
      const amt = Number(t.amount || 0);
      const tAcc = t.account || "Dinheiro Geral";
      const tToAcc = t.to_account || "";
      if (t.type === "Receita" && tAcc === accName) bal += amt;
      else if (t.type === "Despesa" && tAcc === accName) bal -= amt;
      else if (t.type === "Transferência") {
        if (tAcc === accName) bal -= amt;
        if (tToAcc === accName) bal += amt;
      }
    });
    acc.current_balance = Math.round(bal * 100) / 100;
  });

  state.categories.forEach((cat) => {
    cat.icon = getMonogram(cat.name, cat.icon);
  });
}

function processLocalRecurringIfNeeded(forceAll = false) {
  const now = new Date();
  const currentMonth = now.toISOString().slice(0, 7);
  const currentDay = now.getDate();
  let createdCount = 0;

  state.recurring.forEach((rec) => {
    if (!rec.active) return;
    if (rec.last_processed_month === currentMonth) return;

    const dueDay = Number(rec.day_of_month || 1);
    if (forceAll || currentDay >= dueDay) {
      const dayStr = String(Math.min(currentDay, dueDay)).padStart(2, "0");
      const txId = `TX-REC-${rec.id}-${currentMonth}`;

      if (!state.transactions.some((t) => t.id === txId)) {
        const newTx = {
          id: txId,
          date: `${currentMonth}-${dayStr}`,
          time: "09:00",
          type: rec.type || "Despesa",
          account: rec.account || "Dinheiro Geral",
          to_account: "",
          category: rec.category || "Subscrições",
          description: `${stripEmojis(rec.description)} (Recorrente)`,
          amount: Number(rec.amount || 0),
          payment_method: rec.payment_method || "Débito Direto",
          month_year: currentMonth
        };
        state.transactions.unshift(newTx);
        state.pendingIds.add(newTx.id);
        createdCount++;
      }
      rec.last_processed_month = currentMonth;
    }
  });

  if (createdCount > 0) {
    saveLocalState();
    showToast(`${createdCount} movimento(s) recorrente(s) processado(s)`);
  }
  return createdCount;
}

// =========================================================================
// RENDERIZAÇÃO DA INTERFACE
// =========================================================================
function renderAll() {
  calculateAccountBalances();
  renderQuickAmounts();
  renderAccountsStrip();
  renderFormAccountPills();
  renderCategories();
  renderNoteSuggestions();
  renderAccountsManageTab();
  renderCategoriesManageTab();
  renderRecurringManageTab();
  populateSelectDropdowns();
  updateUI();
}

function renderQuickAmounts() {
  const row = document.getElementById("quickAmountsRow");
  if (!row) return;
  row.innerHTML = "";

  const list = Array.isArray(state.quickAmounts) && state.quickAmounts.length > 0
    ? state.quickAmounts
    : DEFAULT_QUICK_AMOUNTS;

  list.forEach((val) => {
    const num = Number(val);
    if (Number.isNaN(num) || num === 0) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip-btn";
    const sign = num > 0 ? "+" : "-";
    btn.textContent = `${sign}${formatQuickNum(num)}`;
    btn.addEventListener("click", () => {
      applyQuickAmountDelta(num);
    });
    row.appendChild(btn);
  });

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "chip-btn chip-edit-trigger";
  editBtn.title = "Personalizar botões de valores rápidos";
  editBtn.textContent = "✎ Valores";
  editBtn.addEventListener("click", () => openQuickAmountsModal());
  row.appendChild(editBtn);
}

function renderAccountsStrip() {
  const strip = document.getElementById("accountsStrip");
  const totalPatrimonio = state.accounts.reduce((acc, a) => acc + Number(a.current_balance || 0), 0);

  if (strip) {
    strip.innerHTML = "";

    const allCard = document.createElement("div");
    allCard.className = `account-card-mini ${state.activeAccountFilter === "ALL" ? "active" : ""}`;
    allCard.innerHTML = `
      <div class="acc-top"><span>Visão Global</span><span>TOTAL</span></div>
      <div class="acc-bal">${formatEuro(totalPatrimonio)}</div>
    `;
    allCard.addEventListener("click", () => {
      state.activeAccountFilter = "ALL";
      const hist = document.getElementById("historyAccountFilter");
      if (hist) hist.value = "ALL";
      renderAccountsStrip();
      updateUI();
    });
    strip.appendChild(allCard);

    state.accounts.forEach((acc) => {
      const card = document.createElement("div");
      card.className = `account-card-mini ${state.activeAccountFilter === acc.name ? "active" : ""}`;
      card.innerHTML = `
        <div class="acc-top"><span>${acc.name}</span><span>${getMonogram(acc.name, acc.icon)}</span></div>
        <div class="acc-bal">${formatEuro(acc.current_balance)}</div>
      `;
      card.addEventListener("click", () => {
        state.activeAccountFilter = acc.name;
        state.selectedAccount = acc.name;
        const hist = document.getElementById("historyAccountFilter");
        if (hist) hist.value = acc.name;
        renderAccountsStrip();
        renderFormAccountPills();
        updateUI();
      });
      strip.appendChild(card);
    });
  }

  // Renderizar também a lista de contas na Sidebar Esquerda do Computador
  const sideList = document.getElementById("sidebarAccountsList");
  if (sideList) {
    sideList.innerHTML = "";
    const allRow = document.createElement("div");
    allRow.className = `sidebar-acc-row ${state.activeAccountFilter === "ALL" ? "active" : ""}`;
    allRow.innerHTML = `<span>Visão Global</span><span class="s-val">${formatEuro(totalPatrimonio)}</span>`;
    allRow.addEventListener("click", () => {
      state.activeAccountFilter = "ALL";
      document.getElementById("historyAccountFilter").value = "ALL";
      renderAccountsStrip();
      updateUI();
    });
    sideList.appendChild(allRow);

    state.accounts.forEach((acc) => {
      const row = document.createElement("div");
      row.className = `sidebar-acc-row ${state.activeAccountFilter === acc.name ? "active" : ""}`;
      row.innerHTML = `<span>${acc.name}</span><span class="s-val">${formatEuro(acc.current_balance)}</span>`;
      row.addEventListener("click", () => {
        state.activeAccountFilter = acc.name;
        state.selectedAccount = acc.name;
        document.getElementById("historyAccountFilter").value = acc.name;
        const regTab = document.getElementById("tab-registar");
        const movTab = document.getElementById("tab-movimentos");
        const metTab = document.getElementById("tab-metricas");
        if (regTab.classList.contains("hidden") && movTab.classList.contains("hidden") && metTab.classList.contains("hidden")) {
          switchTab("tab-registar");
          return;
        }
        renderAccountsStrip();
        renderFormAccountPills();
        updateUI();
      });
      sideList.appendChild(row);
    });
  }
}

function renderFormAccountPills() {
  const fromBox = document.getElementById("formAccountPills");
  const toBox = document.getElementById("formToAccountPills");
  fromBox.innerHTML = "";
  toBox.innerHTML = "";

  const isSplitSelected = state.selectedAccount === "SPLIT_MAE_PAI";
  if (!isSplitSelected && !state.accounts.some((a) => a.name === state.selectedAccount) && state.accounts.length > 0) {
    state.selectedAccount = state.accounts[0].name;
    if (state.activeAccountFilter !== "ALL") {
      state.activeAccountFilter = state.selectedAccount;
    }
  }

  const badgeEl = document.getElementById("selectedAccountBalanceBadge");
  if (badgeEl) {
    if (isSplitSelected) {
      const mae = state.accounts.find((a) => a.name === "Comida Mãe");
      const pai = state.accounts.find((a) => a.name === "Comida Pai");
      const splitTotal = Number(mae ? mae.current_balance : 0) + Number(pai ? pai.current_balance : 0);
      badgeEl.textContent = `Saldo conjunto: ${formatEuro(splitTotal)}`;
    } else {
      const selAcc = state.accounts.find((a) => a.name === state.selectedAccount);
      badgeEl.textContent = selAcc ? `Saldo: ${formatEuro(selAcc.current_balance)}` : "";
    }
  }

  state.accounts.forEach((acc) => {
    const isSelected = acc.name === state.selectedAccount;
    const pill = document.createElement("div");
    pill.className = `acc-pill ${isSelected ? "selected" : ""}`;
    pill.innerHTML = isSelected
      ? `<span>${acc.name}</span><span class="pill-bal">· ${formatEuro(acc.current_balance)}</span>`
      : `<span>${acc.name}</span>`;
    pill.addEventListener("click", () => {
      state.selectedAccount = acc.name;
      state.activeAccountFilter = acc.name;
      const histFilter = document.getElementById("historyAccountFilter");
      if (histFilter) histFilter.value = acc.name;
      if (state.selectedToAccount === acc.name) {
        const other = state.accounts.find((a) => a.name !== acc.name);
        if (other) state.selectedToAccount = other.name;
      }
      renderFormAccountPills();
      updateUI();
    });
    fromBox.appendChild(pill);

    const toPill = document.createElement("div");
    toPill.className = `acc-pill ${acc.name === state.selectedToAccount ? "selected" : ""}`;
    toPill.textContent = acc.name;
    toPill.addEventListener("click", () => {
      state.selectedToAccount = acc.name;
      renderFormAccountPills();
    });
    toBox.appendChild(toPill);
  });

  const hasMae = state.accounts.some((a) => a.name === "Comida Mãe");
  const hasPai = state.accounts.some((a) => a.name === "Comida Pai");
  if (state.currentType !== "Transferência" && hasMae && hasPai) {
    const splitPill = document.createElement("div");
    splitPill.className = `acc-pill ${isSplitSelected ? "selected" : ""}`;
    splitPill.textContent = "Dividir 50/50 (Mãe + Pai)";
    splitPill.addEventListener("click", () => {
      state.selectedAccount = "SPLIT_MAE_PAI";
      state.activeAccountFilter = "ALL";
      renderFormAccountPills();
      updateUI();
    });
    fromBox.appendChild(splitPill);
  }
}

function renderCategories() {
  const isTransfer = state.currentType === "Transferência";
  document.getElementById("transferToBox").classList.toggle("hidden", !isTransfer);
  document.getElementById("categorySectionBox").classList.toggle("hidden", isTransfer);
  document.getElementById("paymentSectionBox").classList.toggle("hidden", isTransfer);
  document.getElementById("fromAccountLabel").textContent = isTransfer
    ? "Conta de Origem"
    : "Conta";
  document.getElementById("mainSubmitBtn").innerHTML = isTransfer
    ? "<span>Confirmar Transferência</span>"
    : "<span>Guardar Registo</span>";

  if (isTransfer) return;

  const grid = document.getElementById("categoryGrid");
  grid.innerHTML = "";

  const filtered = state.categories.filter((c) => c.type === state.currentType);
  if (!filtered.some((c) => c.name === state.selectedCategory) && filtered.length > 0) {
    state.selectedCategory = filtered[0].name;
  }

  filtered.forEach((cat) => {
    const div = document.createElement("div");
    div.className = `cat-item ${cat.name === state.selectedCategory ? "selected" : ""}`;
    div.innerHTML = `<span class="cat-name">${cat.name}</span>`;
    div.addEventListener("click", () => {
      state.selectedCategory = cat.name;
      document.getElementById("selectedCatLabel").textContent = cat.name;
      renderCategories();
      renderNoteSuggestions();
    });
    grid.appendChild(div);
  });

  const activeCat = filtered.find((c) => c.name === state.selectedCategory);
  if (activeCat) {
    document.getElementById("selectedCatLabel").textContent = activeCat.name;
  }
}

function renderNoteSuggestions() {
  const box = document.getElementById("noteSuggestions");
  if (!box) return;
  box.innerHTML = "";
  const catObj = state.categories.find((c) => c.name === state.selectedCategory);
  let chips = ["Café", "Almoço", "Compras"];
  if (catObj && catObj.chips) {
    chips = Array.isArray(catObj.chips)
      ? catObj.chips
      : String(catObj.chips).split(",").map((s) => s.trim()).filter(Boolean);
  }

  chips.forEach((rawChip) => {
    const parsed = parseChipItem(rawChip);
    if (!parsed.label) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip-btn";
    if (parsed.amount !== null) {
      btn.innerHTML = `<span>${parsed.label}</span><span class="chip-price-badge">${formatQuickNum(parsed.amount)} €</span>`;
    } else {
      btn.textContent = parsed.label;
    }
    btn.addEventListener("click", () => {
      const descInp = document.getElementById("descriptionInput");
      if (parsed.amount !== null) {
        const wasAppended = applyQuickAmountDelta(parsed.amount);
        const curDesc = descInp.value.trim();
        if (wasAppended && curDesc && !curDesc.toLowerCase().includes(parsed.label.toLowerCase())) {
          descInp.value = `${curDesc} + ${parsed.label}`;
        } else if (!curDesc || !wasAppended) {
          descInp.value = parsed.label;
        }
      } else {
        descInp.value = parsed.label;
      }
    });
    box.appendChild(btn);
  });
}

function renderAccountsManageTab() {
  const list = document.getElementById("accountsManageList");
  list.innerHTML = "";

  state.accounts.forEach((acc) => {
    const div = document.createElement("div");
    div.className = "tx-item";
    div.innerHTML = `
      <div class="tx-left">
        <div class="tx-monogram">${getMonogram(acc.name, acc.icon)}</div>
        <div class="tx-info">
          <div class="tx-title">${acc.name}</div>
          <div class="tx-meta">${acc.description || "Conta"} · Inicial: ${formatEuro(acc.initial_balance)}</div>
        </div>
      </div>
      <div class="tx-right">
        <div class="tx-amount ${acc.current_balance >= 0 ? "Receita" : "Despesa"}">${formatEuro(acc.current_balance)}</div>
        <button type="button" class="mini-action-btn edit-acc">Editar</button>
        <button type="button" class="mini-action-btn danger del-acc">Apagar</button>
      </div>
    `;

    div.querySelector(".edit-acc").addEventListener("click", () => openAccountModal(acc));
    div.querySelector(".del-acc").addEventListener("click", async () => {
      if (state.accounts.length <= 1) {
        showToast("Deve existir pelo menos 1 conta");
        return;
      }
      state.accounts = state.accounts.filter((a) => a.id !== acc.id);
      saveLocalState();
      renderAll();
      try {
        await fetch(`/api/accounts/${encodeURIComponent(acc.id)}`, { method: "DELETE" });
      } catch (_) {}
      showToast("Conta eliminada");
    });

    list.appendChild(div);
  });
}

function renderCategoriesManageTab() {
  const list = document.getElementById("categoriesManageList");
  list.innerHTML = "";

  state.categories.forEach((cat) => {
    const div = document.createElement("div");
    div.className = "tx-item";
    const chipsText = Array.isArray(cat.chips) ? cat.chips.join(", ") : cat.chips || "";
    div.innerHTML = `
      <div class="tx-left">
        <div class="tx-monogram">${getMonogram(cat.name, cat.icon)}</div>
        <div class="tx-info">
          <div class="tx-title">${cat.name} <span class="tx-account-badge">${cat.type}</span></div>
          <div class="tx-meta">${chipsText || "Sem sugestões rápidas"}</div>
        </div>
      </div>
      <div class="tx-right">
        <button type="button" class="mini-action-btn edit-cat">Editar</button>
        <button type="button" class="mini-action-btn danger del-cat">Apagar</button>
      </div>
    `;

    div.querySelector(".edit-cat").addEventListener("click", () => openCategoryModal(cat));
    div.querySelector(".del-cat").addEventListener("click", async () => {
      state.categories = state.categories.filter((c) => c.id !== cat.id);
      saveLocalState();
      renderAll();
      try {
        await fetch(`/api/categories/${encodeURIComponent(cat.id)}`, { method: "DELETE" });
      } catch (_) {}
      showToast("Categoria removida");
    });

    list.appendChild(div);
  });
}

function renderRecurringManageTab() {
  const list = document.getElementById("recurringManageList");
  list.innerHTML = "";

  if (state.recurring.length === 0) {
    list.innerHTML = `<p style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 14px 0;">Sem deduções recorrentes configuradas.</p>`;
    return;
  }

  state.recurring.forEach((rec) => {
    const div = document.createElement("div");
    div.className = "tx-item";
    const sign = rec.type === "Despesa" ? "-" : "+";
    div.innerHTML = `
      <div class="tx-left">
        <div class="tx-monogram">D${rec.day_of_month}</div>
        <div class="tx-info">
          <div class="tx-title">${stripEmojis(rec.description)}</div>
          <div class="tx-meta">Dia ${rec.day_of_month} · <span class="tx-account-badge">${rec.account}</span> · ${rec.category}</div>
        </div>
      </div>
      <div class="tx-right">
        <div class="tx-amount ${rec.type}">${sign}${formatEuro(rec.amount)}</div>
        <button type="button" class="mini-action-btn edit-rec">Editar</button>
        <button type="button" class="mini-action-btn danger del-rec">Apagar</button>
      </div>
    `;

    div.querySelector(".edit-rec").addEventListener("click", () => openRecurringModal(rec));
    div.querySelector(".del-rec").addEventListener("click", async () => {
      state.recurring = state.recurring.filter((r) => r.id !== rec.id);
      saveLocalState();
      renderRecurringManageTab();
      try {
        await fetch(`/api/recurring/${encodeURIComponent(rec.id)}`, { method: "DELETE" });
      } catch (_) {}
      showToast("Dedução recorrente eliminada");
    });

    list.appendChild(div);
  });
}

function populateSelectDropdowns() {
  const accOptions = state.accounts.map((a) => `<option value="${a.name}">${a.name}</option>`).join("");
  const catOptions = state.categories.map((c) => `<option value="${c.name}">${c.name} (${c.type})</option>`).join("");

  document.getElementById("editTxAccount").innerHTML = accOptions;
  document.getElementById("recAccountInput").innerHTML = accOptions;

  document.getElementById("editTxCategory").innerHTML =
    catOptions + `<option value="Transferência">Transferência</option>`;
  document.getElementById("recCategoryInput").innerHTML = catOptions;

  const histFilter = document.getElementById("historyAccountFilter");
  const currentFilterVal = histFilter.value || "ALL";
  histFilter.innerHTML = `<option value="ALL">Todas as Contas</option>` + accOptions;
  histFilter.value = currentFilterVal;
}

// =========================================================================
// ATUALIZAÇÃO DE KPIS, LISTAS E MÉTRICAS
// =========================================================================
function updateUI() {
  calculateAccountBalances();
  renderAccountsStrip();

  const filterAcc = state.activeAccountFilter;
  document.getElementById("activeAccountFilterLabel").textContent =
    filterAcc === "ALL" ? "" : `(${filterAcc})`;

  const monthTxs = state.transactions.filter((t) => {
    const matchesMonth = (t.month_year || t.date.slice(0, 7)) === state.selectedMonth;
    if (!matchesMonth) return false;
    if (filterAcc === "ALL") return true;
    return t.account === filterAcc || t.to_account === filterAcc;
  });

  const expenses = monthTxs
    .filter((t) => t.type === "Despesa" && (filterAcc === "ALL" || t.account === filterAcc))
    .reduce((acc, t) => acc + Number(t.amount || 0), 0);

  const income = monthTxs
    .filter((t) => t.type === "Receita" && (filterAcc === "ALL" || t.account === filterAcc))
    .reduce((acc, t) => acc + Number(t.amount || 0), 0);

  let displayBalance = income - expenses;
  const kpiLbl = document.getElementById("kpiBalanceLabel");
  if (filterAcc === "ALL") {
    displayBalance = state.accounts.reduce((acc, a) => acc + Number(a.current_balance || 0), 0);
    if (kpiLbl) kpiLbl.textContent = "Património Total";
  } else {
    const accObj = state.accounts.find((a) => a.name === filterAcc);
    if (accObj) displayBalance = accObj.current_balance;
    if (kpiLbl) kpiLbl.textContent = `Saldo ${filterAcc.split(" ")[0]}`;
  }

  const allAccountsTotal = state.accounts.reduce((acc, a) => acc + Number(a.current_balance || 0), 0);
  const balEl = document.getElementById("kpiBalance");
  if (balEl) balEl.textContent = formatEuro(allAccountsTotal);

  const expEl = document.getElementById("kpiExpenses");
  if (expEl) expEl.textContent = formatEuro(expenses);

  const incEl = document.getElementById("kpiIncome");
  if (incEl) incEl.textContent = formatEuro(income);

  const netMonth = income - expenses;
  const netEl = document.getElementById("kpiNetMonth");
  if (netEl) {
    const sign = netMonth > 0 ? "+" : "";
    netEl.textContent = `${sign}${formatEuro(netMonth)}`;
    netEl.style.color = netMonth >= 0 ? "var(--income-color)" : "var(--expense-color)";
  }

  renderRecentList(monthTxs);
  renderFullHistory();
  renderMetrics(monthTxs, expenses);
  renderDashboardAccounts();
  renderDesktopSidePanel(monthTxs, expenses);
}

function renderDashboardAccounts() {
  const grid = document.getElementById("dashboardAccountsGrid");
  if (!grid) return;
  grid.innerHTML = "";

  const allMonthTxs = state.transactions.filter(
    (t) => (t.month_year || t.date.slice(0, 7)) === state.selectedMonth
  );

  state.accounts.forEach((acc) => {
    const accExp = allMonthTxs
      .filter((t) => t.type === "Despesa" && t.account === acc.name)
      .reduce((s, t) => s + Number(t.amount || 0), 0);
    const accInc = allMonthTxs
      .filter((t) => t.type === "Receita" && t.account === acc.name)
      .reduce((s, t) => s + Number(t.amount || 0), 0);

    const card = document.createElement("div");
    card.className = `dash-acc-card ${state.selectedAccount === acc.name ? "active" : ""}`;
    card.innerHTML = `
      <div class="dash-acc-header">
        <div class="dash-acc-name-wrap">
          <span class="tx-account-badge">${getMonogram(acc.name, acc.icon)}</span>
          <span class="dash-acc-name">${acc.name}</span>
        </div>
        <div class="dash-acc-bal">${formatEuro(acc.current_balance)}</div>
      </div>
      <div class="dash-acc-metrics">
        <span>Gastos: <strong style="color: var(--expense-color);">${formatEuro(accExp)}</strong></span>
        <span>Receitas: <strong style="color: var(--income-color);">${formatEuro(accInc)}</strong></span>
      </div>
      <button type="button" class="mini-action-btn dash-go-acc" style="width: 100%; margin-top: 2px;">Registar nesta conta →</button>
    `;
    card.querySelector(".dash-go-acc").addEventListener("click", () => {
      state.selectedAccount = acc.name;
      state.activeAccountFilter = acc.name;
      const histFilter = document.getElementById("historyAccountFilter");
      if (histFilter) histFilter.value = acc.name;
      switchTab("tab-registar");
    });
    grid.appendChild(card);
  });
}

function getCategoryMonogram(catName, txType) {
  if (txType === "Transferência") return "TR";
  const found = state.categories.find((c) => c.name === catName);
  return found ? getMonogram(found.name, found.icon) : getMonogram(catName);
}

function createTxElement(tx) {
  const div = document.createElement("div");
  div.className = "tx-item";
  const isTransfer = tx.type === "Transferência";
  const sign = isTransfer ? "" : tx.type === "Despesa" ? "-" : "+";
  const mono = getCategoryMonogram(tx.category, tx.type);
  const dateFormatted = (tx.date || "").split("-").reverse().join("/");
  const accountBadge = isTransfer
    ? `${tx.account} -> ${tx.to_account}`
    : tx.account || "Dinheiro Geral";

  div.innerHTML = `
    <div class="tx-left">
      <div class="tx-monogram">${mono}</div>
      <div class="tx-info">
        <div class="tx-title">${stripEmojis(tx.description || tx.category)}</div>
        <div class="tx-meta">
          <span class="tx-account-badge">${accountBadge}</span> · ${tx.category} · ${dateFormatted}
        </div>
      </div>
    </div>
    <div class="tx-right">
      <div class="tx-amount ${tx.type}">${sign}${formatEuro(tx.amount)}</div>
      <button type="button" class="mini-action-btn edit-tx-btn">Editar</button>
      <button type="button" class="mini-action-btn danger delete-tx-btn">Apagar</button>
    </div>
  `;

  div.querySelector(".edit-tx-btn").addEventListener("click", () => openEditTxModal(tx));

  div.querySelector(".delete-tx-btn").addEventListener("click", async () => {
    state.transactions = state.transactions.filter((t) => t.id !== tx.id);
    state.pendingIds.delete(tx.id);
    saveLocalState();
    updateUI();
    try {
      await fetch(`/api/transactions/${encodeURIComponent(tx.id)}`, { method: "DELETE" });
    } catch (_) {}
    showToast("Registo removido");
  });

  return div;
}

function renderRecentList(monthTxs) {
  const container = document.getElementById("recentTxList");
  container.innerHTML = "";
  const qInp = document.getElementById("quickDashboardSearch");
  const query = (qInp ? qInp.value : "").toLowerCase().trim();

  let filtered = monthTxs;
  if (query) {
    filtered = monthTxs.filter(
      (t) =>
        (t.description || "").toLowerCase().includes(query) ||
        (t.category || "").toLowerCase().includes(query) ||
        (t.account || "").toLowerCase().includes(query)
    );
  }

  const limit = window.innerWidth >= 1024 ? 14 : 7;
  const visible = filtered.slice(0, limit);

  if (visible.length === 0) {
    container.innerHTML = `<p style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 20px 0;">Sem movimentos neste filtro.</p>`;
    return;
  }
  visible.forEach((tx) => container.appendChild(createTxElement(tx)));
}

function renderFullHistory() {
  const container = document.getElementById("fullTxList");
  const query = (document.getElementById("searchTxInput").value || "").toLowerCase().trim();
  const accFilter = document.getElementById("historyAccountFilter").value || "ALL";

  const filtered = state.transactions.filter((t) => {
    const matchesMonth = (t.month_year || t.date.slice(0, 7)) === state.selectedMonth;
    if (!matchesMonth) return false;
    if (accFilter !== "ALL" && t.account !== accFilter && t.to_account !== accFilter) return false;
    if (!query) return true;
    return (
      (t.description || "").toLowerCase().includes(query) ||
      (t.category || "").toLowerCase().includes(query) ||
      (t.account || "").toLowerCase().includes(query) ||
      (t.payment_method || "").toLowerCase().includes(query)
    );
  });

  document.getElementById("txTotalCount").textContent = `${filtered.length} registo(s)`;
  container.innerHTML = "";

  if (filtered.length === 0) {
    container.innerHTML = `<p style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 20px 0;">Nenhum movimento encontrado.</p>`;
    return;
  }

  filtered.forEach((tx) => container.appendChild(createTxElement(tx)));
}

function renderMetrics(monthTxs, totalExpenses) {
  const expenseCats = state.categories.filter((c) => c.type === "Despesa");
  const totalEl = document.getElementById("totalBudgetPct");
  if (totalEl) {
    totalEl.textContent = `Total: ${formatEuro(totalExpenses)}`;
  }

  const list = document.getElementById("categoryMetricsList");
  list.innerHTML = "";

  expenseCats.forEach((cat) => {
    const spent = monthTxs
      .filter((t) => t.type === "Despesa" && t.category === cat.name)
      .reduce((acc, t) => acc + Number(t.amount || 0), 0);

    const pct = totalExpenses > 0 ? Math.min(100, Math.round((spent / totalExpenses) * 100)) : 0;

    const item = document.createElement("div");
    item.className = "cat-progress-item";
    item.innerHTML = `
      <div class="cat-progress-header">
        <span>${cat.name}</span>
        <span>${formatEuro(spent)} <span style="color: var(--text-muted); font-weight: 400;">(${pct}%)</span></span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width: ${pct}%;"></div>
      </div>
    `;
    list.appendChild(item);
  });
}

function renderDesktopSidePanel(monthTxs, totalExpenses) {
  const sideMetrics = document.getElementById("desktopSideMetricsList");
  if (sideMetrics) {
    sideMetrics.innerHTML = "";
    const expenseCats = state.categories.filter((c) => c.type === "Despesa");
    expenseCats.forEach((cat) => {
      const spent = monthTxs
        .filter((t) => t.type === "Despesa" && t.category === cat.name)
        .reduce((acc, t) => acc + Number(t.amount || 0), 0);
      const pct = totalExpenses > 0 ? Math.min(100, Math.round((spent / totalExpenses) * 100)) : 0;
      const item = document.createElement("div");
      item.className = "cat-progress-item";
      item.innerHTML = `
        <div class="cat-progress-header">
          <span>${cat.name}</span>
          <span>${formatEuro(spent)} <span style="color: var(--text-muted); font-weight: 400;">(${pct}%)</span></span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width: ${pct}%;"></div>
        </div>
      `;
      sideMetrics.appendChild(item);
    });
  }

  const sideRec = document.getElementById("desktopSideRecurringList");
  if (sideRec) {
    sideRec.innerHTML = "";
    if (state.recurring.length === 0) {
      sideRec.innerHTML = `<p style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 12px 0;">Sem deduções recorrentes.</p>`;
    } else {
      state.recurring.forEach((rec) => {
        const div = document.createElement("div");
        div.className = "tx-item";
        const sign = rec.type === "Despesa" ? "-" : "+";
        div.innerHTML = `
          <div class="tx-left">
            <div class="tx-monogram">D${rec.day_of_month}</div>
            <div class="tx-info">
              <div class="tx-title">${stripEmojis(rec.description)}</div>
              <div class="tx-meta">${rec.account} · ${rec.category}</div>
            </div>
          </div>
          <div class="tx-right">
            <div class="tx-amount ${rec.type}">${sign}${formatEuro(rec.amount)}</div>
          </div>
        `;
        sideRec.appendChild(div);
      });
    }
  }
}

// =========================================================================
// MODAIS
// =========================================================================
function openEditTxModal(tx) {
  populateSelectDropdowns();
  document.getElementById("editTxId").value = tx.id;
  document.getElementById("editTxType").value = tx.type || "Despesa";
  document.getElementById("editTxAmount").value = tx.amount;
  document.getElementById("editTxAccount").value = tx.account || "Dinheiro Geral";
  document.getElementById("editTxCategory").value = tx.category || "Outros";
  document.getElementById("editTxDesc").value = stripEmojis(tx.description || "");
  document.getElementById("editTxDate").value = tx.date;
  document.getElementById("editTxMethod").value = tx.payment_method || "MBWay";
  document.getElementById("editTxModal").classList.remove("hidden");
}

function openAccountModal(acc = null) {
  document.getElementById("accountModalTitle").textContent = acc ? "Editar Conta" : "Nova Conta";
  document.getElementById("accIdInput").value = acc ? acc.id : "";
  document.getElementById("accNameInput").value = acc ? acc.name : "";
  document.getElementById("accIconInput").value = acc ? getMonogram(acc.name, acc.icon) : "CT";
  document.getElementById("accBalanceInput").value = acc ? acc.initial_balance : 0;
  document.getElementById("accDescInput").value = acc ? acc.description || "" : "";
  document.getElementById("accountModal").classList.remove("hidden");
}

let tempQuickAmounts = [];

function renderCatChipsModalPreview() {
  const preview = document.getElementById("catChipsListPreview");
  const input = document.getElementById("catChipsInput");
  if (!preview || !input) return;
  preview.innerHTML = "";
  const items = input.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (items.length === 0) {
    preview.innerHTML = `<span style="color: var(--text-muted); font-size: 11.5px;">Sem sugestões adicionadas.</span>`;
    return;
  }

  items.forEach((raw, idx) => {
    const parsed = parseChipItem(raw);
    const pill = document.createElement("div");
    pill.className = "editable-chip-pill";
    const priceTxt = parsed.amount !== null ? ` · ${formatQuickNum(parsed.amount)} €` : "";
    pill.innerHTML = `<span>${parsed.label}${priceTxt}</span><span class="remove-chip-x" title="Remover">×</span>`;
    pill.addEventListener("click", (e) => {
      if (e.target.classList.contains("remove-chip-x")) {
        items.splice(idx, 1);
        input.value = items.join(", ");
        renderCatChipsModalPreview();
      } else {
        document.getElementById("newChipLabelInput").value = parsed.label;
        document.getElementById("newChipPriceInput").value = parsed.amount !== null ? String(parsed.amount).replace(".", ",") : "";
        items.splice(idx, 1);
        input.value = items.join(", ");
        renderCatChipsModalPreview();
        document.getElementById("newChipLabelInput").focus();
      }
    });
    preview.appendChild(pill);
  });
}

function openCategoryModal(cat = null) {
  document.getElementById("categoryModalTitle").textContent = cat ? "Editar Categoria" : "Nova Categoria";
  document.getElementById("catIdInput").value = cat ? cat.id : "";
  document.getElementById("catNameInput").value = cat ? cat.name : "";
  document.getElementById("catIconInput").value = cat ? getMonogram(cat.name, cat.icon) : "CT";
  document.getElementById("catTypeInput").value = cat ? cat.type : state.currentType === "Receita" ? "Receita" : "Despesa";
  document.getElementById("catBudgetInput").value = cat ? cat.budget : 150;
  const chipsStr = cat && cat.chips ? (Array.isArray(cat.chips) ? cat.chips.join(", ") : cat.chips) : "";
  document.getElementById("catChipsInput").value = chipsStr;
  document.getElementById("newChipLabelInput").value = "";
  document.getElementById("newChipPriceInput").value = "";
  renderCatChipsModalPreview();
  document.getElementById("categoryModal").classList.remove("hidden");
}

function renderQuickAmountsModalList() {
  const box = document.getElementById("quickAmountsEditList");
  if (!box) return;
  box.innerHTML = "";
  if (tempQuickAmounts.length === 0) {
    box.innerHTML = `<span style="color: var(--text-muted); font-size: 11.5px;">Nenhum botão configurado.</span>`;
    return;
  }
  tempQuickAmounts.forEach((val, idx) => {
    const num = Number(val);
    const sign = num > 0 ? "+" : "-";
    const pill = document.createElement("div");
    pill.className = "editable-chip-pill";
    pill.innerHTML = `<span>${sign}${formatQuickNum(num)} €</span><span class="remove-chip-x" title="Remover">×</span>`;
    pill.addEventListener("click", () => {
      tempQuickAmounts.splice(idx, 1);
      renderQuickAmountsModalList();
    });
    box.appendChild(pill);
  });
}

function openQuickAmountsModal() {
  tempQuickAmounts = [...(Array.isArray(state.quickAmounts) && state.quickAmounts.length > 0 ? state.quickAmounts : DEFAULT_QUICK_AMOUNTS)];
  document.getElementById("newQuickAmountInput").value = "";
  renderQuickAmountsModalList();
  document.getElementById("quickAmountsModal").classList.remove("hidden");
}

function openRecurringModal(rec = null) {
  populateSelectDropdowns();
  document.getElementById("recurringModalTitle").textContent = rec ? "Editar Recorrente" : "Nova Dedução Recorrente";
  document.getElementById("recIdInput").value = rec ? rec.id : "";
  document.getElementById("recDescInput").value = rec ? stripEmojis(rec.description) : "";
  document.getElementById("recAmountInput").value = rec ? rec.amount : "";
  document.getElementById("recDayInput").value = rec ? rec.day_of_month : 1;
  document.getElementById("recTypeInput").value = rec ? rec.type : "Despesa";
  document.getElementById("recAccountInput").value =
    rec ? rec.account : state.selectedAccount === "SPLIT_MAE_PAI" ? "Dinheiro Geral" : state.selectedAccount;
  document.getElementById("recCategoryInput").value = rec ? rec.category : "Subscrições";
  document.getElementById("recurringModal").classList.remove("hidden");
}

// =========================================================================
// EVENTOS
// =========================================================================
function bindEvents() {
  document.getElementById("themeToggleBtn").addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(STORAGE_KEYS.THEME, next);
  });

  document.getElementById("globalMonthPicker").addEventListener("change", (e) => {
    if (e.target.value) {
      state.selectedMonth = e.target.value;
      updateUI();
    }
  });

  document.querySelectorAll(".type-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".type-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.currentType = btn.dataset.type;
      renderFormAccountPills();
      renderCategories();
      renderNoteSuggestions();
    });
  });

  const amountInp = document.getElementById("amountInput");
  if (amountInp) {
    amountInp.addEventListener("input", () => updateAmountCalcPreview());
    amountInp.addEventListener("keydown", (e) => {
      if (e.key === "=") {
        e.preventDefault();
        resolveAmountExpression();
      }
    });
  }

  const calcAddBtn = document.getElementById("calcAddOpBtn");
  if (calcAddBtn) calcAddBtn.addEventListener("click", () => appendOperatorToAmount("+"));

  const calcSubBtn = document.getElementById("calcSubOpBtn");
  if (calcSubBtn) calcSubBtn.addEventListener("click", () => appendOperatorToAmount("-"));

  const calcEqBtn = document.getElementById("calcEqualsBtn");
  if (calcEqBtn) calcEqBtn.addEventListener("click", () => resolveAmountExpression());

  const calcClearBtn = document.getElementById("calcClearBtn");
  if (calcClearBtn) {
    calcClearBtn.addEventListener("click", () => {
      const inp = document.getElementById("amountInput");
      if (inp) {
        inp.value = "";
        updateAmountCalcPreview();
        inp.focus();
      }
    });
  }

  const openDashBtn = document.getElementById("openDashboardQuickBtn");
  if (openDashBtn) {
    openDashBtn.addEventListener("click", () => switchTab("tab-metricas"));
  }

  const quickEditSugBtn = document.getElementById("quickEditSuggestionsBtn");
  if (quickEditSugBtn) {
    quickEditSugBtn.addEventListener("click", () => {
      const activeCat = state.categories.find((c) => c.name === state.selectedCategory);
      openCategoryModal(activeCat || null);
      setTimeout(() => document.getElementById("newChipLabelInput").focus(), 60);
    });
  }

  const addChipBtn = document.getElementById("addChipItemBtn");
  if (addChipBtn) {
    const triggerAddChip = () => {
      const labelInp = document.getElementById("newChipLabelInput");
      const priceInp = document.getElementById("newChipPriceInput");
      const chipsInp = document.getElementById("catChipsInput");
      const label = labelInp.value.trim();
      if (!label) {
        showToast("Escreve o nome da sugestão (ex: Almoço)");
        return;
      }
      const formatted = formatChipItem(label, priceInp.value);
      const current = chipsInp.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      current.push(formatted);
      chipsInp.value = current.join(", ");
      labelInp.value = "";
      priceInp.value = "";
      renderCatChipsModalPreview();
      labelInp.focus();
    };
    addChipBtn.addEventListener("click", triggerAddChip);
    document.getElementById("newChipLabelInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        triggerAddChip();
      }
    });
    document.getElementById("newChipPriceInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        triggerAddChip();
      }
    });
    document.getElementById("catChipsInput").addEventListener("input", () => renderCatChipsModalPreview());
  }

  const closeQaBtn = document.getElementById("closeQuickAmountsModal");
  if (closeQaBtn) {
    closeQaBtn.addEventListener("click", () => document.getElementById("quickAmountsModal").classList.add("hidden"));
  }

  const addQaBtn = document.getElementById("addQuickAmountBtn");
  if (addQaBtn) {
    const triggerAddQa = () => {
      const inp = document.getElementById("newQuickAmountInput");
      const raw = inp.value.trim().replace(",", ".");
      const num = Math.round(parseFloat(raw) * 100) / 100;
      if (Number.isNaN(num) || num === 0) {
        showToast("Introduz um valor numérico (ex: 2,85 ou -1,50)");
        return;
      }
      tempQuickAmounts.push(num);
      inp.value = "";
      renderQuickAmountsModalList();
      inp.focus();
    };
    addQaBtn.addEventListener("click", triggerAddQa);
    document.getElementById("newQuickAmountInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        triggerAddQa();
      }
    });
  }

  const resetQaBtn = document.getElementById("resetQuickAmountsBtn");
  if (resetQaBtn) {
    resetQaBtn.addEventListener("click", () => {
      tempQuickAmounts = [...DEFAULT_QUICK_AMOUNTS];
      renderQuickAmountsModalList();
    });
  }

  const qaForm = document.getElementById("quickAmountsForm");
  if (qaForm) {
    qaForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const pendingVal = document.getElementById("newQuickAmountInput").value.trim().replace(",", ".");
      if (pendingVal) {
        const num = Math.round(parseFloat(pendingVal) * 100) / 100;
        if (!Number.isNaN(num) && num !== 0) tempQuickAmounts.push(num);
      }
      state.quickAmounts = tempQuickAmounts.length > 0 ? [...tempQuickAmounts] : [...DEFAULT_QUICK_AMOUNTS];
      const clock = Math.max(Date.now(), (Number(gitMeta.maxStamp) || 0) + 1);
      gitMeta.quickAmountsStamp = clock;
      gitMeta.maxStamp = clock;
      saveLocalState();
      renderQuickAmounts();
      document.getElementById("quickAmountsModal").classList.add("hidden");
      showToast("Botões de valores rápidos atualizados");
    });
  }

  document.querySelectorAll("#paymentPills .pay-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#paymentPills .pay-pill").forEach((p) => p.classList.remove("selected"));
      pill.classList.add("selected");
      state.selectedPayment = pill.dataset.pay;
    });
  });

  document.getElementById("quickExpenseForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const parsedAmount = parseAmountExpression(document.getElementById("amountInput").value);
    const amountVal = parsedAmount.total;
    if (!parsedAmount.valid || !amountVal || amountVal <= 0) {
      showToast("Introduza um valor superior a 0,00 €");
      return;
    }

    const isTransfer = state.currentType === "Transferência";
    if (isTransfer && state.selectedAccount === state.selectedToAccount) {
      showToast("Selecione uma conta de destino diferente");
      return;
    }

    const dateStr = document.getElementById("dateInput").value || new Date().toISOString().slice(0, 10);
    const nowTime = new Date().toTimeString().slice(0, 5);
    const defaultDesc = isTransfer
      ? `Transferência: ${state.selectedAccount} -> ${state.selectedToAccount}`
      : state.selectedCategory;
    const desc = document.getElementById("descriptionInput").value.trim() || defaultDesc;

    if (!isTransfer && state.selectedAccount === "SPLIT_MAE_PAI") {
      const halfAmount = Math.round((amountVal / 2) * 100) / 100;
      const otherHalf = Math.round((amountVal - halfAmount) * 100) / 100;
      const baseTs = Date.now();

      const txMae = {
        id: `TX-${baseTs}-MAE`,
        date: dateStr,
        time: nowTime,
        type: state.currentType,
        account: "Comida Mãe",
        to_account: "",
        category: state.selectedCategory,
        description: `${desc} (50% Mãe)`,
        amount: halfAmount,
        payment_method: state.selectedPayment,
        month_year: dateStr.slice(0, 7)
      };

      const txPai = {
        id: `TX-${baseTs}-PAI`,
        date: dateStr,
        time: nowTime,
        type: state.currentType,
        account: "Comida Pai",
        to_account: "",
        category: state.selectedCategory,
        description: `${desc} (50% Pai)`,
        amount: otherHalf,
        payment_method: state.selectedPayment,
        month_year: dateStr.slice(0, 7)
      };

      state.transactions.unshift(txPai, txMae);
      state.pendingIds.add(txMae.id);
      state.pendingIds.add(txPai.id);
      saveLocalState();
      updateUI();

      document.getElementById("amountInput").value = "";
      updateAmountCalcPreview();
      document.getElementById("descriptionInput").value = "";
      showToast(`Dividido: ${formatEuro(halfAmount)} Mãe + ${formatEuro(otherHalf)} Pai`);

      await pushTransactionEverywhere(txMae);
      await pushTransactionEverywhere(txPai);
      return;
    }

    const newTx = {
      id: `TX-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      date: dateStr,
      time: nowTime,
      type: state.currentType,
      account: state.selectedAccount,
      to_account: isTransfer ? state.selectedToAccount : "",
      category: isTransfer ? "Transferência" : state.selectedCategory,
      description: desc,
      amount: Math.round(amountVal * 100) / 100,
      payment_method: isTransfer ? "Transferência" : state.selectedPayment,
      month_year: dateStr.slice(0, 7)
    };

    state.transactions.unshift(newTx);
    state.pendingIds.add(newTx.id);
    saveLocalState();
    updateUI();

    document.getElementById("amountInput").value = "";
    updateAmountCalcPreview();
    document.getElementById("descriptionInput").value = "";
    showToast(
      isTransfer
        ? `Transferido ${formatEuro(newTx.amount)} para ${newTx.to_account}`
        : `${formatEuro(newTx.amount)} registado em ${newTx.account}`
    );

    await pushTransactionEverywhere(newTx);
  });

  document.getElementById("openNewAccountQuickBtn").addEventListener("click", () => {
    switchTab("tab-contas");
  });
  document.getElementById("openCategoryModalBtn").addEventListener("click", () => {
    const activeCat = state.categories.find((c) => c.name === state.selectedCategory);
    openCategoryModal(activeCat || null);
  });

  document.getElementById("addNewAccountBtn").addEventListener("click", () => openAccountModal(null));
  document.getElementById("addNewCategoryBtn").addEventListener("click", () => openCategoryModal(null));
  document.getElementById("addNewRecurringBtn").addEventListener("click", () => openRecurringModal(null));

  document.getElementById("quickJumpTransferBtn").addEventListener("click", () => {
    switchTab("tab-registar");
    document.querySelector('.type-btn[data-type="Transferência"]').click();
  });

  document.getElementById("processRecurringNowBtn").addEventListener("click", async () => {
    const count = processLocalRecurringIfNeeded(true);
    try {
      const res = await fetch("/api/recurring/process?force=true", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data.transactions) state.transactions = data.transactions;
      }
    } catch (_) {}
    saveLocalState();
    renderAll();
    if (count === 0) {
      showToast("Todas as deduções recorrentes deste mês já foram lançadas");
    }
  });

  document.getElementById("closeEditTxModal").addEventListener("click", () =>
    document.getElementById("editTxModal").classList.add("hidden")
  );
  document.getElementById("closeAccountModal").addEventListener("click", () =>
    document.getElementById("accountModal").classList.add("hidden")
  );
  document.getElementById("closeCategoryModal").addEventListener("click", () =>
    document.getElementById("categoryModal").classList.add("hidden")
  );
  document.getElementById("closeRecurringModal").addEventListener("click", () =>
    document.getElementById("recurringModal").classList.add("hidden")
  );

  document.getElementById("editTxForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const txId = document.getElementById("editTxId").value;
    const idx = state.transactions.findIndex((t) => t.id === txId);
    if (idx === -1) return;

    const parsedEditAmt = parseAmountExpression(document.getElementById("editTxAmount").value);
    if (!parsedEditAmt.valid || parsedEditAmt.total <= 0) {
      showToast("Introduza um valor válido superior a 0,00 €");
      return;
    }

    const updatedTx = {
      ...state.transactions[idx],
      type: document.getElementById("editTxType").value,
      amount: parsedEditAmt.total,
      account: document.getElementById("editTxAccount").value,
      category: document.getElementById("editTxCategory").value,
      description: document.getElementById("editTxDesc").value.trim(),
      date: document.getElementById("editTxDate").value,
      payment_method: document.getElementById("editTxMethod").value,
      month_year: document.getElementById("editTxDate").value.slice(0, 7)
    };

    state.transactions[idx] = updatedTx;
    saveLocalState();
    document.getElementById("editTxModal").classList.add("hidden");
    renderAll();
    showToast("Registo atualizado");

    try {
      await fetch(`/api/transactions/${encodeURIComponent(txId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedTx)
      });
    } catch (_) {}
  });

  document.getElementById("accountForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("accIdInput").value || `acc_${Date.now()}`;
    const name = document.getElementById("accNameInput").value.trim();
    const accObj = {
      id,
      name,
      icon: getMonogram(name, document.getElementById("accIconInput").value.trim()),
      initial_balance: parseFloat(document.getElementById("accBalanceInput").value) || 0,
      color: "#71717A",
      description: document.getElementById("accDescInput").value.trim()
    };

    const existingIdx = state.accounts.findIndex((a) => a.id === id);
    if (existingIdx >= 0) state.accounts[existingIdx] = accObj;
    else state.accounts.push(accObj);

    saveLocalState();
    document.getElementById("accountModal").classList.add("hidden");
    renderAll();
    showToast(`Conta "${accObj.name}" guardada`);

    try {
      await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(accObj)
      });
    } catch (_) {}
  });

  document.getElementById("categoryForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("catIdInput").value || `cat_${Date.now()}`;
    const name = document.getElementById("catNameInput").value.trim();
    const rawChips = document.getElementById("catChipsInput").value;
    const chipsArr = rawChips
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const catObj = {
      id,
      name,
      icon: getMonogram(name, document.getElementById("catIconInput").value.trim()),
      type: document.getElementById("catTypeInput").value,
      budget: parseFloat(document.getElementById("catBudgetInput").value) || 0,
      color: "#71717A",
      chips: chipsArr.length > 0 ? chipsArr : ["Registo Rápido"]
    };

    const existingIdx = state.categories.findIndex((c) => c.id === id);
    if (existingIdx >= 0) {
      const oldName = state.categories[existingIdx].name;
      state.categories[existingIdx] = catObj;
      if (oldName !== catObj.name) {
        state.transactions.forEach((t) => {
          if (t.category === oldName) t.category = catObj.name;
        });
      }
    } else {
      state.categories.push(catObj);
    }

    state.selectedCategory = catObj.name;
    saveLocalState();
    document.getElementById("categoryModal").classList.add("hidden");
    renderAll();
    showToast(`Categoria "${catObj.name}" guardada`);

    try {
      await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(catObj)
      });
    } catch (_) {}
  });

  document.getElementById("recurringForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("recIdInput").value || `REC-${Date.now().toString(36).toUpperCase()}`;
    const recObj = {
      id,
      description: document.getElementById("recDescInput").value.trim(),
      amount: Math.round(parseFloat(document.getElementById("recAmountInput").value) * 100) / 100,
      day_of_month: Math.max(1, Math.min(31, parseInt(document.getElementById("recDayInput").value, 10) || 1)),
      type: document.getElementById("recTypeInput").value,
      account: document.getElementById("recAccountInput").value,
      category: document.getElementById("recCategoryInput").value,
      frequency: "Mensal",
      payment_method: "Débito Direto",
      last_processed_month: "",
      active: true
    };

    const existingIdx = state.recurring.findIndex((r) => r.id === id);
    if (existingIdx >= 0) state.recurring[existingIdx] = recObj;
    else state.recurring.push(recObj);

    saveLocalState();
    document.getElementById("recurringModal").classList.add("hidden");
    renderRecurringManageTab();
    showToast(`Recorrente "${recObj.description}" guardada`);

    try {
      await fetch("/api/recurring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(recObj)
      });
    } catch (_) {}
  });

  document.getElementById("searchTxInput").addEventListener("input", renderFullHistory);
  const quickDashInp = document.getElementById("quickDashboardSearch");
  if (quickDashInp) {
    quickDashInp.addEventListener("input", () => updateUI());
  }

  const sideAddCat = document.getElementById("sideAddCatBtn");
  if (sideAddCat) sideAddCat.addEventListener("click", () => openCategoryModal(null));

  const sideAddRec = document.getElementById("sideAddRecBtn");
  if (sideAddRec) sideAddRec.addEventListener("click", () => openRecurringModal(null));

  const sideExcelBtn = document.getElementById("sidebarDownloadExcelBtn");
  if (sideExcelBtn) {
    sideExcelBtn.addEventListener("click", () => downloadExcel());
  }

  document.getElementById("historyAccountFilter").addEventListener("change", (e) => {
    state.activeAccountFilter = e.target.value;
    renderAccountsStrip();
    updateUI();
  });

  document.querySelectorAll(".bottom-nav .nav-item, .sidebar-nav .side-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.getElementById("cloudProviderSelect").addEventListener("change", toggleCloudProviderInputs);

  document.getElementById("saveCloudConfigBtn").addEventListener("click", async () => {
    state.cloudConfig = {
      ...state.cloudConfig,
      provider: document.getElementById("cloudProviderSelect").value,
      webhook_url: document.getElementById("webhookUrlInput").value.trim(),
      supabase_url: document.getElementById("supabaseUrlInput").value.trim(),
      supabase_key: document.getElementById("supabaseKeyInput").value.trim(),
      github_owner: document.getElementById("githubOwnerInput").value.trim(),
      github_repo: document.getElementById("githubRepoInput").value.trim() || "financas-data",
      github_token: document.getElementById("githubTokenInput").value.trim()
    };
    // Se mudou de repositório, recomeça o controlo de alterações para essa cloud.
    gitMeta = FinCloud.normalizeMeta(gitMeta, currentRepoKey());
    repoPrivacyChecked = "";
    saveLocalState();
    if (canUseLocalServer()) {
      try {
        await fetch("/api/cloud-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(state.cloudConfig)
        });
      } catch (_) {}
    }
    showToast("Configuração Cloud guardada");
    await syncWithBackendAndCloud();
    if (isGitHubConfigured()) {
      showToast(state.cloudStatus.ok ? "Cloud GitHub ligada" : "Cloud: " + (state.cloudStatus.error || "sem ligação"));
    }
  });

  document.getElementById("testGithubBtn").addEventListener("click", async () => {
    const statusEl = document.getElementById("githubStatusText");
    const store = new FinCloud.GitHubStore({
      github_owner: document.getElementById("githubOwnerInput").value,
      github_repo: document.getElementById("githubRepoInput").value || "financas-data",
      github_branch: state.cloudConfig.github_branch,
      github_path: state.cloudConfig.github_path,
      github_token: document.getElementById("githubTokenInput").value
    });
    if (!store.isConfigured()) {
      statusEl.textContent = "Preenche o utilizador, o repositório e o token.";
      return;
    }
    statusEl.textContent = "A testar...";
    try {
      const info = await store.testConnection();
      if (!info.isPrivate) {
        statusEl.textContent = `ATENÇÃO: ${info.fullName} é PÚBLICO. Torna-o privado antes de usar (Settings > Danger Zone).`;
      } else if (!info.canWrite) {
        statusEl.textContent = "O token não tem permissão de escrita (Contents: Read and write).";
      } else {
        statusEl.textContent = `Ligação OK: ${info.fullName} (privado, com escrita).`;
      }
    } catch (e) {
      statusEl.textContent = e.message;
    }
  });

  document.getElementById("syncNowBtn").addEventListener("click", async () => {
    showToast("A sincronizar...");
    await syncWithBackendAndCloud();
    showToast("Sincronização concluída");
  });

  document.getElementById("downloadExcelBtn").addEventListener("click", () => downloadExcel());
}

function switchTab(targetId) {
  document.querySelectorAll(".bottom-nav .nav-item, .sidebar-nav .side-nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === targetId);
  });
  document.querySelectorAll(".tab-view").forEach((v) => v.classList.add("hidden"));
  document.getElementById(targetId).classList.remove("hidden");

  renderAll();
}

// =========================================================================
// SINCRONIZAÇÃO: GITHUB PRIVADO (CLOUD 24/7) + SERVIDOR LOCAL (EXCEL)
// =========================================================================
function isGitHubConfigured() {
  const c = state.cloudConfig;
  return c.provider === "github" && !!(c.github_owner && c.github_repo && c.github_token);
}

function getGitStore() {
  return new FinCloud.GitHubStore(state.cloudConfig);
}

function currentRepoKey() {
  return getGitStore().repoKey();
}

/** O servidor Python só existe no PC (localhost / IP local); nunca no GitHub Pages. */
function canUseLocalServer() {
  if (!/^https?:$/.test(location.protocol)) return false;
  return !/\.github\.io$/i.test(location.hostname);
}

function deviceLabel() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "PC";
  return "Web";
}

function persistPending() {
  localStorage.setItem(STORAGE_KEYS.PENDING, JSON.stringify(Array.from(state.pendingIds)));
}

function scheduleGitSync() {
  if (!isGitHubConfigured()) return;
  clearTimeout(gitSyncTimer);
  gitSyncTimer = setTimeout(() => syncWithBackendAndCloud(), 1500);
}

/** Lê, faz merge e escreve o ficheiro na cloud (GitHub). Lança erro se falhar. */
async function runGitSync() {
  const store = getGitStore();
  if (!store.isConfigured()) return false;

  if (repoPrivacyChecked !== store.repoKey()) {
    const info = await store.testConnection();
    if (!info.isPrivate) {
      throw new Error("O repositório de dados é PÚBLICO. Torna-o privado antes de sincronizar.");
    }
    if (!info.canWrite) {
      throw new Error("O token não tem permissão de escrita no repositório.");
    }
    repoPrivacyChecked = store.repoKey();
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const { snapshot: remote, sha } = await store.read();
    const versionAtStart = localVersion;
    // Relógio híbrido: nunca carimbar abaixo do que outros dispositivos já carimbaram.
    gitMeta.maxStamp = Math.max(gitMeta.maxStamp || 0, FinCloud.maxStamp(remote));

    calculateAccountBalances(); // normaliza ícones para que o carimbo seja estável
    FinCloud.stampLocalChanges(state, gitMeta, Date.now());
    const local = FinCloud.buildSnapshot(state, gitMeta, deviceLabel());
    const merged = FinCloud.mergeSnapshots(local, remote, Date.now());

    if (!remote || !FinCloud.sameContent(merged, remote)) {
      const toWrite = Object.assign({}, merged, {
        app: "financas-pessoais",
        version: 1,
        updated_at: new Date().toISOString(),
        updated_by: deviceLabel(),
        transactions: FinCloud.sortTransactions(merged.transactions)
      });
      try {
        await store.write(toWrite, sha, `Atualização de ${deviceLabel()}`);
      } catch (e) {
        if (e.conflict) continue; // outro dispositivo escreveu entretanto: volta a ler e a fazer merge
        throw e;
      }
    }

    if (localVersion !== versionAtStart) {
      // O utilizador alterou dados durante o pedido: não sobrepor; volta a correr já a seguir.
      syncQueued = true;
      return true;
    }
    applyMergedToState(merged);
    return true;
  }
  throw new Error("Conflito repetido na cloud. Tenta novamente.");
}

function applyMergedToState(merged) {
  suppressCloudSchedule = true;
  let createdRecurring = 0;
  try {
    state.transactions = FinCloud.sortTransactions(merged.transactions);
    if (merged.accounts.length > 0) state.accounts = merged.accounts;
    if (merged.categories.length > 0) state.categories = merged.categories;
    if (Array.isArray(merged.quick_amounts) && merged.quick_amounts.length > 0) {
      state.quickAmounts = merged.quick_amounts;
      gitMeta.quickAmountsStamp = Number(merged.quick_amounts_updated_at) || gitMeta.quickAmountsStamp || 0;
    }
    state.recurring = merged.recurring;
    gitMeta.tombstones = merged.tombstones;
    gitMeta.maxStamp = Math.max(gitMeta.maxStamp || 0, FinCloud.maxStamp(merged));
    FinCloud.markAllSeen(state, gitMeta);
    createdRecurring = processLocalRecurringIfNeeded();
    saveLocalState();
  } finally {
    suppressCloudSchedule = false;
  }
  if (createdRecurring > 0) syncQueued = true;
}

async function syncWithBackendAndCloud() {
  if (syncInFlight) {
    syncQueued = true;
    return;
  }
  syncInFlight = true;
  try {
    for (let round = 0; round < 3; round++) {
      syncQueued = false;
      await syncOnce();
      if (!syncQueued) break;
    }
  } finally {
    syncInFlight = false;
  }
  updateSyncIndicator(state.serverOnline, isGitHubConfigured());
  renderAll();
}

async function syncOnce() {
  const gitMode = isGitHubConfigured();
  let cloudOk = false;

  if (gitMode) {
    lastCloudAttempt = Date.now();
    try {
      await runGitSync();
      cloudOk = true;
      state.cloudStatus = { ok: true, error: "", offline: false, at: Date.now() };
    } catch (e) {
      state.cloudStatus = { ok: false, error: e.message || "Erro na cloud", offline: !!e.offline, at: Date.now() };
    }
  }

  const serverOk = await syncWithLocalServer(gitMode);

  if (gitMode ? cloudOk : serverOk) {
    state.pendingIds.clear();
    persistPending();
  }
}

/** Sincroniza com o servidor Python do PC (que guarda tudo no Excel). */
async function syncWithLocalServer(gitMode) {
  if (!canUseLocalServer()) {
    state.serverOnline = false;
    return false;
  }
  try {
    const healthRes = await fetch("/api/health", { cache: "no-store" });
    if (!healthRes.ok) {
      state.serverOnline = false;
      return false;
    }
    state.serverOnline = true;

    const syncRes = await fetch("/api/sync/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: state.transactions })
    });
    if (!syncRes.ok) return true;

    const data = await syncRes.json();
    if (gitMode) {
      // A cloud é a fonte de verdade: o Excel passa a espelhar o estado fundido.
      await reconcileWithServer(data);
    } else {
      if (data.transactions) state.transactions = data.transactions;
      if (data.accounts && data.accounts.length > 0) state.accounts = data.accounts;
      if (data.categories && data.categories.length > 0) state.categories = data.categories;
      if (data.recurring) state.recurring = data.recurring;
      saveLocalState();
    }
    return true;
  } catch (_) {
    state.serverOnline = false;
    return false;
  }
}

function sameTxContent(a, b) {
  const text = (v) => String(v === undefined || v === null ? "" : v);
  return (
    ["date", "type", "account", "to_account", "category", "payment_method"].every((k) => text(a[k]) === text(b[k])) &&
    text(a.description).trim() === text(b.description).trim() &&
    text(a.time).slice(0, 5) === text(b.time).slice(0, 5) &&
    Math.round(Number(a.amount || 0) * 100) === Math.round(Number(b.amount || 0) * 100)
  );
}

async function reconcileWithServer(data) {
  const tombs = gitMeta.tombstones.transactions || {};
  const mine = new Map(state.transactions.map((t) => [String(t.id), t]));
  let adopted = 0;

  for (const st of data.transactions || []) {
    const id = String(st.id);
    const m = mine.get(id);
    if (!m) {
      if (tombs[id] !== undefined) {
        // Apagado noutro dispositivo: remove também do Excel.
        try {
          await fetch(`/api/transactions/${encodeURIComponent(id)}`, { method: "DELETE" });
        } catch (_) {}
      } else {
        state.transactions.push(st); // existe só no Excel: adota e envia para a cloud
        adopted++;
      }
    } else if (!sameTxContent(m, st)) {
      const sig = FinCloud.entitySig(m);
      if (mirroredTxSigs.get(id) !== sig) {
        try {
          await fetch(`/api/transactions/${encodeURIComponent(id)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(FinCloud.cleanEntity(m))
          });
          mirroredTxSigs.set(id, sig);
        } catch (_) {}
      }
    }
  }

  if (adopted > 0) {
    state.transactions = FinCloud.sortTransactions(state.transactions);
    saveLocalState();
  }
  await mirrorCatalogsToServer();
}

/** Espelha contas, categorias e recorrentes no Excel (só quando mudam). */
async function mirrorCatalogsToServer() {
  const cols = [
    ["accounts", "/api/accounts"],
    ["categories", "/api/categories"],
    ["recurring", "/api/recurring"]
  ];
  const key = FinCloud.stableStringify(cols.map(([c]) => state[c].map(FinCloud.entitySig)));
  if (key === lastMirrorKey) return;

  try {
    for (const [col, path] of cols) {
      const tombs = gitMeta.tombstones[col] || {};
      const listRes = await fetch(path, { cache: "no-store" });
      if (listRes.ok) {
        const serverItems = await listRes.json();
        for (const s of serverItems) {
          const id = String(s.id);
          if (tombs[id] !== undefined && !state[col].some((e) => String(e.id) === id)) {
            await fetch(`${path}/${encodeURIComponent(id)}`, { method: "DELETE" });
          }
        }
      }
      for (const entity of state[col]) {
        await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(FinCloud.cleanEntity(entity))
        });
      }
    }
    lastMirrorKey = key;
  } catch (_) {}
}

async function pushTransactionEverywhere(tx) {
  let syncedToPC = false;
  let syncedToCloud = false;
  const gitMode = isGitHubConfigured();

  if (canUseLocalServer()) {
    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tx)
      });
      if (res.ok) {
        syncedToPC = true;
        state.serverOnline = true;
        if (!gitMode) state.pendingIds.delete(tx.id);
      }
    } catch (_) {
      state.serverOnline = false;
    }
  }

  if (gitMode) {
    clearTimeout(gitSyncTimer);
    await syncWithBackendAndCloud();
    syncedToCloud = state.cloudStatus.ok;
  } else if (!syncedToPC && state.cloudConfig.provider !== "none") {
    try {
      if (state.cloudConfig.provider === "webhook" && state.cloudConfig.webhook_url) {
        await fetch(state.cloudConfig.webhook_url, {
          method: "POST",
          mode: "no-cors",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "add", transaction: tx })
        });
        syncedToCloud = true;
        state.pendingIds.delete(tx.id);
      } else if (
        state.cloudConfig.provider === "supabase" &&
        state.cloudConfig.supabase_url &&
        state.cloudConfig.supabase_key
      ) {
        const url = `${state.cloudConfig.supabase_url.replace(/\/$/, "")}/rest/v1/transactions`;
        const sRes = await fetch(url, {
          method: "POST",
          headers: {
            apikey: state.cloudConfig.supabase_key,
            Authorization: `Bearer ${state.cloudConfig.supabase_key}`,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates"
          },
          body: JSON.stringify(tx)
        });
        if (sRes.ok) {
          syncedToCloud = true;
          state.pendingIds.delete(tx.id);
        }
      }
    } catch (_) {}
  }

  persistPending();
  updateSyncIndicator(syncedToPC, syncedToCloud);
}

function updateSyncIndicator(pcOnline, cloudConfigured) {
  const dot = document.getElementById("syncDot");
  const txt = document.getElementById("syncStatusText");
  const sideTxt = document.getElementById("sidebarSyncText");
  const pendingBadge = document.getElementById("pendingSyncBadge");

  if (state.pendingIds.size > 0) {
    pendingBadge.classList.remove("hidden");
    pendingBadge.textContent = `${state.pendingIds.size} pendente(s)`;
  } else {
    pendingBadge.classList.add("hidden");
  }

  let label;
  let offline = false;
  if (isGitHubConfigured()) {
    const cs = state.cloudStatus;
    if (!navigator.onLine || cs.offline) {
      label = "Offline · guardado neste dispositivo";
      offline = true;
    } else if (cs.ok) {
      label = pcOnline ? "Cloud + Excel Sincronizados" : "Cloud Sincronizada";
    } else if (cs.error) {
      label = "Erro na Cloud: toca em Cloud";
      offline = true;
    } else {
      label = "A ligar à Cloud...";
    }
  } else if (pcOnline) {
    label = "Excel Sincronizado";
  } else if (cloudConfigured) {
    label = "Cloud 24/7 Ativa";
  } else {
    label = "Modo Offline";
    offline = true;
  }

  dot.className = offline ? "status-dot offline" : "status-dot";
  txt.textContent = label;
  if (sideTxt) sideTxt.textContent = label;
}

function downloadExcel() {
  if (state.serverOnline) {
    window.location.href = "/api/download-excel";
    return;
  }
  if (typeof exportWorkbookXlsx === "function") {
    try {
      exportWorkbookXlsx(state);
      return;
    } catch (e) {
      console.error("Falha ao gerar .xlsx no browser:", e);
    }
  }
  exportFallbackCSV();
}

function exportFallbackCSV() {
  const headers = ["ID", "Data", "Hora", "Tipo", "Conta", "Conta Destino", "Categoria", "Descrição", "Valor (€)", "Método de Pagamento", "Mês_Ano"];
  const rows = state.transactions.map((t) => [
    t.id,
    t.date,
    t.time,
    t.type,
    t.account || "Dinheiro Geral",
    t.to_account || "",
    t.category,
    `"${stripEmojis(t.description || "").replace(/"/g, '""')}"`,
    String(t.amount).replace(".", ","),
    t.payment_method,
    t.month_year
  ]);
  const csvContent = "\uFEFF" + [headers.join(";"), ...rows.map((r) => r.join(";"))].join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Gestao_Financeira_Export_${state.selectedMonth}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}


