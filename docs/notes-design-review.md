# 筆記流程檢視與改善方向

檢視範圍：`src/ui/reading.ts`、`src/ui/chat.ts`、`src/ui/toolbar.ts`。以下區分這次已完成與後續建議。

## 這次已完成

- 反白文字後，可直接「加入筆記…」，搜尋 vault 中的 Markdown 筆記並選定目的地。
- 追加到既有筆記末尾，保留原內容，附上相對於目的筆記的 PDF 頁碼連結；能取得選取範圍時一起保留。
- 這個流程不會建立預設讀論文筆記，也不會移動 PDF。
- 對話紀錄另存為可恢復的 JSON 與可閱讀的 Markdown，不再只能靠「加到讀論文筆記」保留回答。

## 原本設計的問題

| 現況與程式位置 | 使用時的問題 | 建議 |
| --- | --- | --- |
| `ensureReadingNote` 可能呼叫 `ensurePaperFolder` | 建立筆記同時改動 PDF 的資料夾位置，使用者很難預期 | 將整理資料夾改成明確的獨立動作；建立筆記只建立筆記 |
| `readingNotePath` 以 PDF basename 命名；共用 readingFolder 時 `getReadingNote` 直接重用同名檔 | 不同資料夾的同名 PDF 可能連到同一篇筆記 | 建立 PDF→筆記對應表，以 vault 路徑或穩定 ID 區分；筆記 frontmatter 保留 `source` |
| `appendQuote` 與 `appendAiAnswer` 都寫入 highlights 標記區 | 原文、自己的想法與 AI 回答混在一起，難以回顧 | 分成「原文摘錄」「我的理解」「AI 討論」「待解問題」，附來源與時間 |
| `appendReference` 靠目前語言的標題找段落 | 改語言或改標題後可能新增另一個參考文獻區 | 所有自動寫入區都使用穩定標記，不依賴可見標題文字 |
| `ensureReadingNote` 沒有共享建立中的工作 | 同時摘錄、加 AI 回答時可能競爭建立同一檔案 | 每個 PDF 共用一個建立 Promise，完成後再序列追加 |
| 預設模板一次加入摘要、圖表、三遍讀法、四問、參考文獻等內容 | 輕量阅读也產生很長的空白結構 | 提供「簡短筆記」「完整論文閱讀」「方法比較」三種模板，建立前可預覽 |
| `appendAiAnswer` 以當次問題作標題，沒有完整來源清單 | 多篇論文一起問時，匯出回答看不出參考了哪些來源 | 匯出時一併加入來源檔案、頁碼、模型與日期；讓使用者選目的筆記 |

## 建議的下一步流程

建立筆記時使用一個清楚的視窗：先選「建立新筆記／加入既有筆記」，再填名稱與資料夾、選模板並預覽。建立後記住這份 PDF 常用的筆記，下次預選但仍可更換。

建議先做來源對應表、建立流程與內容分區，再做模板美化。前面三項直接影響資料是否放對地方，也能減少之後搬動或整理筆記的成本。

目前對話 Markdown 是自動產生的閱讀副本，後續保存會更新它。要把內容整理成自己的筆記，應複製／摘錄到另一篇 Markdown 筆記，而不是直接編輯這份副本。


## Implemented in this revision

- Creating a reading note leaves the PDF in its current folder; organization remains a separate action.
- Shared-folder note names include a source-path hash to separate identically named PDFs. Existing source-linked notes are recognized.
- Concurrent requests for one PDF share a single note creation.
- AI exports use a dedicated section with source and timestamp; excerpts retain their own section. Reference insertion uses a stable marker.
- Template previews and expanded template presets remain future improvements.
