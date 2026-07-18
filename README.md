# coder-cli

`coder` 是一個 CLI 工具，讓 AI agent（`claude` CLI）在跟主專案分離的 git 沙盒裡自主完成任務：抓任務、切分支、跑 Claude、寫 commit，全部自動化，主專案的工作目錄全程保持乾淨。

## 核心概念

- **主專案 (main project)**：你平常在開發的那個 git repo，`.coder/` 控制平面就放在這裡。
- **沙盒 (sandbox)**：另一個獨立的 git repo，透過 `git remote` 跟主專案綁在一起（`receive.denyCurrentBranch=updateInstead`）。Claude 實際做修改、commit 都發生在這裡，不會碰到主專案的工作目錄。
- **`.coder/`**：控制平面目錄，內含：
  - `tasks.db`（sqlite）：所有任務的清單與狀態
  - `config`：記錄 sandbox 的 remote name → 路徑（`coder init` 寫入，格式仿 `.git/config`）
  - `hooks/`：專案自訂的腳本（見下方「Hooks」）
  - `prompts/`：餵給 Claude 的 system prompt（`run.md`、`commit.md`）
  - `claude-sandbox-settings.json`：傳給 `claude --settings` 的權限/沙盒設定

  `.coder/` 預設會被加進 `.gitignore`，不會進版控。

## 安裝需求

