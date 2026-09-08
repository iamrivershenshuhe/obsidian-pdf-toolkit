# 開發紀錄與設計脈絡

這份文件整理 PDF Toolkit 從零到現在的討論過程：每一輪的需求、做了什麼決定、踩到哪些坑、為什麼最後長這樣。全部在 2026-09-08 一天內、由 River 與 Claude（Claude Code）協作完成。

## 0. 起點

需求原話：「幫我做一個 Obsidian 的小工具，它的功能是集成所有 Adobe PDF 的功能，只針對 PDF 檔案。」

「所有 Acrobat 功能」照字面做不到，第一版把範圍定在 Acrobat 最常用的檔案層級工具（合併、分割、擷取、旋轉、整理頁面、浮水印、頁碼、裁切、加密解密、屬性、表單、文字擷取、頁面轉圖、圖片轉 PDF 等 26 項），透過指令面板、檔案右鍵子選單、側欄圖示使用。

技術選型：
- **@cantoo/pdf-lib**：pdf-lib 的維護分支，唯一支援加密與解密的分支。
- **Obsidian 內建 pdf.js**（`loadPdfJs()`）：文字擷取與縮圖，不必另外打包 pdf.js。
- **上游 fontkit 2.x**：`@pdf-lib/fontkit` 在 Node 24 下對所有 Windows 字型子集化都失敗（`Cannot read properties of undefined (reading 'pos')`），上游版本正常；中文浮水印從 13 MB 縮到 8 KB。TTC 字型集另外寫了 `extractFromTtc` 拆出第一個字型。
- 介面雙語（繁中 / 英文），依 Obsidian 語言自動切換。

## 1. 「我要的是上面一排工具」

第一版做完後，River 說想像中是 Acrobat 那種檢視器上方一排工具、可以畫重點。於是重心轉向**檢視器內的標註工具列**：

- 工具列注入 PDF 視圖的 `contentEl` 最上方；文字標記（畫重點、底線、刪除線）用瀏覽器選取，繪圖工具（手繪、矩形、橢圓、便利貼、文字框、橡皮擦）用每頁一個透明覆蓋層接滑鼠事件。
- 座標轉換全靠 pdf.js 的 `viewport.convertToPdfPoint` / `convertToViewportPoint`，頁面旋轉與縮放都能對。
- 標註寫成**真正的 PDF 註解**並附外觀串流（appearance stream），所以 Acrobat、其他閱讀器、pdf.js 全都能顯示；用 pdf.js 驗證每個註解都帶 AP。

### 踩坑 1：版面壞掉

CSS 把「工具列以外的所有子元素」設成 `flex: 1`，但 Obsidian 的 `.view-content` 本身就是 flex column，內建的 `.pdf-toolbar` 和 `.pdf-container` 是並列的兄弟元素，結果內建工具列被撐高、內容被推到下半部。教訓：從 `obsidian.asar` 把內建 CSS 抓出來看，只給自己的工具列 `flex: none`，其餘不動。

### 踩坑 2：每畫一筆畫面就閃

每次寫檔，Obsidian 的 PDF 視圖收到 `modify` 事件就重載整份文件。從 `obsidian.asar` 找到呼叫鏈是 `onModify → this.onLoadFile(file)`，而 `onLoadFile` 是動態查找的，所以在自己寫檔的瞬間於視圖實例上遮蔽它就能擋掉重載。新加的標註改由「即時層」（SVG，存 PDF 座標、隨縮放重算）畫出來；只有刪除「開檔時就存在」的註解才需要真正重載。

### 踩坑 3：螢光筆不透明、兩台電腦看起來不一樣

即時層的螢光筆原本用 `mix-blend-mode: multiply`，但它放在一個有 `z-index` 的覆蓋層裡，混色只對同一堆疊層生效，於是變成不透明色塊蓋住字。而另一台電腦看到的是 pdf.js 從檔案渲染的結果（正確混色），兩台自然不同。修法：螢光筆獨立成 `.pdftk-blend` 圖層，混色套在圖層元素本身上，不受 pdf.js 內部堆疊順序影響；深色模式濾鏡也改套在整個 `.page` 上，讓即時層與檔案渲染走同一條路。

## 2. 深色模式

River 用深色主題，白色 PDF「像閃光彈」。第一版用 `invert(1) hue-rotate(180deg)`，但反轉後純白字壓純黑底，字緣毛邊很明顯。第二版改成**重新上色**：SVG `feComponentTransfer` 把黑墨水映到 `#c3c2b7`、白紙映到 `#1f1f1f`，灰階線性過渡，字緣自然。顏色可在設定改；柔和模式把字色往底色拉 18%。彩色圖片會變類反轉色，是逐通道映射的已知限制。

