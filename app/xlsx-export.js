/*
 * xlsx-export.js
 * Gera o ficheiro Gestao_Financeira.xlsx diretamente no browser (PC ou iPhone),
 * sem precisar do servidor Python. Usa a biblioteca SheetJS (xlsx.mini.min.js).
 */
function exportWorkbookXlsx(appState) {
  if (typeof XLSX === "undefined") throw new Error("Biblioteca XLSX não carregada");

  const txs = (appState.transactions || [])
    .slice()
    .sort((a, b) => `${b.date} ${b.time || ""}`.localeCompare(`${a.date} ${a.time || ""}`));

  const num = (v) => Math.round((Number(v) || 0) * 100) / 100;
  const text = (v) => String(v === undefined || v === null ? "" : v).replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "").trim();

  // Saldos atuais por conta (mesma lógica da app).
  const accounts = (appState.accounts || []).map((acc) => {
    let income = 0;
    let expense = 0;
    let transfersIn = 0;
    let transfersOut = 0;
    txs.forEach((t) => {
      const amt = Number(t.amount) || 0;
      const from = t.account || "Dinheiro Geral";
      if (t.type === "Receita" && from === acc.name) income += amt;
      else if (t.type === "Despesa" && from === acc.name) expense += amt;
      else if (t.type === "Transferência") {
        if (from === acc.name) transfersOut += amt;
        if (t.to_account === acc.name) transfersIn += amt;
      }
    });
    const initial = Number(acc.initial_balance) || 0;
    return {
      name: acc.name,
      initial,
      income,
      expense,
      transfersIn,
      transfersOut,
      balance: initial + income - expense + transfersIn - transfersOut
    };
  });

  const wb = XLSX.utils.book_new();

  // 1) Resumo_Contas
  const summaryRows = [["Conta", "Saldo Inicial (€)", "Receitas (€)", "Despesas (€)", "Transf. Recebidas (€)", "Transf. Enviadas (€)", "Saldo Atual (€)"]];
  accounts.forEach((a) =>
    summaryRows.push([a.name, num(a.initial), num(a.income), num(a.expense), num(a.transfersIn), num(a.transfersOut), num(a.balance)])
  );
  summaryRows.push([]);
  summaryRows.push(["Património Total", "", "", "", "", "", num(accounts.reduce((s, a) => s + a.balance, 0))]);
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary["!cols"] = [{ wch: 26 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 20 }, { wch: 20 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, "Resumo_Contas");

  // 2) Registo_Gastos
  const txRows = [["ID", "Data", "Hora", "Tipo", "Conta", "Conta Destino", "Categoria", "Descrição", "Valor (€)", "Método de Pagamento", "Mês_Ano"]];
  txs.forEach((t) =>
    txRows.push([
      t.id,
      t.date,
      t.time || "",
      t.type,
      t.account || "Dinheiro Geral",
      t.to_account || "",
      t.category,
      text(t.description),
      num(t.amount),
      t.payment_method || "",
      t.month_year || String(t.date || "").slice(0, 7)
    ])
  );
  const wsTx = XLSX.utils.aoa_to_sheet(txRows);
  wsTx["!cols"] = [{ wch: 24 }, { wch: 12 }, { wch: 8 }, { wch: 13 }, { wch: 22 }, { wch: 22 }, { wch: 22 }, { wch: 34 }, { wch: 12 }, { wch: 18 }, { wch: 10 }];
  wsTx["!autofilter"] = { ref: `A1:K${Math.max(txRows.length, 2)}` };
  XLSX.utils.book_append_sheet(wb, wsTx, "Registo_Gastos");

  // 3) Recorrentes
  const recRows = [["Descrição", "Tipo", "Categoria", "Conta", "Valor (€)", "Dia do Mês", "Ativa"]];
  (appState.recurring || []).forEach((r) =>
    recRows.push([text(r.description), r.type, r.category, r.account, num(r.amount), Number(r.day_of_month) || 1, r.active === false ? "Não" : "Sim"])
  );
  const wsRec = XLSX.utils.aoa_to_sheet(recRows);
  wsRec["!cols"] = [{ wch: 28 }, { wch: 10 }, { wch: 22 }, { wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, wsRec, "Recorrentes");

  // 4) Categorias (com total gasto)
  const catRows = [["Categoria", "Tipo", "Total Registado (€)", "Nº de Movimentos"]];
  (appState.categories || []).forEach((c) => {
    const items = txs.filter((t) => t.category === c.name && t.type === c.type);
    catRows.push([c.name, c.type, num(items.reduce((s, t) => s + (Number(t.amount) || 0), 0)), items.length]);
  });
  const wsCat = XLSX.utils.aoa_to_sheet(catRows);
  wsCat["!cols"] = [{ wch: 26 }, { wch: 10 }, { wch: 20 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, wsCat, "Categorias");

  XLSX.writeFile(wb, "Gestao_Financeira.xlsx");
}