- Node.js >= 18
- git
- [`claude`](https://claude.com/claude-code) CLI 要在 PATH 上（`coder commit`、`coder run` 會呼叫它）

## 安裝

這個套件還沒發布到 npm registry，但可以直接用 npm 從 GitHub 安裝：

```bash
npm install -g github:cl-liamchiu/coder
```

確認安裝成功：

```bash
coder --version
```

## 快速開始

```bash
# 1. 在主專案裡初始化，順便建立一個沙盒並綁定 remote
cd my-project
coder init sandbox ../my-project-sandbox

# 2. 寫 .coder/hooks/task-fetch(.sample 要重新命名)，串接你的任務來源
#    （Linear / Jira / GitHub Issues / 本地檔案都行，見下方 Hooks 說明）
mv .coder/hooks/task-fetch.sample .coder/hooks/task-fetch

# 3. 把任務同步進 tasks.db
coder fetch

# 4. 看看有哪些任務
coder list

# 5. 讓 Claude 自主跑任務（預設跑全部 TODO；也可以指定 id / ticketId）
coder run
```

## 任務狀態機

```
TODO ──(coder run 開始)──▶ IN_PROGRESS ──(成功)──▶ IN_REVIEW ──(coder close)──▶ DONE
  ▲                              │
  └──────────(失敗，自動回滾)─────┘
```

`REJECTED` 是保留狀態（`coder list`/`view` 已支援篩選），但目前沒有任何指令會自動寫入它——留給人工 review 後「這個任務不要合併」的最終結果之類用途，可用 `coder edit <id> --status REJECTED` 手動標記。`ON_HOLD` 則是用來暫停某個任務、不讓 agent 撿去跑（`coder run` 不帶 id 時只抓 `TODO`，`coder fetch` 同步邏輯也會保護 `ON_HOLD` 不被外部來源覆寫），一樣用 `coder edit <id> --status ON_HOLD` 設定，或讓 `task-fetch` 直接回傳 `status: "ON_HOLD"`。`task-fetch` 同步邏輯會用 `DONE` 判斷「這個 ticketId 是否可以重新開一筆新任務」。

## 指令參考

### 任務選取規則：`<id>` 還是 `<ticketId>`？

`coder view`、`coder edit`、`coder commit`、`coder run`、`coder review`、`coder close` 都用同一個位置參數指定要操作哪個任務，不再有獨立的 `-t/--ticketId` 選項：純數字（例如 `5`）視為 `id`，其他任何字串（例如 `TICK-123`）視為 `ticketId`。兩者只看格式，不會互相 fallback——如果你的 `ticketId` 剛好是純數字，請改用它對應的 `id` 查詢。

用 `ticketId` 查詢時，除了 `coder view`（會列出該 ticketId 底下所有紀錄、不限狀態），其他指令都是取最新一筆非 `DONE` 的紀錄。

### `coder init <name> <path>`

在目前目錄（必須已經是 git repo）建立 `.coder/`，並在 `<path>` 建立一個新的沙盒 repo，綁定成 git remote `<name>`。

- 已存在的 `.coder/` 不會被覆蓋（可以重複執行 `coder init <otherName> <otherPath>` 建立多個沙盒設定，但目前 `coder run` 只支援單一 sandbox）
- 會檢查沙盒的 git 作者設定（`user.name`/`user.email`），沒有的話會提醒你自行設定，因為 `coder run` 之後在沙盒裡 commit 需要它

### `coder fetch`

執行 `.coder/hooks/task-fetch`，把回傳的任務同步進 `tasks.db`。每筆任務可以帶 `status` 欄位（沒帶就預設 `TODO`；`DONE` 不接受，理由同 `coder edit`），套用規則如下：

- 沒有 `ticketId` → 一律新增（帶指定或預設的 status）
- 有 `ticketId`：
  - 全新 ticketId，或該 ticketId 底下所有紀錄都是 `DONE` → 新增一筆
  - 現有紀錄是 `TODO` → 更新內容（title/body/baseBranch/status，這是唯一會真正改到既有 row 的情況）
  - 現有紀錄是 `IN_PROGRESS`/`IN_REVIEW`/`ON_HOLD`/`REJECTED` → 跳過，保護進行中或刻意暫停的工作

### `coder list`

```
coder list [-a|--all] [-s|--status <status>] [-q|--query <keyword>]
```

預設隱藏 `DONE` 的任務。`-a` 顯示全部；`-s` 精準篩選單一狀態（會蓋過預設的隱藏行為）；`-q` 是部分比對搜尋（title/body），可以疊加使用。

### `coder view [id]`

```
coder view <id>
coder view <ticketId>
```

顯示單一任務的完整內容（title/body/建立時間等）。用 `ticketId` 查詢時，同一個 ticketId 若有多筆紀錄會全部列出。

### `coder edit [id]`

```
coder edit <id> [-t/--title <title>] [-b/--body <body>] [-s/--status <status>] [--baseBranch <baseBranch>]
coder edit <ticketId> -s ON_HOLD
coder edit <id> -s   # 不帶值 => 跳出互動選單挑狀態
```

直接修改 `tasks.db` 裡一筆任務的欄位，不會觸發 Claude 或任何 git 操作。至少要提供一個要改的欄位。常見用途：`coder edit <id> --status ON_HOLD` 把某個任務標成暫停，讓它不會被 `coder run`（不帶 id 時）撿去跑，也不會被 `coder fetch` 的同步邏輯覆寫。

`--status` 不帶值時會列出可設定的狀態讓你輸入編號或名稱挑選，而不用自己記狀態字串怎麼拼。

`--status` 不能設成 `DONE`——`DONE` 只能透過 `coder close` 的完整流程（merge、`closedAt`、`post-close` hook、刪分支）產生，用 `edit` 直接改欄位會繞過這些，讓資料跟實際狀態不一致。

### `coder commit [id]`

```
coder commit <id> [--sessionId <sessionId>]
coder commit <ticketId> [--sessionId <sessionId>]
```

在目前目錄（git repo）的暫存區沒有東西時會直接提示並結束。有暫存變更時：

1. 依 `id` 或 `ticketId`（取最新一筆非 `DONE` 的紀錄）找出對應任務
2. 把任務的 title/body 透過 stdin 傳給 `claude -p --append-system-prompt-file .coder/prompts/commit.md --output-format json`，讓 Claude 自己跑 `git diff --cached` 來寫 commit message
3. 如果存在 `.coder/hooks/format-commit-msg`（或 `.js`），把 `{"message": <Claude 產生的原始訊息>, "task": {...任務完整欄位}}` 這包 JSON 餵進它的 stdin、用它的 stdout（trim 後）當最終訊息（這個 hook 失敗會直接中止 commit）
4. `git commit`

`--sessionId` 會轉成 `claude --resume`，用來接續 `coder run` 裡跑任務時的 session。

**`CODER_PROJECT_ROOT`**：`coder commit` 的 git 操作永遠對 `process.cwd()` 動作，但找 `.coder/`（tasks.db、prompts、hooks）預設也是用 cwd —— 除非設了 `CODER_PROJECT_ROOT` 環境變數，這時候會改去那個路徑找控制平面檔案。這是為了讓 `coder run` 能在沙盒目錄（cwd）裡呼叫 `coder commit`，同時讓它讀到主專案（`CODER_PROJECT_ROOT`）的任務資料。一般手動使用不需要設這個。

### `coder run [ids...]`

```
coder run                          # 沒指定 → 跑全部 TODO 任務
coder run 1 2 3                    # 指定多個 id
coder run TICK-1 TICK-2            # 指定多個 ticketId
coder run 1 TICK-2                 # id 跟 ticketId 可混用，重複解析到同一筆任務會自動去重
```

針對每一筆任務依序執行：

1. `tasks.db` 狀態改成 `IN_PROGRESS`
2. 在主專案 `git push <sandbox> <task.baseBranch>`，讓沙盒同步到最新的 base branch
3. 在沙盒裡建立並切換到 `coder/<baseBranch>/task-<id>-<safeTicketId>` 分支（`git checkout -b ... <baseBranch>`）
4. 在沙盒裡跑 `claude -p --append-system-prompt-file .coder/prompts/run.md --output-format json`（title/body 一樣透過 stdin 傳入）；這步執行期間不會顯示動畫進度，只會印一行「請稍候」的靜態訊息，因為它是同步呼叫，跑多久畫面就會靜止多久
5. 在沙盒裡執行 `git add -A`，把 Claude 改的東西全部暫存起來（Claude 本身不保證會自己 `git add`，這步是為了確保接下來的 commit 不會因為暫存區是空的而被跳過）
6. 用拿到的 `session_id` 呼叫 `coder commit <id> --sessionId <sessionId>`（cwd 設成沙盒、`CODER_PROJECT_ROOT` 指回主專案）
7. 全部成功 → 狀態改 `IN_REVIEW`；任一步失敗 → `git reset --hard` + `git clean -fd`、切回 `baseBranch`、刪掉剛建立的任務分支、狀態退回 `TODO`，並中止整個 `run`（不會繼續跑下一筆任務），印出失敗原因

分支名稱用固定的 `coder/` 命名空間前綴，是為了避免 `baseBranch` 本身（例如 `main`）跟底下的任務分支在 git ref 路徑上衝突（`refs/heads/main` 和 `refs/heads/main/xxx` 不能同時存在）。

沒有 ticketId 的任務，分支名裡會用 `local` 代替。

### `coder review [id]`

```
coder review <id>
coder review <ticketId>
```

把 `coder run` 在沙盒裡完成的任務分支拉回主專案，方便你用熟悉的工具（`git diff`、VSCode 等）review：

1. 依 `id` 或 `ticketId`（取最新一筆非 `DONE` 的紀錄）找出對應任務，算出跟 `coder run` 相同規則的分支名稱 `coder/<baseBranch>/task-<id>-<safeTicketId>`
2. 在主專案執行 `git fetch <sandbox> <該分支>`
3. `git checkout -B <該分支> FETCH_HEAD`，把主專案的工作目錄切到這個分支（重複執行會直接覆蓋成沙盒最新的內容）
4. 印出該分支最新一筆 commit 的 hash 與完整 commit message

如果分支在沙盒裡還不存在（例如這個任務還沒 `coder run` 過），`git fetch` 會失敗並提示可能是這個原因。

### `coder close [id]`

```
coder close <id>
coder close <ticketId>
coder close              # 沒指定 → 用目前所在的 coder/ 任務分支反推是哪個任務
```

預期先用 `coder review` 把任務分支拉到主專案看過、覺得可以合併了，再用這個指令正式收尾（`coder close` 本身不會去 sandbox 拉分支，只認主專案裡已經存在的本地分支）：

1. 找出要關閉的任務：給了 `id` 或 `ticketId` 就用它查；都沒給的話，檢查目前所在的本地分支，如果是 `coder/<baseBranch>/task-<id>-<ticketId>` 這種任務分支，就從分支名稱反推出任務 id（並確認解析出的 baseBranch 跟資料庫紀錄一致，否則報錯）；如果目前分支不是任務分支，就報錯並提示改用 `<id>` 或 `<ticketId>`
2. 算出分支名稱、確認任務的 `baseBranch` 在主專案裡存在，以及該任務分支也已經存在於主專案（兩者缺一都直接報錯、不做任何變更；後者會提示先執行 `coder review`）
3. 切換到該分支，`git rebase <baseBranch>` 把它墊到最新的 `baseBranch` 上
4. 切換到 `baseBranch`，`git merge --ff-only` 合併進去（線性歷史，不會產生 merge commit）
5. 合併成功後：任務狀態改成 `DONE`（並寫入 `closedAt`），接著刪除該分支——主專案跟 sandbox 都刪
6. 如果 `.coder/hooks/post-close`（或 `.js`）存在，把更新後的完整任務 row（含 `status: 'DONE'`、`closedAt`）當 JSON 餵進它的 stdin 執行它

如果 rebase 途中發生衝突，`coder close` 會自動 `git rebase --abort` 並切回你執行指令前所在的分支，任務狀態維持不變（不會變成 `DONE`，也不會變回其他狀態）；已經從 sandbox 拉下來的本地分支會保留著，方便你自行排解衝突後重新處理。

合併一旦成功（fast-forward 進 `baseBranch`），任務就會標記為 `DONE`；之後的分支清理、`post-close` hook 執行都是 best-effort——就算失敗也只會印出警告，不會讓指令回報失敗或把任務狀態改回去。

## Hooks

放在 `.coder/hooks/`，`coder init` 會附上範本（`*.sample`，純 bash 腳本），需要自行重新命名/客製化。無副檔名的可執行檔（靠 shebang，例如 `#!/usr/bin/env bash`）優先，`.js` 是 Windows 相容用的 fallback（Windows 不支援 shebang，只認 `.js` 並用 `node` 執行）——所以 hook 不一定要用 Node.js 寫，bash/python 都行。`task-fetch` 在 Windows 上只支援 `.js`（無 shebang 支援）；其他平台可用無副檔名的可執行檔或 `.js`。

範例 hook（`format-commit-msg`、`post-close`）用 `jq` 解析/組裝 JSON，執行環境要有裝 `jq`。

### 全域規則（三支 hook 共用）

- **stdout 是純資料通道，其他一律走 stderr。** 任何 hook 只要有寫東西回 stdout（不管是回傳資料還是不小心印的 log/進度訊息/錯誤訊息），整段 stdout 都會被當成資料去解析——不是只看最後一行，也不會自動濾掉雜訊。log、進度條、debug 輸出、提示訊息都必須印到 **stderr**；stderr 會被原封不動轉發到你的終端機，不影響資料解析，但也不會被 coder 讀取或驗證。
- **有輸出資料的 hook，輸出一律是 JSON**，格式視資料形狀而定（陣列 vs 單一物件），細節看下面各 hook 的 Response。整段 stdout（trim 後）必須剛好就是那個 JSON，可以是 pretty-print 多行格式，但前後不能混雜其他文字。
- **有輸入資料的 hook，輸入一律用 JSON 從 stdin 餵進去**（`task-fetch` 例外，見下方——它沒有輸入，stdin 直接繼承你的終端機）。
- 任何一支 hook 的 stdout 不符合上述格式，`coder` 都會直接報錯中止，不會把不明內容當成資料使用。

### `task-fetch` / `task-fetch.js`

用途：讓 `coder fetch` 知道有哪些新任務可以撿。必要 hook——沒有這支腳本，`coder fetch` 直接失敗。

- **觸發時機**：`coder fetch`
- **Request（stdin）**：無。stdin 直接繼承終端機，hook 可以自行讀取（例如互動輸入 token），但 coder 不會主動餵任何資料進去。
- **Response（stdout）**：整段 stdout 必須「就是」一個 JSON 陣列：
  ```jsonc
  [
    {
      "ticketId": "string | null",   // 選填；用來跨次執行去重/更新，沒有穩定 id 就省略或給 null
      "title": "string",             // 必填
      "body": "string",              // 選填
      "baseBranch": "string",        // 必填；sandbox 開始工作前要 checkout 的分支
      "status": "TODO | IN_PROGRESS | IN_REVIEW | ON_HOLD | REJECTED | DONE"  // 選填，預設 TODO；DONE 不接受
    }
  ]
  ```
- **錯誤情境**：exit code 非 0、stdout 為空、stdout 不是合法 JSON、JSON 不是陣列、陣列元素缺必填欄位或 `status` 不合法——都會讓 `coder fetch` 整批失敗（DB 不會有任何寫入，failure 是 all-or-nothing）。

### `format-commit-msg` / `format-commit-msg.js`

用途：在 Claude 產生 commit message 之後、`git commit` 執行之前，讓你套用專案自己的格式規則。選用 hook——不存在就直接用 Claude 產生的原始訊息。

- **觸發時機**：`coder commit`，Claude 產生訊息之後、實際 commit 之前
- **Request（stdin）**：JSON
  ```jsonc
  {
    "message": "string",  // Claude 產生的原始 commit message
    "task": { "id": 1, "ticketId": "string | null", "title": "string", "body": "string | null", "status": "string", "baseBranch": "string", "createdAt": "string" }
  }
  ```
- **Response（stdout）**：整段 stdout 必須「就是」：
  ```jsonc
  { "message": "string" }  // 最終要拿去 commit 的訊息，可以多行
  ```
- **錯誤情境**：exit code 非 0、stdout 為空、stdout 不是合法 JSON、`message` 不存在或不是非空字串——都會讓 `coder commit` 中止（此時還沒有 commit，不會留下半成品）。

### `post-close` / `post-close.js`

用途：任務關閉後通知外部系統（任務追蹤工具、下游自動化…）。選用 hook，且是 best-effort 通知，不影響 `coder close` 本身的結果。

- **觸發時機**：`coder close`，任務合併進 `baseBranch` 並轉成 `DONE` 之後
- **Request（stdin）**：JSON，更新後的完整任務 row
  ```jsonc
  { "id": 1, "ticketId": "string | null", "title": "string", "body": "string | null", "status": "DONE", "baseBranch": "string", "createdAt": "string", "closedAt": "string" }
  ```
- **Response（stdout）**：無——這支 hook 的 stdout 不會被 coder 讀取或解析，愛印什麼都行（但仍建議照全域規則走 stderr）。
- **錯誤情境**：exit code 非 0 或任何執行錯誤只會印出警告（`已略過`），不會讓 `coder close` 回報失敗，任務仍然是 `DONE`。

## 環境變數

| 變數 | 用途 |
|---|---|
| `CODER_PROJECT_ROOT` | 讓 `coder commit` 在「git 操作對 cwd、但控制平面在別的資料夾」的情境下運作，`coder run` 呼叫子行程 `coder commit` 時會自動設定 |

## 安全性備註

- 所有 git / `claude` 子行程呼叫都用 `execFileSync` + 陣列參數，不經過 shell，避免注入
- `coder run` 失敗時一定會嘗試把沙盒復原到乾淨狀態（reset + clean + 切回 base branch + 刪除任務分支），復原本身失敗也不會蓋掉原始錯誤訊息
- `coder commit` 只在暫存區有東西時才會動作，不會憑空 commit
