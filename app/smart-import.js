/*
 * smart-import.js
 * Importação automática de Prints (Screenshots) e Extratos PDF da CGD.
 * - Parse nativo de PDFs da Caixa Geral de Depósitos (via pdf.js on-demand)
 * - Leitura de Screenshots via Google Gemini Vision API (opcional, com chave própria)
 * - Categorização automática, deduplicação 1-para-1 e reconciliação de cativos ao cêntimo
 */
(function (root) {
  "use strict";

  const DEFAULT_CHECKPOINT = {
    date: "2026-11-14",
    sig: "2026-11-14|2026-11-12|-5.93|187.04",
    updated_at: 0
  };

  const MERCHANT_RULES = [
    { match: /TFI\s+AUSENDA|AUSENDA\s+CASTANHEI/i, type: "Receita", desc: "Transferência Mãe", account: "Dinheiro Mãe", category: "Reforço Mãe & Pai", method: "Transferência", tag: "transferencia mae ausenda" },
    { match: /TFI\s+AMILCAR|AMILCAR\s+PERALTA/i, type: "Receita", desc: "Transferência Pai", account: "Dinheiro Pai", category: "Reforço Mãe & Pai", method: "Transferência", tag: "transferencia pai" },
    { match: /MY\s*BREAK|MANUEL\s*RUI\s*(?:A\s*)?NABEIRO|DELTA\s*CA/i, type: "Despesa", desc: "Café (Delta)", category: "Alimentação", method: "Multibanco", tag: "cafe delta my break nabeiro" },
    { match: /PD\s*EXPRESS\s*IST/i, type: "Despesa", desc: "Pingo Doce IST", category: "Alimentação", method: "Multibanco", tag: "pingo doce ist pd express" },
    { match: /P\s*D\s*GO\b/i, type: "Despesa", desc: "Pingo Nova SBE", category: "Alimentação", method: "Multibanco", tag: "pingo doce nova sbe pd go" },
    { match: /PINGO\s*DOCE/i, type: "Despesa", desc: "Pingo Doce", category: "Alimentação", method: "Multibanco", tag: "pingo doce" },
    { match: /CONTINENTE/i, type: "Despesa", desc: "Continente Bom Dia", category: "Alimentação", method: "Multibanco", tag: "continente" },
    { match: /\b(LIDL|MERCADONA|MINIPRECO|AUCHAN|ALDI)\b/i, type: "Despesa", category: "Alimentação", method: "Multibanco", tag: "supermercado" },
    { match: /COISAS\s*EM\s*FESTA|BAR\s*REITORIA/i, type: "Despesa", desc: "Almoço", category: "Alimentação", method: "Multibanco", tag: "almoco coisas em festa reitoria" },
    { match: /MCDONALD|BURGER\s*KING|\bKFC\b|TELEPIZZA/i, type: "Despesa", category: "Alimentação", method: "Multibanco", tag: "fast food almoco jantar" },
    { match: /UBR\*?\s*PENDING|UBER\s*\*?\s*TRIP|UBER\s*LIME|\bUBER\b/i, type: "Despesa", desc: "Uber", category: "Transportes", method: "Multibanco", tag: "uber transporte" },
    { match: /\bBOLT\b/i, type: "Despesa", desc: "Bolt", category: "Transportes", method: "Multibanco", tag: "bolt transporte" },
    { match: /INSTITUTO\s*S\.?\s*TECNICO/i, type: "Despesa", desc: "Propinas", account: "Bolsa", category: "Faculdade", method: "MBWay", tag: "propinas tecnico faculdade" },
    { match: /\bFNAC\b/i, type: "Despesa", desc: "Fnac", category: "Compras Pessoais", method: "Multibanco", tag: "fnac" },
    { match: /\bWORTEN\b/i, type: "Despesa", desc: "Worten", category: "Compras Pessoais", method: "Multibanco", tag: "worten" },
    { match: /\bGOOGLE\b/i, type: "Despesa", desc: "Google", account: "Bolsa", category: "Subscrições", method: "Multibanco", tag: "google subscricao" },
    { match: /TRF\s*MBWAY|MBWAY/i, type: "Despesa", category: "Outros", method: "MBWay", tag: "mbway transferencia" }
  ];

  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function centsOf(n) {
    return Math.round((Number(n) || 0) * 100);
  }

  function parsePtAmount(str) {
    if (typeof str === "number") return Number.isFinite(str) ? round2(str) : null;
    const cleaned = String(str || "").replace(/\s+/g, "").replace(/EUR|€/gi, "");
    if (!cleaned) return null;
    const normalized = cleaned.includes(",")
      ? cleaned.replace(/\./g, "").replace(",", ".")
      : cleaned;
    const num = parseFloat(normalized);
    return Number.isNaN(num) ? null : round2(num);
  }

  function ptDateToIso(str) {
    const m = String(str || "").trim().match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
    if (!m) return "";
    return `${m[3]}-${m[2]}-${m[1]}`;
  }

  function isCativoTx(tx) {
    return /\bcativ[oa]s?\b/i.test(String((tx && tx.description) || ""));
  }

  function normalizeText(str) {
    return String(str || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function titleCaseMerchant(raw) {
    const cleaned = String(raw || "")
      .replace(/^(?:COMPRAS?\s*C\.?DEB\.?\s*|PAGAMENTO\s+)/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return "Movimento";
    return cleaned
      .split(" ")
      .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
      .join(" ");
  }

  function resolveAccount(targetName, accounts, fallbackName) {
    const list = Array.isArray(accounts) ? accounts : [];
    const want = String(targetName || fallbackName || "").trim();
    if (!list.length) return want || "Dinheiro Mãe";
    const exact = list.find((a) => a.name === want);
    if (exact) return exact.name;
    const aliasMap = {
      "Comida Mãe": "Dinheiro Mãe",
      "Dinheiro Mãe": "Comida Mãe",
      "Comida Pai": "Dinheiro Pai",
      "Dinheiro Pai": "Comida Pai"
    };
    const alt = aliasMap[want];
    if (alt) {
      const found = list.find((a) => a.name === alt);
      if (found) return found.name;
    }
    const fb = list.find((a) => a.name === fallbackName);
    return fb ? fb.name : list[0].name;
  }

  function resolveCategory(targetName, txType, categories) {
    const list = Array.isArray(categories) ? categories : [];
    const sameType = list.filter((c) => c.type === txType);
    const pool = sameType.length ? sameType : list;
    if (!pool.length) return targetName || (txType === "Receita" ? "Reforço Mãe & Pai" : "Outros");
    const exact = pool.find((c) => c.name === targetName);
    if (exact) return exact.name;
    const normWant = normalizeText(targetName);
    const fuzzy = pool.find((c) => normalizeText(c.name).includes(normWant) || normWant.includes(normalizeText(c.name)));
    if (fuzzy) return fuzzy.name;
    if (txType === "Receita") return pool[0].name;
    const outros = pool.find((c) => c.name === "Outros");
    return outros ? outros.name : pool[pool.length - 1].name;
  }

  function classifyMerchant(rawDesc, signedOrAbsAmount, hintType, defaultAccount, accounts, categories) {
    const raw = String(rawDesc || "").trim();
    const isPositive = typeof signedOrAbsAmount === "number" && signedOrAbsAmount > 0;
    const baseType = hintType || (isPositive ? "Receita" : "Despesa");

    for (const rule of MERCHANT_RULES) {
      if (rule.match.test(raw)) {
        const type = rule.type || baseType;
        const desc = rule.desc || (/TRF\s*MBWAY/i.test(raw) ? raw.replace(/Trf\s*Mbway/i, "Trf MBWay") : titleCaseMerchant(raw));
        return {
          type,
          description: desc,
          account: resolveAccount(rule.account || defaultAccount, accounts, defaultAccount),
          category: resolveCategory(rule.category, type, categories),
          payment_method: rule.method || "Multibanco",
          tag: rule.tag || normalizeText(desc)
        };
      }
    }

    const type = baseType;
    const fallbackCat = type === "Receita" ? "Reforço Mãe & Pai" : "Outros";
    const desc = titleCaseMerchant(raw);
    return {
      type,
      description: desc,
      account: resolveAccount(defaultAccount, accounts, defaultAccount),
      category: resolveCategory(fallbackCat, type, categories),
      payment_method: type === "Receita" ? "Transferência" : "Multibanco",
      tag: normalizeText(desc + " " + raw)
    };
  }

  function makeCgdId(row) {
    const d = String(row.dateVal || row.date || "").replace(/-/g, "");
    const amt = Math.abs(centsOf(row.amount));
    const bal = row.balanceAfter !== null && row.balanceAfter !== undefined ? centsOf(row.balanceAfter) : "NA";
    const occ = row.occurrence || 1;
    return `TX-CGD-${d}-${amt}-B${bal}-${occ}`;
  }

  // ---------------------------------------------------------------------------
  // Parser determinístico do extrato PDF da CGD
  // ---------------------------------------------------------------------------
  function parseCgdPdfLines(lines, rawText) {
    const text = rawText || (Array.isArray(lines) ? lines.join("\n") : "");
    const amtRe = /([+-]?\d{1,3}(?:\.\d{3})*,\d{2}|[+-]?\d+,\d{2})/;

    let accountingBalance = null;
    let availableBalance = null;
    const accMatch = text.match(new RegExp("Saldo\\s+contabil[ií]stico\\s+" + amtRe.source + "\\s*EUR", "i"));
    if (accMatch) accountingBalance = parsePtAmount(accMatch[1]);
    const availMatch = text.match(new RegExp("Saldo\\s+dispon[ií]vel\\s+" + amtRe.source + "\\s*EUR", "i"));
    if (availMatch) availableBalance = parsePtAmount(availMatch[1]);

    let emissionDate = "";
    const emMatch = text.match(/Data\s+de\s+emiss[aã]o:\s*(?:\d{2}:\d{2}\s+)?(\d{2}-\d{2}-\d{4})/i);
    if (emMatch) emissionDate = ptDateToIso(emMatch[1]);

    const rowRe = new RegExp(
      "^(\\d{2}-\\d{2}-\\d{4})\\s+(\\d{2}-\\d{2}-\\d{4})\\s+(.+?)\\s+" +
        amtRe.source +
        "\\s+" +
        amtRe.source +
        "$"
    );

    const sigCounts = new Map();
    const rows = [];
    for (const rawLine of lines || []) {
      const line = String(rawLine || "").replace(/\s+/g, " ").trim();
      const m = line.match(rowRe);
      if (!m) continue;
      const dateMov = ptDateToIso(m[1]);
      const dateVal = ptDateToIso(m[2]);
      const rawDesc = m[3].trim();
      const signedAmount = parsePtAmount(m[4]);
      const balanceAfter = parsePtAmount(m[5]);
      if (!dateMov || !dateVal || signedAmount === null || signedAmount === 0 || balanceAfter === null) continue;

      const baseSig = `${dateMov}|${dateVal}|${signedAmount.toFixed(2)}|${balanceAfter.toFixed(2)}`;
      const occ = (sigCounts.get(baseSig) || 0) + 1;
      sigCounts.set(baseSig, occ);
      const rowSig = occ > 1 ? `${baseSig}#${occ}` : baseSig;

      const row = {
        dateMov,
        dateVal,
        date: dateVal,
        rawDesc,
        signedAmount,
        amount: round2(Math.abs(signedAmount)),
        type: signedAmount > 0 ? "Receita" : "Despesa",
        balanceAfter,
        occurrence: occ,
        rowSig
      };
      row.deterministicId = makeCgdId(row);
      rows.push(row);
    }

    return {
      source: "pdf",
      emissionDate,
      accountingBalance,
      availableBalance,
      rows
    };
  }

  let pdfJsPromise = null;
  function loadPdfJs() {
    if (typeof window === "undefined") return Promise.reject(new Error("Browser required"));
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfJsPromise) return pdfJsPromise;

    pdfJsPromise = new Promise((resolve, reject) => {
      const urls = [
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
        "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js"
      ];
      let idx = 0;
      const tryNext = () => {
        if (idx >= urls.length) {
          pdfJsPromise = null;
          reject(new Error("Não foi possível carregar o leitor de PDF (verifica a ligação à internet)."));
          return;
        }
        const script = document.createElement("script");
        script.src = urls[idx++];
        script.onload = () => {
          if (window.pdfjsLib) {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc =
              "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
            resolve(window.pdfjsLib);
          } else {
            tryNext();
          }
        };
        script.onerror = () => tryNext();
        document.head.appendChild(script);
      };
      tryNext();
    });
    return pdfJsPromise;
  }

  async function extractLinesFromPdfBuffer(arrayBuffer) {
    const pdfjs = await loadPdfJs();
    let pdf;
    try {
      pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
    } catch (_) {
      pdf = await pdfjs.getDocument({ data: arrayBuffer, disableWorker: true }).promise;
    }
    const allLines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const rowBuckets = [];
      for (const item of content.items || []) {
        const str = String(item.str || "").trim();
        if (!str) continue;
        const x = item.transform ? item.transform[4] : 0;
        const y = item.transform ? item.transform[5] : 0;
        let bucket = rowBuckets.find((b) => Math.abs(b.y - y) <= 2.5);
        if (!bucket) {
          bucket = { y, items: [] };
          rowBuckets.push(bucket);
        }
        bucket.items.push({ x, str });
      }
      rowBuckets.sort((a, b) => b.y - a.y);
      for (const b of rowBuckets) {
        b.items.sort((a, c) => a.x - c.x);
        const line = b.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();
        if (line) allLines.push(line);
      }
    }
    return allLines;
  }

  async function parseCgdPdfFile(file) {
    const buf = await file.arrayBuffer();
    const lines = await extractLinesFromPdfBuffer(buf);
    const parsed = parseCgdPdfLines(lines, lines.join("\n"));
    if (parsed.rows.length === 0) {
      throw new Error("Não foram encontrados movimentos CGD neste PDF. Confirma que é o extrato da Caixa.");
    }
    return parsed;
  }

  // ---------------------------------------------------------------------------
  // Parser de Screenshots (Prints) via Gemini Vision API
  // ---------------------------------------------------------------------------
  function imageFileToJpegBase64(file, maxDim = 1600, quality = 0.9) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        if (w > maxDim || h > maxDim) {
          const ratio = Math.min(maxDim / w, maxDim / h);
          w = Math.max(1, Math.round(w * ratio));
          h = Math.max(1, Math.round(h * ratio));
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve(dataUrl.split(",")[1]);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Não foi possível ler a imagem "${file.name}".`));
      };
      img.src = url;
    });
  }

  async function parseScreenshotsWithGemini(files, apiKey, todayIso) {
    const key = String(apiKey || "").trim();
    if (!key) {
      throw new Error("Para ler prints de imagem, adiciona a tua Gemini API Key (grátis) na aba Cloud.");
    }
    const today = todayIso || new Date().toISOString().slice(0, 10);
    const parts = [];
    for (const f of files) {
      const b64 = await imageFileToJpegBase64(f);
      parts.push({ inline_data: { mime_type: "image/jpeg", data: b64 } });
    }
    const prompt = [
      `Extrai todos os movimentos bancários visíveis nestes prints da app Caixadirecta / banco português (data atual de referência: ${today}).`,
      "Regras estritas:",
      "1. Converte datas como 'Hoje', 'Ontem', '14 NOV' para formato ISO YYYY-MM-DD usando a data de referência.",
      "2. Se vários prints tiverem movimentos repetidos na zona de sobreposição, inclui cada movimento apenas uma vez.",
      "3. Devolve sempre 'amount' positivo e define 'type' como 'Despesa' (saída / sinal -) ou 'Receita' (entrada / sinal +).",
      "4. Se o cabeçalho mostrar 'Saldo disponível' ou 'Saldo contabilístico', preenche 'available_balance' / 'accounting_balance'; caso contrário, usa null.",
      "5. Não inventes movimentos que não estejam visíveis na imagem."
    ].join("\n");
    parts.push({ text: prompt });

    const body = {
      contents: [{ parts }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            accounting_balance: { type: "NUMBER", nullable: true },
            available_balance: { type: "NUMBER", nullable: true },
            movements: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  date: { type: "STRING" },
                  description: { type: "STRING" },
                  amount: { type: "NUMBER" },
                  type: { type: "STRING", enum: ["Despesa", "Receita"] },
                  balance_after: { type: "NUMBER", nullable: true }
                },
                required: ["date", "description", "amount", "type"]
              }
            }
          },
          required: ["movements"]
        }
      }
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (_) {
      throw new Error("Sem ligação à internet para analisar o print.");
    }
    if (!res.ok) {
      let msg = `Erro na API Gemini (${res.status}).`;
      if (res.status === 400 || res.status === 403) msg = "Gemini API Key inválida ou sem permissão. Confirma na aba Cloud.";
      if (res.status === 429) msg = "Limite temporário de pedidos Gemini atingido. Tenta novamente em segundos.";
      throw new Error(msg);
    }

    const json = await res.json();
    const rawText = json && json.candidates && json.candidates[0] && json.candidates[0].content &&
      json.candidates[0].content.parts && json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;
    if (!rawText) throw new Error("Não foi possível interpretar a resposta da imagem.");

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch (_) {
      throw new Error("Resposta inválida ao ler a imagem.");
    }

    const seenKeys = new Set();
    const rows = [];
    for (const m of payload.movements || []) {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(m.date || "")) ? String(m.date) : ptDateToIso(m.date);
      const amount = round2(Math.abs(Number(m.amount) || 0));
      const type = m.type === "Receita" ? "Receita" : "Despesa";
      const rawDesc = String(m.description || "").trim();
      if (!date || amount <= 0 || !rawDesc) continue;
      const balAfter = typeof m.balance_after === "number" && Number.isFinite(m.balance_after) ? round2(m.balance_after) : null;
      const dupKey = `${date}|${type}|${centsOf(amount)}|${normalizeText(rawDesc)}|${balAfter !== null ? centsOf(balAfter) : ""}`;
      if (seenKeys.has(dupKey)) continue;
      seenKeys.add(dupKey);
      rows.push({
        dateMov: date,
        dateVal: date,
        date,
        rawDesc,
        signedAmount: type === "Receita" ? amount : -amount,
        amount,
        type,
        balanceAfter: balAfter,
        occurrence: 1,
        rowSig: "",
        deterministicId: ""
      });
    }

    const accBal = typeof payload.accounting_balance === "number" && Number.isFinite(payload.accounting_balance)
      ? round2(payload.accounting_balance) : null;
    const availBal = typeof payload.available_balance === "number" && Number.isFinite(payload.available_balance)
      ? round2(payload.available_balance) : null;

    if (rows.length === 0 && accBal === null && availBal === null) {
      throw new Error("Não foram detetados movimentos nem saldos neste print.");
    }

    return {
      source: "image",
      emissionDate: today,
      accountingBalance: accBal,
      availableBalance: availBal,
      rows
    };
  }

  // ---------------------------------------------------------------------------
  // Motor de Reconciliação e Deduplicação 1-para-1 (Error-Proof)
  // ---------------------------------------------------------------------------
  function daysBetweenIso(d1, d2) {
    if (!d1 || !d2) return 999;
    const t1 = Date.parse(d1 + "T12:00:00Z");
    const t2 = Date.parse(d2 + "T12:00:00Z");
    if (Number.isNaN(t1) || Number.isNaN(t2)) return 999;
    return Math.round(Math.abs(t1 - t2) / 86400000);
  }

  function descriptionScore(candidateInfo, tx) {
    const tags = normalizeText((candidateInfo.tag || "") + " " + candidateInfo.description + " " + candidateInfo.rawDesc);
    const txDesc = normalizeText((tx.description || "") + " " + (tx.category || ""));
    if (!tags || !txDesc) return 0;
    const tagWords = tags.split(" ").filter((w) => w.length >= 3);
    let hits = 0;
    for (const w of tagWords) {
      if (txDesc.includes(w)) hits++;
    }
    return hits;
  }

  function reconcileImport(parsed, existingTransactions, options) {
    const opts = options || {};
    const defaultAccount = opts.defaultAccount || "Dinheiro Mãe";
    const accounts = opts.accounts || [];
    const categories = opts.categories || [];
    const checkpoint = opts.checkpoint || DEFAULT_CHECKPOINT;
    const cpDate = (checkpoint && checkpoint.date) || "";
    const cpSig = (checkpoint && checkpoint.sig) || "";

    const settledExisting = (existingTransactions || []).filter((t) => t && !isCativoTx(t));
    const cativoExisting = (existingTransactions || []).filter((t) => t && isCativoTx(t));

    // Calcular saldos atuais da App
    const initialSum = accounts.reduce((s, a) => s + Number(a.initial_balance || 0), 0);
    const settledNet = settledExisting.reduce((s, t) => {
      const a = Number(t.amount || 0);
      if (t.type === "Receita") return s + a;
      if (t.type === "Despesa") return s - a;
      return s;
    }, 0);
    const currentCativoNet = cativoExisting.reduce((s, t) => {
      const a = Number(t.amount || 0);
      return t.type === "Receita" ? s + a : s - a;
    }, 0);
    const baseContabilistico = round2(initialSum + settledNet);

    // 1. Filtrar âncora do PDF ou data de checkpoint
    let candidateRows = parsed.rows || [];
    let skippedOldCount = 0;
    let anchorFound = false;

    if (parsed.source === "pdf" && cpSig) {
      const anchorIdx = candidateRows.findIndex((r) => r.rowSig === cpSig);
      if (anchorIdx >= 0) {
        anchorFound = true;
        skippedOldCount = candidateRows.length - anchorIdx;
        candidateRows = candidateRows.slice(0, anchorIdx);
      }
    }

    if (!anchorFound && parsed.source === "pdf" && cpDate) {
      const filtered = [];
      for (const r of candidateRows) {
        if (r.dateMov < cpDate && r.dateVal < cpDate) {
          skippedOldCount++;
        } else {
          filtered.push(r);
        }
      }
      candidateRows = filtered;
    }

    // 2. Classificar e fazer deduplicação 1-para-1 contra settledExisting
    const usedIds = new Set();

    // 2a. Em modo PDF com âncora, reservar primeiro os movimentos recentes até à âncora
    // para que registos antigos (ex: café de 12/11) nunca sejam confundidos com novos (ex: 16/11).
    if (anchorFound && cpDate) {
      const anchorIdx = (parsed.rows || []).length - skippedOldCount;
      const preAnchorWindow = (parsed.rows || [])
        .slice(anchorIdx)
        .filter((r) => daysBetweenIso(r.dateMov || r.dateVal, cpDate) <= 10);
      for (const r of preAnchorWindow) {
        if (r.deterministicId) {
          const exact = settledExisting.find((t) => !usedIds.has(t.id) && t.id === r.deterministicId);
          if (exact) { usedIds.add(exact.id); continue; }
        }
        const tCents = centsOf(r.amount);
        let bestId = null;
        let bestScore = -1;
        for (const tx of settledExisting) {
          if (usedIds.has(tx.id) || tx.type !== r.type || centsOf(tx.amount) !== tCents) continue;
          const dist = Math.min(daysBetweenIso(r.dateVal, tx.date), daysBetweenIso(r.dateMov, tx.date));
          if (dist > 4) continue;
          const score = 100 - dist * 5;
          if (score > bestScore) { bestScore = score; bestId = tx.id; }
        }
        if (bestId) usedIds.add(bestId);
      }
    }

    const items = [];

    for (let i = 0; i < candidateRows.length; i++) {
      const row = candidateRows[i];
      const info = classifyMerchant(row.rawDesc, row.signedAmount, row.type, defaultAccount, accounts, categories);
      const targetCents = centsOf(row.amount);
      const rowRefDate = row.dateVal || row.date;

      let matchedTx = null;
      // Pass 1: ID determinístico exato
      if (row.deterministicId) {
        const exact = settledExisting.find((t) => !usedIds.has(t.id) && t.id === row.deterministicId);
        if (exact) matchedTx = exact;
      }

      // Pass 2: Match 1-para-1 por tipo + valor exato em cêntimos + janela temporal <= 4 dias
      // Movimentos pós-checkpoint nunca roubam registos anteriores ao checkpoint.
      if (!matchedTx) {
        let bestScore = -1;
        for (const tx of settledExisting) {
          if (usedIds.has(tx.id)) continue;
          if (tx.type !== info.type) continue;
          if (centsOf(tx.amount) !== targetCents) continue;
          if (cpDate && rowRefDate > cpDate && tx.date < cpDate) continue;
          const dist = Math.min(daysBetweenIso(row.dateVal, tx.date), daysBetweenIso(row.dateMov, tx.date));
          if (dist > 4) continue;
          const descBonus = descriptionScore({ ...info, rawDesc: row.rawDesc }, tx) * 10;
          const score = 100 - dist * 5 + descBonus;
          if (score > bestScore) {
            bestScore = score;
            matchedTx = tx;
          }
        }
      }

      if (matchedTx) usedIds.add(matchedTx.id);

      const beforeCheckpoint = !anchorFound && parsed.source === "image" && cpDate && row.date < cpDate;
      let status = "new";
      if (matchedTx) status = "existing";
      else if (beforeCheckpoint) status = "before_checkpoint";

      items.push({
        idx: i,
        id: row.deterministicId || "",
        rowSig: row.rowSig || "",
        date: row.dateVal || row.date,
        dateMov: row.dateMov || row.date,
        rawDesc: row.rawDesc,
        description: info.description,
        type: info.type,
        account: info.account,
        category: info.category,
        payment_method: info.payment_method,
        amount: row.amount,
        balanceAfter: row.balanceAfter,
        status,
        matchedTxId: matchedTx ? matchedTx.id : null,
        selected: status === "new"
      });
    }

    const newestRow = (parsed.rows || [])[0] || null;
    const nextCheckpoint = newestRow && newestRow.rowSig
      ? { date: newestRow.dateMov || newestRow.date, sig: newestRow.rowSig, updated_at: Date.now() }
      : checkpoint;

    return {
      source: parsed.source,
      accountingBalance: parsed.accountingBalance,
      availableBalance: parsed.availableBalance,
      baseContabilistico,
      currentCativoNet: round2(currentCativoNet),
      currentAppBalance: round2(baseContabilistico + currentCativoNet),
      skippedOldCount,
      anchorFound,
      nextCheckpoint,
      items
    };
  }

  function evaluateReconciliationSummary(reconciliation, applyCativo) {
    const rec = reconciliation;
    const selectedNewNet = (rec.items || []).reduce((s, it) => {
      if (!it.selected) return s;
      const amt = round2(it.amount);
      return it.type === "Receita" ? s + amt : s - amt;
    }, 0);

    const projectedContabilistico = round2(rec.baseContabilistico + selectedNewNet);
    const hasAccBal = typeof rec.accountingBalance === "number";
    const hasAvailBal = typeof rec.availableBalance === "number";

    let accountingDiff = null;
    let newCativoAmount = null;
    let canApplyCativo = false;
    let projectedAvailable = round2(projectedContabilistico + rec.currentCativoNet);
    let warning = "";

    if (hasAccBal) {
      accountingDiff = round2(projectedContabilistico - rec.accountingBalance);
      const bankCativo = hasAvailBal ? round2(rec.accountingBalance - rec.availableBalance) : 0;
      if (Math.abs(accountingDiff) < 0.01 && bankCativo >= 0) {
        newCativoAmount = bankCativo;
        canApplyCativo = hasAvailBal;
        if (applyCativo && hasAvailBal) {
          projectedAvailable = round2(projectedContabilistico - newCativoAmount);
        }
      } else if (Math.abs(accountingDiff) >= 0.01) {
        const sign = accountingDiff > 0 ? "+" : "";
        warning = `Diferença contabilística de ${sign}${accountingDiff.toFixed(2).replace(".", ",")} € face ao banco (${rec.accountingBalance.toFixed(2).replace(".", ",")} €).`;
      }
    } else if (hasAvailBal) {
      const impliedCativo = round2(projectedContabilistico - rec.availableBalance);
      if (impliedCativo >= 0 && impliedCativo <= 100) {
        newCativoAmount = impliedCativo;
        canApplyCativo = true;
        if (applyCativo) {
          projectedAvailable = round2(projectedContabilistico - newCativoAmount);
        }
      } else if (impliedCativo < 0) {
        warning = `Saldo da App (${projectedContabilistico.toFixed(2).replace(".", ",")} €) ficaria abaixo do saldo do print (${rec.availableBalance.toFixed(2).replace(".", ",")} €).`;
      }
    }

    return {
      selectedCount: (rec.items || []).filter((i) => i.selected).length,
      selectedNewNet: round2(selectedNewNet),
      projectedContabilistico,
      accountingDiff,
      newCativoAmount,
      canApplyCativo,
      projectedAvailable,
      warning
    };
  }

  root.FinImport = {
    DEFAULT_CHECKPOINT,
    parsePtAmount,
    ptDateToIso,
    isCativoTx,
    classifyMerchant,
    parseCgdPdfLines,
    parseCgdPdfFile,
    parseScreenshotsWithGemini,
    reconcileImport,
    evaluateReconciliationSummary
  };
})(typeof window !== "undefined" ? window : globalThis);