## 3. 讀論文功能

River 提到 Andrew Ng 的讀論文方法，希望有對應的輔助：

- **讀論文筆記**：每個 PDF 一個 `<檔名>.reading.md`，自動填摘要（規則抓 Abstract 到 Introduction 之間）、圖表索引（抓 Figure/Table 標題並附頁面連結，對應「先看圖」）、三遍讀法檢查清單、四個問題、摘錄區、待追參考文獻、一句話總結。
- **摘錄到筆記**：用 Obsidian 內建的 `getTextSelectionRangeStr` / `getMarkdownLink` 產生能跳回原文那句的連結；可設定畫重點時自動摘錄。
- **自訂模板**：後來 River 希望除了內建的還能自己定義。模板是 vault 裡的 Markdown 檔，用 `{{title}}` `{{abstract}}` `{{figures}}` `{{three_pass}}` `{{ng_questions}}` `{{highlights}}` 等變數，可匯出內建模板來改，預設模板可選「每次詢問」。
- **引用懸浮卡**：滑鼠移到內文 `[12]` 或 `(Smith et al., 2020)` 上，解析文末 References 區塊後顯示該篇條目，附 Google Scholar、DOI、arXiv、原始 URL 連結，可跳到條目頁或加到筆記的「待追參考文獻」。解析支援編號式與作者年份式，用純函式寫並有單元測試。

## 4. AI 問答

River 想在 PDF 旁直接問問題，不要切視窗；而且明確要走**本機 CLI harness**（Claude Code、Codex）而不是 API key。做法：右側面板，提示從 stdin 送進 `claude -p --output-format stream-json`（逐字串流）或 `codex exec -o <file>`（最後訊息寫檔），或任何自訂指令（如 `ollama run`）。脈絡可選選取文字 / 目前頁 / 整份文件，內建五個快捷提示，之後加上可在設定新增的自訂提示。Obsidian 不繼承 shell PATH，所以自動嘗試 Homebrew、nvm、npm 全域等常見路徑，並提供額外 PATH 設定。在 Windows 上 Claude 與 Codex 都實測成功。

## 5. 便利貼

問題回報：新增後點開會再冒一張、打不開、圖示醜。修法：便利貼工具點到既有便利貼（即時層或檔案裡的）改為打開編輯視窗（改內容 / 刪除）；圖示重畫成對話泡泡，PDF 外觀串流與畫面 SVG 用同一份路徑資料；pdf.js 在 Obsidian 裡載不到便利貼圖示資產會顯示破圖，改為隱藏並在需要時補上自己的圖示。

## 6. 工具鏈的小坑

- Bash 工具的包裝在 heredoc 內含單引號時會壞，改用 Write 工具寫檔再用 node 腳本拼接。
- 沒有 poppler 可以本機渲染 PDF 驗證，改用 pdf.js 解析確認註解結構，並用 Chromium 開啟輸出檔目視。

## 7. 還沒做 / 可以做

- OCR、數位簽章、編修（Redact）、Office 轉 PDF。
- 論文總覽表（Dataview 或指令產生）、名詞卡、閱讀計時、審稿模板。
- 深色模式保留彩色圖片原色。
- 引用解析對排版特殊的論文會失準，需要更多樣本調規則。

## 專案結構

```
src/
  main.ts            插件入口：設定、指令、工具列掛載、聊天面板、深色濾鏡
  i18n.ts            zh-TW / en 字串
  util.ts            頁面範圍解析、路徑、顏色等工具
  pdf/ops.ts         pdf-lib 檔案層級操作（合併、分割、浮水印、加密…）
  pdf/annotations.ts 標註寫入（Highlight/Ink/Square/Circle/Text/FreeText）、查詢、刪除
  pdf/pdfjs.ts       Obsidian 內建 pdf.js 包裝：文字擷取、渲染
  pdf/references.ts  參考文獻解析與引用偵測（純函式）
  ui/toolbar.ts      檢視器工具列、覆蓋層、即時層、寫檔與重載抑制
  ui/organize.ts     整理頁面縮圖視窗
  ui/modals.ts       通用表單、檔案挑選、資訊視窗
  ui/reading.ts      讀論文筆記、模板、摘錄
  ui/refpopover.ts   引用懸浮卡與文獻清單
  ui/chat.ts         AI 面板
  ui/darkmode.ts     重新上色濾鏡
  llm/runner.ts      本機 CLI 執行與串流
test/                Node 煙霧測試（pdf 操作、標註、參考文獻、CLI）
```
