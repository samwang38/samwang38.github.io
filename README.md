# 我的班表 → 行事曆

單人使用的靜態網頁工具：選取班表圖片或從 iPhone 分享捷徑匯入，透過 Gemini 辨識自己的班次，核對後以差異同步更新 Google 日曆，或下載 ICS。

正式網站：https://samwang38.github.io/

## 使用

1. 首次在「個人設定」填入姓名、Gemini API 金鑰及模型，儲存設定。
2. 選取原始班表，或從 iPhone「照片 → 分享 → 班表轉行事曆」開啟，點「匯入捷徑班表」並允許貼上。
3. 確認預期年月，辨識後核對圖片上的年月與每日班別。
4. 確認差異後同步到 Google 日曆。

捷徑安裝與操作細節：[使用說明](shortcuts/使用說明.html)。Safari 與主畫面網頁 App 可能各自保存設定，建議固定同一個入口。

## 模型（2026-10-30 查核）

- 預設 `gemini-3.8-flash`：圖片輸入、結構化 JSON 輸出；使用 `thinkingLevel: low`。
- 可選 `gemini-3.6-flash` 或 `gemini-4-argon`。Argon 使用 32768 output token 上限，其他模型使用 8192。
- 已移除新版 API 列為淘汰的 `temperature` 參數。每次只請求選定的模型，不自動切換或額外請求其他模型。
- 模型是否可用取決於使用者專案權限及額度。更新模型無法修復預付餘額耗盡。
- 官方文件：[3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)、[4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon)、[費率](https://ai.google.dev/gemini-api/docs/pricing)。

## 資料與分享設計

- 金鑰與個人設定保留在瀏覽器 localStorage，不寫入程式碼、捷徑或 Git。
- 最新班表圖片與草稿保存在此瀏覽器的 IndexedDB；文字摘要使用 localStorage。圖片寫入失敗或網站資料被清除時，需重新選圖。
- 捷徑只接受分享圖片，取第一張、轉成 JPEG、加上 `ELIS_SCHEDULE_IMAGE_V1:` 標記後放進本機剪貼簿，再開啟 `/#shortcut`。
- 網頁只有在使用者點選匯入時讀取剪貼簿；無權限時提供手動貼上。圖片不嵌入網址，不在頁面開啟時自動傳送。按下辨識後才傳給 Gemini。
- 保留原有同步預覽、員工及工具事件標記、Google OAuth 與 ICS 匯出。

## 本機驗證

```sh
node --test tests/extraction.test.cjs
python3 -m http.server 8765 --bind 127.0.0.1
```

測試使用人工建立的班表與 API 回應，不呼叫 Google，也不操作真實行事曆。

## 重建分享捷徑

```sh
python3 scripts/build-shortcut.py
cp shortcuts/班表轉行事曆-unsigned.plist /tmp/elis-share-unsigned.shortcut
shortcuts sign --mode anyone --input /tmp/elis-share-unsigned.shortcut --output shortcuts/班表轉行事曆.shortcut
```

簽章需在可使用 Apple 簽章服務的 Mac 執行。Apple 會收到不含金鑰或班表圖片的捷徑檔進行驗證。

## 驗證界線

單元測試、瀏覽器圖片讀取與草稿流程、Mac 捷徑匯入已驗證；仍須以實際 iPhone 分享原圖，並在 Gemini 專案有可用額度時驗證真實辨識準確度。原生日曆寫入需由使用者確認差異。
