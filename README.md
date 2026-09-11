# PDF Toolkit for Obsidian

在 Obsidian 裡直接處理 vault 內的 PDF，功能對應 Adobe Acrobat 常用工具。只作用於 `.pdf` 檔案，桌面版限定。

## 標註工具列（Acrobat 風格）

開啟任何 PDF，檢視器上方會出現一排工具，標註直接寫進 PDF 檔（其他閱讀器也看得到）：

| 工具 | 用法 |
|---|---|
| 畫重點 / 底線 / 刪除線 | 先點工具，再用滑鼠選取文字，放開即套用 |
| 手繪筆 | 在頁面上拖曳 |
| 矩形 / 橢圓 | 在頁面上拖曳出範圍 |
| 便利貼 | 點一下頁面，輸入內容（滑鼠移過去會顯示） |
| 文字框 | 拖曳出範圍（或點一下用預設大小），輸入文字；中文需在設定指定字型 |
| 橡皮擦 | 點一下標註即刪除 |
| 復原 | 移除最後一個加入的標註 |
| 顏色 / 線寬 | 色票與下拉選單；畫重點與繪圖各記住一組顏色 |
| 旋轉頁 / 整理頁面 / 清除本頁標註 / 更多工具 | 右側按鈕 |

按 `Esc` 回到選取模式。工具列可在設定關閉。

### 深色模式

工具列的 🌙 按鈕（或指令「PDF 頁面深色模式」）切換：關閉 / 深色（自訂底色與字色，預設底 `#1f1f1f`、字 `#c3c2b7`）/ 柔和深色（同色系、對比更低）/ 只調暗。深色是「重新上色」而非反轉：黑墨水映到字色、白紙映到底色、灰階平滑過渡，所以字緣不會有毛邊。用 SVG 濾鏡作用在渲染後的頁面上，不改動檔案。彩色圖片會變成類反轉色。

### 問 AI（本機 CLI，不用 API key）

左側 Ribbon 的對話圖示、PDF 工具列帶「AI」文字的按鈕，或指令「問 AI 這份 PDF」都可開啟右側面板。脈絡可選「選取的文字 / 目前頁面 / 整份文件」，內建解釋、翻譯、摘要、關鍵名詞與 Andrew Ng 四問。回答可一鍵加到讀論文筆記。

使用 PDF 工具列的「選取」模式反白文字，放開滑鼠後會出現「將此段加入 AI 對話」。可連續加入多段（也可來自不同 PDF），每段以附件卡保留檔名、起始頁碼和可展開的文字預覽，按各卡片的「×」只移除該段。相同來源、頁碼與文字不會重複加入。

附件在後續提問會持續帶入，切換頁面／整份文件脈絡也會一併附上；「新對話」會清除附件。移除附件會停止在後續提問重送該段，既有問答仍保留。總字數超過設定上限時會分配每個來源的文字額度，保留所有來源標籤，並在該次提問的來源區標示截短。

AI 側欄提供固定底部輸入區、可收合的閱讀快捷指令、逐段附件管理，以及每次提問可展開的「這次提問附上的來源」。Enter 送出、Shift+Enter 換行；生成期間可按停止。

反白後也可按「加入筆記…」，搜尋並選擇 vault 中的任何 Markdown 筆記。內容以 quote callout 追加到該筆記末尾，附 PDF 頁碼回連；此操作不會移動 PDF。

側欄上方依序提供供應商、模型、effort 三個選單。供應商可在設定顯示／隱藏；切換時記住各供應商上次使用的模型與 effort。Codex 讀取本機 `models_cache.json`；Claude 提供 Fable／Opus／Sonnet／Haiku 別名。可在「增補模型選項」逐行填入 `model-id | 名稱 | low,medium,high`，或在模型選單直接輸入其他 ID。未知能力與 CLI 預設模型只提供預設 effort，避免送出未確認的參數。實際模型權限依帳號、CLI 版本而定；此選單不是帳號可用性驗證。

