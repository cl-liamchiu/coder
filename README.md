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
coder task fetch

# 4. 看看有哪些任務
coder task list

# 5. 讓 Claude 自主跑任務（預設跑全部 TODO；也可以指定 id / ticketId）
coder run
```

## 任務狀態機

```
TODO ──(coder run 開始)──▶ IN_PROGRESS ──(成功)──▶ IN_REVIEW ──(coder close)──▶ DONE
  ▲                              │
  └──────────(失敗，自動回滾)─────┘
```

`REJECTED` 是保留狀態（`coder task list`/`view` 已支援篩選），但目前沒有任何指令會寫入它——留給人工 review 後「這個任務不要合併」的最終結果之類用途。`task-fetch` 同步邏輯會用 `DONE` 判斷「這個 ticketId 是否可以重新開一筆新任務」。

## 指令參考

### `coder init <name> <path>`

在目前目錄（必須已經是 git repo）建立 `.coder/`，並在 `<path>` 建立一個新的沙盒 repo，綁定成 git remote `<name>`。

- 已存在的 `.coder/` 不會被覆蓋（可以重複執行 `coder init <otherName> <otherPath>` 建立多個沙盒設定，但目前 `coder run` 只支援單一 sandbox）
- 會檢查沙盒的 git 作者設定（`user.name`/`user.email`），沒有的話會提醒你自行設定，因為 `coder run` 之後在沙盒裡 commit 需要它

### `coder task fetch`

執行 `.coder/hooks/task-fetch`，把回傳的任務同步進 `tasks.db`：

- 沒有 `ticketId` → 一律新增
- 有 `ticketId`：
  - 全新 ticketId，或該 ticketId 底下所有紀錄都是 `DONE` → 新增一筆
  - 現有紀錄是 `TODO` → 更新內容（title/body/baseBranch）
  - 現有紀錄是 `IN_PROGRESS`/`IN_REVIEW`/`REJECTED` → 跳過，保護進行中的工作

### `coder task list`

```
coder task list [-a|--all] [-s|--status <status>] [-t|--ticketId <id>] [-q|--query <keyword>]
```

預設隱藏 `DONE` 的任務。`-a` 顯示全部；`-s` 精準篩選單一狀態（會蓋過預設的隱藏行為）；`-t`/`-q` 是部分比對搜尋，可以疊加使用。

### `coder task view [id]`

```
coder task view <id>
coder task view -t <ticketId>
```

顯示單一任務的完整內容（title/body/建立時間等）。用 `-t` 查詢時，同一個 ticketId 若有多筆紀錄會全部列出。

### `coder commit [id]`

```
coder commit <id> [--sessionId <sessionId>]
coder commit -t <ticketId> [--sessionId <sessionId>]
```

在目前目錄（git repo）的暫存區沒有東西時會直接提示並結束。有暫存變更時：

1. 依 `id` 或 `ticketId`（取最新一筆非 `DONE` 的紀錄）找出對應任務
2. 把任務的 title/body 透過 stdin 傳給 `claude -p --append-system-prompt-file .coder/prompts/commit.md --output-format json`，讓 Claude 自己跑 `git diff --cached` 來寫 commit message
3. 如果存在 `.coder/hooks/format-commit-msg.js`，把 Claude 產生的訊息餵進去、用它的 stdout 當最終訊息（這個 hook 失敗會直接中止 commit）
4. `git commit`

`--sessionId` 會轉成 `claude --resume`，用來接續 `coder run` 裡跑任務時的 session。

**`CODER_PROJECT_ROOT`**：`coder commit` 的 git 操作永遠對 `process.cwd()` 動作，但找 `.coder/`（tasks.db、prompts、hooks）預設也是用 cwd —— 除非設了 `CODER_PROJECT_ROOT` 環境變數，這時候會改去那個路徑找控制平面檔案。這是為了讓 `coder run` 能在沙盒目錄（cwd）裡呼叫 `coder commit`，同時讓它讀到主專案（`CODER_PROJECT_ROOT`）的任務資料。一般手動使用不需要設這個。

### `coder run [ids...]`

```
coder run                          # 沒指定 → 跑全部 TODO 任務
coder run 1 2 3                    # 指定多個 id
coder run -t TICK-1 -t TICK-2      # 指定多個 ticketId（-t 可重複）
coder run 1 -t TICK-2              # id 跟 ticketId 可混用，重複解析到同一筆任務會自動去重
```

針對每一筆任務依序執行：

1. `tasks.db` 狀態改成 `IN_PROGRESS`
2. 在主專案 `git push <sandbox> <task.baseBranch>`，讓沙盒同步到最新的 base branch
3. 在沙盒裡建立並切換到 `coder/<baseBranch>/task-<id>-<safeTicketId>` 分支（`git checkout -b ... <baseBranch>`）
4. 在沙盒裡跑 `claude -p --append-system-prompt-file .coder/prompts/run.md --output-format json`（title/body 一樣透過 stdin 傳入）
5. 用拿到的 `session_id` 呼叫 `coder commit <id> --sessionId <sessionId>`（cwd 設成沙盒、`CODER_PROJECT_ROOT` 指回主專案）
6. 全部成功 → 狀態改 `IN_REVIEW`；任一步失敗 → `git reset --hard` + `git clean -fd`、切回 `baseBranch`、刪掉剛建立的任務分支、狀態退回 `TODO`，並中止整個 `run`（不會繼續跑下一筆任務），印出失敗原因

分支名稱用固定的 `coder/` 命名空間前綴，是為了避免 `baseBranch` 本身（例如 `main`）跟底下的任務分支在 git ref 路徑上衝突（`refs/heads/main` 和 `refs/heads/main/xxx` 不能同時存在）。

沒有 ticketId 的任務，分支名裡會用 `local` 代替。

### `coder review [id]`

```
coder review <id>
coder review -t <ticketId>
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
coder close -t <ticketId>
coder close              # 沒指定 → 用目前所在的 coder/ 任務分支反推是哪個任務
```

預期先用 `coder review` 把任務分支拉到主專案看過、覺得可以合併了，再用這個指令正式收尾（`coder close` 本身不會去 sandbox 拉分支，只認主專案裡已經存在的本地分支）：

1. 找出要關閉的任務：給了 `id` 或 `ticketId` 就用它查；都沒給的話，檢查目前所在的本地分支，如果是 `coder/<baseBranch>/task-<id>-<ticketId>` 這種任務分支，就從分支名稱反推出任務 id（並確認解析出的 baseBranch 跟資料庫紀錄一致，否則報錯）；如果目前分支不是任務分支，就報錯並提示改用 `<id>` 或 `-t`
2. 算出分支名稱、確認任務的 `baseBranch` 在主專案裡存在，以及該任務分支也已經存在於主專案（兩者缺一都直接報錯、不做任何變更；後者會提示先執行 `coder review`）
3. 切換到該分支，`git rebase <baseBranch>` 把它墊到最新的 `baseBranch` 上
4. 切換到 `baseBranch`，`git merge --ff-only` 合併進去（線性歷史，不會產生 merge commit）
5. 合併成功後：任務狀態改成 `DONE`（並寫入 `closedAt`），接著刪除該分支——主專案跟 sandbox 都刪
6. 如果 `.coder/hooks/post-task-close`（或 `.js`）存在，用任務 id 當參數執行它

如果 rebase 途中發生衝突，`coder close` 會自動 `git rebase --abort` 並切回你執行指令前所在的分支，任務狀態維持不變（不會變成 `DONE`，也不會變回其他狀態）；已經從 sandbox 拉下來的本地分支會保留著，方便你自行排解衝突後重新處理。

合併一旦成功（fast-forward 進 `baseBranch`），任務就會標記為 `DONE`；之後的分支清理、`post-task-close` hook 執行都是 best-effort——就算失敗也只會印出警告，不會讓指令回報失敗或把任務狀態改回去。

## Hooks

放在 `.coder/hooks/`，`coder init` 會附上範本（`*.sample`），需要自行重新命名/客製化。

| Hook | 何時觸發 | 必要性 | 介面 |
|---|---|---|---|
| `task-fetch` / `task-fetch.js` | `coder task fetch` | 必要（沒有就會失敗） | 無輸入；最後一行 stdout 必須是 JSON 陣列 `[{ticketId?, title, body?, baseBranch}]` |
| `format-commit-msg.js` | `coder commit`，Claude 產生訊息之後、實際 commit 之前 | 選用；存在但失敗會中止 commit | stdin = Claude 產生的原始訊息；stdout（trim 後）= 最終 commit message |
| `post-task-close` / `post-task-close.js` | `coder close`，任務合併進 `baseBranch` 並轉為 `DONE` 之後 | 選用；失敗只會印出警告，不影響 `coder close` 的結果 | argv：`<taskId>` |

`task-fetch` 在 Windows 上只支援 `.js`（無 shebang 支援）；其他平台可用無副檔名的可執行檔或 `.js`。

## 環境變數

| 變數 | 用途 |
|---|---|
| `CODER_PROJECT_ROOT` | 讓 `coder commit` 在「git 操作對 cwd、但控制平面在別的資料夾」的情境下運作，`coder run` 呼叫子行程 `coder commit` 時會自動設定 |

## 安全性備註

- 所有 git / `claude` 子行程呼叫都用 `execFileSync` + 陣列參數，不經過 shell，避免注入
- `coder run` 失敗時一定會嘗試把沙盒復原到乾淨狀態（reset + clean + 切回 base branch + 刪除任務分支），復原本身失敗也不會蓋掉原始錯誤訊息
- `coder commit` 只在暫存區有東西時才會動作，不會憑空 commit
