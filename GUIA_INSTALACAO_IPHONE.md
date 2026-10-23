# 📱 Guia de Utilização 100% Web (GitHub Pages + Cloud Privada 24/7)

A tua aplicação de **Finanças Pessoais** agora funciona **100% na Web** com endereço oficial `https://`!
- **No iPhone**: Abre em 0,1s (mesmo em 4G/5G ou sem rede no metro), podes fechar a aba do Safari sempre que quiseres e nunca precisas de ter o PC ligado nem usar Hotspot.
- **No Computador**: Abre no teu browser em qualquer ecrã com visual de 3 colunas e descarrega o ficheiro `Gestao_Financeira.xlsx` completo com 1 clique (mesmo sem o servidor Python a correr!).
- **Na Cloud 24/7**: Todos os movimentos, contas, categorias e recorrentes sincronizam automaticamente através do teu repositório **privado** no GitHub.

---

## Passo 1: Criar o Repositório Privado de Dados no GitHub (onde os dados ficam guardados)

1. Abre o GitHub no teu browser: [github.com/new](https://github.com/new).
2. Dá o nome ao repositório: **`financas-data`**.
3. **MUITO IMPORTANTE**: Escolhe **Private** (Privado) para que só tu tenhas acesso aos teus registos financeiros.
4. Marca a opção **"Add a README file"** e clica em **Create repository**.

---

## Passo 2: Criar um Token de Acesso no GitHub (PAT)

Para a app conseguir ler e gravar os dados de forma segura no teu repositório privado:

1. Abre as definições de tokens do GitHub: [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta) (Fine-grained tokens).
2. Clica em **Generate new token**.
3. Preenche:
   - **Token name**: `Financas App`
   - **Expiration**: Escolhe a validade (ex: 90 dias ou 1 ano).
   - **Repository access**: Escolhe **Only select repositories** e seleciona o **`financas-data`**.
   - **Permissions** -> **Repository permissions**:
     - Procura **Contents** e muda para **Read and write** (leitura e escrita).
4. Clica em **Generate token** no fundo da página.
5. Copia o token gerado (começa por `github_pat_...`).

---

## Passo 3: Publicar a App no GitHub Pages (com 1 Duplo-Clique)

1. No teu browser, cria o repositório para o código da app: [github.com/new](https://github.com/new) com o nome **`financas-app`**.
   - Escolhe **Public (Público)** *(o GitHub Pages só é gratuito em repositórios públicos; não te preocupes com a privacidade, pois este repositório contém apenas o visual/código da app, zero dados financeiros teus)*.
   - Podes deixar as caixas ("Add README", etc.) desmarcadas e clica em **Create repository**.
2. Na tua pasta do PC, faz duplo clique no ficheiro:
   **`PUBLICAR_APP_WEB.bat`**
   *(Se for a primeira vez, ele pede o nome do repositório: escreve `financas-app` e carrega Enter).*
3. No GitHub, abre o teu repositório `financas-app` e vai a:
   **Settings** ➡️ **Pages** (no menu lateral esquerdo).
4. Na secção **Build and deployment**:
   - **Source**: `Deploy from a branch`
   - **Branch**: seleciona `main` e a pasta `/ (root)`.
   - Clica em **Save**.
5. Em 1 minuto, o teu link oficial estará ativo em:
   **`https://diogoribeir07.github.io/financas-app/`**

---

## Passo 4: Ligar a App à Cloud (No PC e no iPhone)

### No PC ou no iPhone:
1. Abre o link da tua app: `https://diogoribeir07.github.io/financas-app/`.
2. Vai à aba **☁️ Cloud** (no menu lateral do PC ou na barra inferior do iPhone).
3. Em **Fornecedor Cloud**, seleciona: **GitHub Privado (24/7) - Recomendado**.
4. Preenche:
   - **Utilizador GitHub**: `diogoribeir07`
   - **Repositório de dados**: `financas-data`
   - **Token de acesso**: cola o token que copiaste no Passo 2 (`github_pat_...`).
5. Clica em **Testar Ligação** (deve aparecer: *"Ligação OK: diogoribeir07/financas-data (privado, com escrita)"*).
6. Clica em **Guardar Configuração Cloud**.

> [!TIP]
> **No iPhone:**
> 1. Abre o link no **Safari**: `https://diogoribeir07.github.io/financas-app/`.
> 2. Toca no botão de **Partilhar** do Safari (quadrado com seta para cima) ➡️ **Adicionar ao Ecrã Principal**.
> 3. Abre o ícone no teu ecrã: a app abre em ecrã inteiro sem barras de browser, abre em 0,1s e podes fechar a aba sempre que quiseres!
> 4. Na primeira vez, vai à aba Cloud e coloca as mesmas 3 informações (Utilizador, `financas-data`, Token) e clica em Guardar.
> 5. A partir desse momento, **tudo o que fizeres no iPhone entra na cloud na hora e aparece no PC automaticamente**!

---

## Passo 5: Como Ter o Ficheiro Excel (.xlsx) Atualizado

Tens agora **duas formas super práticas**:

1. **Direto no Navegador (PC ou iPhone, sem ligar nada)**:
   - Em qualquer dispositivo, clica no botão **"Transferir Gestao_Financeira.xlsx"**.
   - O browser gera instantaneamente o ficheiro `.xlsx` completo com 4 folhas organizadas:
     - `Resumo_Contas` (saldos atuais, receitas, despesas e património total).
     - `Registo_Gastos` (todas as transações com autofiltro).
     - `Recorrentes` (deduções mensais).
     - `Categorias` (totais por categoria).

2. **No PC com o Servidor Local (OneDrive)**:
   - Se quiseres atualizar o ficheiro original com formatação rica no OneDrive, basta fazer duplo clique em **`Sincronizar_Cloud_Excel.bat`** ou correr `Iniciar_App_Financas.bat`.
   - Ele puxa automaticamente tudo o que registaste no telemóvel para o `Gestao_Financeira.xlsx`!