CLI 參數依 [Codex 設定說明](https://learn.chatgpt.com/docs/config-file/config-reference) 與 [Claude Code 模型說明](https://code.claude.com/docs/en/model-config) 接入。自訂指令可使用 `{model}` 和 `{effort}` 變數。

#### 對話保存

訊息、附件、各次提問來源與輸入草稿會自動保存。預設位置是 PDF 旁的 `<PDF 檔名>.ai/`，每個對話有 `.chat.json`（恢復資料）和 `.md`（可讀副本）；尚未選定 PDF 時使用 `PDF Toolkit/Conversations/`。可在設定指定統一的 vault 內資料夾，既有對話保留原位置。此流程不會自動搬動 PDF。

重新開啟 AI 面板會恢復上次對話；上方「歷史對話」按鈕可搜尋並切換其他對話。「新對話」會保留舊紀錄。生成中約每兩秒保存一次部分回覆，完成、停止或關閉時再保存；意外中斷後可恢復最近已寫入的內容。JSON 是恢復來源，Markdown 是自動更新的副本，建議把要自行編輯的內容摘到另一篇筆記。

完整紀錄都保存在檔案中。重開後不重用舊 CLI session，後續提問沿用現有的最近八則訊息與目前附件作為脈絡，避免把整份歷史無限制送入模型。索引位於插件目錄的 `conversation-index.json`。

提供者（設定裡選）：
- **Claude Code CLI**：執行 `claude -p`（串流輸出），用你已登入的帳號。
- **OpenAI Codex CLI**：執行 `codex exec`。
- **自訂指令**：任何從 stdin 讀提示、stdout 印回答的指令，例如 `ollama run llama3`。

Obsidian 不會繼承 shell 的 PATH；找不到指令時，在設定填執行檔完整路徑，或把資料夾加到「額外 PATH 資料夾」（常見的 Homebrew、nvm、npm 全域路徑會自動嘗試）。

- Claude Code 在同一次開啟期間可沿用 session（`--resume`）；變更模型、effort 或附件時重置。每次提問仍附上目前選定的脈絡。
- 輸入以 `/` 開頭會列出你的 Claude Code 指令與 skills（`~/.claude/commands`、`~/.claude/skills`、vault 的 `.claude/`）或 Codex prompts，選了會以斜線指令送出。
- 串流時只更新純文字，結束後才渲染 Markdown；送出鈕在執行中變成停止鈕。

### 讀論文

- 📖 **開啟讀論文筆記**：在 PDF 旁建立 `<檔名>.reading.md`（或指定資料夾），內含自動抓的摘要、圖表索引（每個 Figure/Table 標題附頁面連結）、三遍讀法檢查清單、Andrew Ng 的四個問題、摘錄區、待追參考文獻、一句話總結，並在右側分割視窗打開。
- 💬 **摘錄選取文字到筆記**：選一段文字後按按鈕（可加評註），會以 quote callout 加到筆記的「摘錄與重點」區，連結可跳回 PDF 該段文字。
- 設定「畫重點時同時摘錄到筆記」：用螢光筆畫的每一段自動進筆記，附顏色標記。

#### 引用懸浮卡

滑鼠移到內文的 `[12]`、`[3, 5–7]` 或 `(Smith et al., 2020)` 上，會解析文末的 References 並顯示該篇條目，附 Google Scholar、DOI、arXiv、原始 URL 連結，可「跳到該條目」或「加到待追參考文獻」。工具列 📚 按鈕可關閉懸浮、或列出全部參考文獻。解析靠文字規則，排版特殊的論文可能抓不到。

懸浮卡支援 PDF 超連結標註覆蓋在文字上方的情況；不要求 PDF 本身有超連結，只要文字與參考文獻可解析即可。掃描影像、部分上標引用或特殊書目排版仍可能無法辨識。

游標停留約 650 毫秒後，第一篇尚未處理過的引用會查找公開 abstract，再用目前 AI 提供者整理研究問題、方法、結果／貢獻。多篇引用的其他條目可各自按「產生摘要」。離開懸浮卡不取消生成，同一篇生成中再次懸浮會等待同一份工作，不會重複呼叫。

結果與 abstract 原文永久保存在插件目錄的 `reference-summaries.json`，重新開啟 Obsidian 也能讀取。只有「重新生成」會再次呼叫 AI；失敗、未找到摘要或中途關閉插件也不會在下次懸浮時自動重試。卡片可展開「查看摘要原文」，確認 AI 實際讀取的內容。首次速度取決於公開服務及 CLI／模型，並非即時完成。

摘要資料透過 [Crossref API](https://github.com/Crossref/rest-api-doc) 的 DOI／書目查詢，以及 [arXiv API](https://info.arxiv.org/help/api/user-manual.html) 取得。只傳送書目資訊給這些服務，公開摘要則交由已設定的 AI 提供者處理。標題查詢必須匹配書目中的標題，卡片會附摘要來源連結；沒有可確認的公開摘要時會顯示提示，不會僅憑標題產生研究結果。設定可關閉自動摘要，或另填同一提供者支援的較快模型。

#### 參考文獻側欄與「問 AI」

工具列 📚 → 「開啟參考文獻側欄」（或指令）：左側欄列出這份 PDF 的全部參考文獻，可搜尋（作者、年份、標題、編號），每條有 Scholar / DOI / arXiv 連結、跳到條目、加到筆記、**問 AI**。「問 AI」會把該條目丟進 AI 面板，脈絡切成「選定的參考文獻」，用設定裡可改的問題（預設：這篇在講什麼、和目前這篇有何關係）。自訂提示也可以選「選定的參考文獻」脈絡。

#### 每篇論文一個資料夾

預設開啟：第一次為某個 PDF 建立筆記（讀論文筆記、摘錄、AI 回答、加參考文獻）時，會在 PDF 旁建立以檔名命名的資料夾並把 PDF 移進去，連結由 Obsidian 自動更新，筆記也放在該資料夾。也可用指令「把這份 PDF 移到它自己的資料夾」手動整理。設定裡可關閉。

#### 自訂筆記模板

1. 設定 → 「讀論文筆記模板資料夾」填一個資料夾（例如 `Templates`）。
2. 執行指令「匯出內建讀論文筆記模板」（或設定裡的下載圖示），會把內建模板寫成 Markdown 檔，直接修改或複製成多個模板。
3. 設定「預設模板」選內建、某個模板檔，或「每次詢問」；指令「從模板建立讀論文筆記…」永遠會詢問。

模板可用變數：`{{title}}` `{{authors}}` `{{keywords}}` `{{subject}}` `{{pages}}` `{{source}}` `{{file}}` `{{path}}` `{{date}}` `{{abstract}}` `{{figures}}` `{{highlights}}` `{{three_pass}}` `{{ng_questions}}`。請保留 `{{highlights}}`，摘錄與 AI 回答才知道要插在哪裡。

#### 自訂 AI 提示

設定 → 「自訂 AI 提示」→ 新增：按鈕名稱、脈絡（選取 / 頁面 / 整份）、提示內容。會出現在 AI 面板的按鈕列，內建的五個可以隱藏。
也可直接在側欄的 Reading Shortcuts 按「新增提示」。卡片顯示名稱與最多三行說明，滑鼠停留或鍵盤聚焦時顯示完整 prompt；自訂卡片的鉛筆按鈕可修改。展開區有高度限制和捲動，不會把整個對話區擠掉。

筆記流程的檢視與後續建議見 [筆記設計檢視](docs/notes-design-review.md)。

## 其他 PDF 工具

| 類別 | 工具 |
|---|---|
| 頁面結構 | 整理頁面（縮圖拖曳排序 / 旋轉 / 刪除 / 擷取）、合併、分割、擷取頁面、刪除頁面、旋轉、重新排列、反轉順序、插入空白頁、複製頁面 |
| 文字標記 | 浮水印（可平鋪）、頁首 / 頁尾 / 頁碼（支援 `{page}` `{total}` `{title}` `{date}` `{file}`） |
| 幾何 | 裁切邊界、調整頁面尺寸（A4 / Letter / 自訂）、多頁合一（2-up / 4-up） |
| 安全 | AES-256 密碼保護 + 權限設定、移除密碼 |
| 屬性 | 編輯文件屬性（標題 / 作者 / 主旨 / 關鍵字）、文件資訊（可複製成 Markdown） |
| 內容 | 擷取文字成 Markdown 筆記、頁面匯出 PNG、圖片（PNG/JPG）轉 PDF、附加檔案 |
| 表單 | 填寫表單欄位、平面化表單 |
| 其他 | 最佳化 / 重新儲存（物件串流壓縮） |

## 使用方式

1. **指令面板**：開啟一個 PDF 後，`Ctrl/Cmd+P` 搜尋「PDF Toolkit」或任一工具名稱。
2. **右鍵選單**：在檔案總管對 `.pdf` 按右鍵 → 「PDF 工具箱…」子選單。
3. **多選合併**：在檔案總管多選數個 PDF 按右鍵 → 「合併 PDF」。
4. **側邊欄圖示**：點擊後列出所有工具（可在設定關閉）。

加密的 PDF 會先跳出密碼視窗，輸入後所有工具都能正常使用。

## 設定

- **輸出方式**：預設「另存新檔」，檔名加後綴（例如 `report-rotated.pdf`）；也可改為直接覆寫原檔。
- **輸出資料夾**：留空則存在原 PDF 旁邊。
- **文字用字型檔**：浮水印 / 頁首頁尾要用中文（或任何非西歐文字）時必填。支援 `.ttf` / `.otf` / `.ttc`，例如 `C:\Windows\Fonts\msjh.ttc`（微軟正黑體）。內建 Helvetica 只能顯示西歐字元。
- **縮圖寬度**：「整理頁面」用。
- **語言**：自動 / English / 繁體中文。

## 安裝

把 `manifest.json`、`main.js`、`styles.css` 放到 `<vault>/.obsidian/plugins/pdf-toolkit/`，然後在 Obsidian 設定 → 第三方插件 → 啟用「PDF Toolkit」。

## 開發

```bash
npm install
npm run dev     # 監看模式
npm run build   # 型別檢查 + 壓縮輸出 main.js
npm run test:ai # 多段上下文、對話競態、引用摘要與卡片互動測試（模擬 DOM／CLI／網路）
```

技術：[@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib)（pdf-lib 的維護分支，支援加密）、`@pdf-lib/fontkit`，文字擷取與縮圖使用 Obsidian 內建的 pdf.js。

## 未包含（純 JS 難以做到）

- OCR（掃描檔辨識）
- 數位簽章 / 憑證
- 編修（Redact）、Office 轉 PDF、PDF/A 轉換、進階影像壓縮


### Annotation recovery and reading controls

PDF toolbar edits now support undo and redo, including annotation deletion, clearing the current page, note edits and rotation. Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z or Ctrl+Y redoes, and Escape cancels a drawing. Click inside the PDF first; typing fields keep their normal shortcuts. Use the eraser to remove an annotation or the trash action to clear a page, then undo if needed.

History is session-only and belongs to the PDF, so switching papers or reopening a PDF tab retains its history until the plugin reloads. Up to 20 compressed edit snapshots are retained per PDF, fewer for large documents (a single large edit is retained). External file changes invalidate conflicting history. PDF undo does not undo exported Markdown notes or edits made through other applications.

Settings include an annotation palette, optional single-key tools, a switch for built-in undo keys, and reuse of the reading-note pane. All annotation tools and undo/redo/clear are registered under Obsidian Hotkeys for custom bindings. Single-key defaults: V select, U highlight, Shift+U cycle markup, D draw, Shift+D cycle shapes, S sticky note, X text, E eraser.

With companion-pane reuse enabled, different papers open their reading notes in the same pane and keep focus on the PDF. AI continues to use its existing sidebar.
