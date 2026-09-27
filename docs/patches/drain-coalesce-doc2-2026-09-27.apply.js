// Verify-then-write: §4.41's post-deploy findings (found within minutes of the
// 11:11Z deploy, both fixed and redeployed the same day).
const fs = require("fs");

const FILE = "docs/round-trips.md";
let src = fs.readFileSync(FILE, "utf8");
let patched = 0;

function patch(label, from, to) {
  if (src.includes(to)) {
    console.log(`= ${label}: already applied`);
    return true;
  }
  if (!src.includes(from)) {
    console.log(`✗ ${label}: anchor NOT found`);
    process.exitCode = 1;
    return false;
  }
  src = src.replace(from, to);
  patched += 1;
  console.log(`✓ ${label}: patched`);
  return true;
}

const ANCHOR = `3. 下次有失敗：durable row 多咗 \`owedTokens\`（backlog 嗰個數），而條 row 一過 10 分鐘就會
   由**任何** isolate 嘅 \`/health\` 清走（唔會再見到 2 日前嘅 row）。`;

const ADDITION = `

### 落線後即刻抓到嘅兩個缺陷（11:11Z deploy 後幾分鐘，同日修好）

1. **drain 冇 receiver**。Refactor 之後 \`runBucket\` 係用 \`bucket.call(payload)\` 直接叫個
   method，冇 \`this\`；真實 Db method 內部用 \`this.get\`，所以每一次落地都係
   \`TypeError: this.get is not a function\`、**0ms** 失敗（live 11:16–11:26Z：\`totals.failures\`
   1→3），3 次之後成個 bucket 被 drop —— 11:26Z 一 drop 就冇咗 **313 條註冊**。
   舊 code 用 \`run: () => call.apply(target, args)\` 包住 receiver，refactor 漏咗；
   離線 fake 全部冇 \`this\`，所以測試睇唔到。修法：wrap 時 \`.bind(target)\`，
   兩個 suite 嘅 fake 改成 \`this\`-based（unit 加 \`this.calls\`、seam 加
   \`assert.equal(this, seamDb)\`），mutation：拎走 \`.bind\` ⇒ coalescing 測試 fail。
2. **attempts 唔識 reset**。Bucket 嘅失敗計數係終身累計，但 drop 規則嘅原意係「**連續** 3 次」
   （舊 code 每個 entry 各自數）。即係一個失敗兩次後好返嘅 bucket，會俾之後**一次**新失敗
   即時 drop 晒（313 條咁嘅規模）。修法：落地成功就 \`bucket.attempts = 0\`，並加咗測試
   （fail ×2 → land → fail ×1 ⇒ 仍然 owed）。

驗收更新：deploy 之後 \`totals.failures\` 唔應該再升、\`owedTokens\` 應該開始跌（每次落地
最多 40 條／method）。`;

patch("§4.41 amendment", ANCHOR, ANCHOR + ADDITION);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE}`);
}
