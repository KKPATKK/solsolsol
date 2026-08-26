# Axiom Session Refresher — 雙觸發通道（GitHub schedule + cron-job.org dispatch）

> 背景（2026-08-26）：GitHub Actions 嘅 `schedule` 投遞係 best-effort 共享隊列，
> 平台事故時成條隊停擺（當日 00:02–01:52Z 零投遞 ~110 分鐘 → session 死透、
> Axiom 全端點回偽裝 502）。而 refresh 端點本身 418 所有非瀏覽器 TLS 指紋，
> Worker 自己刷新唔到，所以要有第二條**獨立於排程隊**嘅觸發通道。

## 架構

| 觸發源 | 頻率 | 成本 | 角色 |
|---|---|---|---|
| GitHub Actions `axiom-refresh.yml` cron | 每 10 分鐘 | 免費（public repo） | 主力 |
| cron-job.org → workflow dispatch API | 每 10 分鐘 | 免費、免信用卡 | 後備 |

**點解 dispatch API 靠得住：** 排程投遞同 dispatch API 係兩條完全獨立嘅路。
排程事故嗰陣，dispatch 照樣即時生效 — 等於每 10 分鐘由外面幫你撳一次
「Run workflow」。

**安全保證：** Axiom 每次 refresh 都輪換 refresh token，兩個來源同時刷新會
互相作廢。`scripts/axiom-refresh-action.py` 內建 Turso CAS 鎖
（`worker_state.axiom_refresh_lock`，TTL 300s）：任何時刻只有一邊可以真正
旋轉 token，另一邊搶唔到鎖就 exit 0。Worker 繼續被
`AXIOM_EXTERNAL_REFRESH=1` 擋住（單一寫入者規則不變）。

---

## cron-job.org 設置（一次性 ~5 分鐘）

### ① 整一粒細權限 PAT

github.com → Settings → Developer settings，二選一：

**Fine-grained token（推薦）：**
- Repository access → Only select repositories → 揀 `KKPATKK/solsolsol`
- Permissions → Repository permissions → **Workflows → Read and write**
- （改權限後要 Regenerate，新字串即刻抄低）

**Classic token（更簡單）：**
- 只需要勾 ☑ **`workflow`** 一個 scope（public repo 讀取唔使 `repo`）

### ② cron-job.org 開 job

cron-job.org 註冊/登入 → **Create cronjob**：

| 欄位 | 值 |
|---|---|
| URL | `https://api.github.com/repos/KKPATKK/solsolsol/actions/workflows/axiom-refresh.yml/dispatches` |
| Method | **POST**（揀咗 POST 先會見到 Body 欄） |
| Headers | `Authorization: Bearer <你的PAT>` |
| Headers | `Accept: application/vnd.github+json` |
| Body | `{"ref":"main"}` |
| Schedule | Every 10 minutes |

### ③ 驗證

撳 **Run now**（或者等第一個 slot），打開個 job 嘅 **History tab** 對 status：

| Status | 意思 | 處理 |
|---|---|---|
| **204** | ✅ 成功，GitHub 收貨 | Actions 會即刻出現一個 `workflow_dispatch` run |
| 404 | Method 仲係 GET | 揀返 POST |
| 401 | PAT 錯／過期／Bearer 後面冇空格 | 重抄 |
| 403 "not accessible by personal access token" | 缺 `actions=write`（fine-grained 冇開 Workflows: RW；classic 冇勾 workflow scope） | 返①補權限再 regenerate |

---

## 運作檢查

| 檢查 | 呢度睇 | 預期 |
|---|---|---|
| GitHub 主力通道 | Actions → "Axiom session refresher"，event=`schedule` | 每 10 分鐘一次（投遞延遲屬正常） |
| cron-job.org 後備通道 | 同上，event=`workflow_dispatch` | 每 10 分鐘一次 |
| Session 健康 | Worker `/debug/axiom-trending` | `ok: true` + tokens 數 > 0 |
| 鎖狀態 | Turso `worker_state.axiom_refresh_lock` | 平時多數 `'0'`（已釋放） |

## 已知限制

- Axiom 自身後端故障（例如 2026-08-26 全分片 HTTP 500）兩條通道都冇符，
  只能等復原；復原後下一個 slot 自動接返。
- fine-grained PAT 有到期日，到期前記得續（cron-job.org History 會突然
  全部 401 就係呢個症狀）。
- GitHub 免費額度：public repo 嘅 Actions 無限分鐘，呢個用量完全免費。
