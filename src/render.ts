import { fmtAge, fmtUsd } from "./format";
import type { ArkhamTokenHolders } from "./arkham";
import type { AxiomTokenInfo } from "./axiom";
import type { CrimeCheckResult } from "./crimewallets";
import type { GmgnTokenInfo } from "./gmgn";
import type { QualifyingCoin } from "./scanner";
import type { WalletAnalysisResult } from "./walletanalysis";
import type { FlurryReport } from "./flurry";

/** Chinese label for the Flurry risk tier (card line). */
function flurryTierLabel(tier: FlurryReport["tier"]): string {
  switch (tier) {
    case "CRITICAL":
      return "極高風險";
    case "HIGH":
      return "高風險";
    case "MODERATE":
      return "中風險";
    default:
      return "低風險";
  }
}

/**
 * Axiom /token-info summary line — one compact pipe-separated strip that
 * replaces the five legacy enrichment lines (Bundler/Top10/供應流/Sniper/
 * Holders) when the payload resolves. Format (operator spec):
 *   Top 10 22% | 持有人 356 | Pro 238 | Dev 0% | 內部 22.1% | 捆綁 0.1% |
 *   狙擊 0% | 已付Dex | Creator 已收 184 SOL
 * 內部 ≥15% / 捆綁 ≥13% / 狙擊 ≥5% get a 🔴 flag; missing identity fields
 * hide the whole line (null) and the caller falls back to legacy lines.
 */
export function renderAxiomSummaryLine(
  axiom: AxiomTokenInfo | null,
): string | null {
  if (!axiom) return null;
  if (
    axiom.numBotUsers === null ||
    axiom.numHolders === null ||
    axiom.top10HoldersPercent === null
  ) {
    return null; // 缺數據整行隱藏 — partial payloads mean schema drift
  }
  // One decimal, trailing .0 trimmed: 22 → "22%", 22.1 → "22.1%", 0 → "0%".
  const pct = (v: number): string => `${Math.round(v * 10) / 10}%`;
  const flag = (v: number, min: number): string => (v >= min ? "🔴" : "");
  const segs = [
    `Top 10 ${pct(axiom.top10HoldersPercent)}`,
    `持有人 ${Math.round(axiom.numHolders).toLocaleString("en-US")}`,
    `Pro ${Math.round(axiom.numBotUsers)}`,
    ...(axiom.devHoldsPercent !== null
      ? [`Dev ${pct(axiom.devHoldsPercent)}`]
      : []),
    ...(axiom.insidersHoldPercent !== null
      ? [`${flag(axiom.insidersHoldPercent, 15)}內部 ${pct(axiom.insidersHoldPercent)}`]
      : []),
    ...(axiom.bundlersHoldPercent !== null
      ? [`${flag(axiom.bundlersHoldPercent, 13)}捆綁 ${pct(axiom.bundlersHoldPercent)}`]
      : []),
    ...(axiom.snipersHoldPercent !== null
      ? [`${flag(axiom.snipersHoldPercent, 5)}狙擊 ${pct(axiom.snipersHoldPercent)}`]
      : []),
    ...(axiom.dexPaid !== null ? [axiom.dexPaid ? "已付Dex" : "未付Dex"] : []),
    ...(axiom.creatorFeesSol !== null
      ? [`Creator 已收 ${Math.round(axiom.creatorFeesSol * 10) / 10} SOL`]
      : []),
  ];
  return segs.join(" | ");
}

/**
 * Renders the Telegram push card for a qualifying coin. Pure (no I/O), so
 * the growing enrichment line list — Bundler / Top10 / supply flow / sniper
 * / holders / creator / GMGN / Arkham / crime-wallets — stays trivially
 * testable without instantiating a scanner. Extracted from scanner.ts when
 * the crime-wallet line joined the card.
 */
export function renderMessage(
  coin: QualifyingCoin,
  bundlerPct: number | null,
  top10Pct: number | null,
  sniperPct: number | null,
  supplyFlowClean: boolean,
  holderCount: number | null,
  creator: string | null,
  gmgn: GmgnTokenInfo | null,
  arkham: ArkhamTokenHolders | null,
  crime: CrimeCheckResult,
  wallet: WalletAnalysisResult | null,
  /** Jupiter organic score snapshot (null = unavailable). */
  organic: {
    score: number | null;
    label: string | null;
    tradersH1: number | null;
  } | null,
  /** Axiom /token-info payload (null = fetch failed → legacy lines). */
  axiom: AxiomTokenInfo | null,
  /**
   * Flurry launch forensics: null = feature disabled → line hidden;
   * { report: null } = configured but nothing to report (non-pump mint /
   * fail-open skip) → “未分析”; report = the deploy-slot verdict.
   */
  flurry: { report: FlurryReport | null } | null,
): string {
  const { pair, profile } = coin;
  const name = pair.baseToken.name || profile.name || "Unknown";
  const symbol = pair.baseToken.symbol || profile.symbol || "?";
  const tokenAddress = pair.baseToken.address;
  const price = Number(pair.priceUsd);
  const liquidityUsd = pair.liquidity.usd ?? 0;
  const now = Date.now();
  const ageMs = now - pair.pairCreatedAt;

  const bundlerLine =
    bundlerPct === null
      ? "🛡 Bundler: 0.0%（未检测到捆绑网络）"
      : `🛡 Bundler: ${bundlerPct.toFixed(1)}%`;
  const top10Line =
    top10Pct === null
      ? "👥 Top10 持仓: —（未检测）"
      : `👥 Top10 持仓: ${top10Pct.toFixed(1)}% (剔除LP)`;
  const flowLine = supplyFlowClean
    ? "🕸 供應流: ✅ 无集中出货（链上检查通过）"
    : "🕸 供應流: —（未分析）";
  const sniperLine =
    sniperPct === null
      ? "🎯 Sniper 買入: —（未檢測）"
      : `🎯 Sniper 買入: ${sniperPct.toFixed(1)}%（佔供應）`;
  const holdersLine =
    holderCount === null
      ? "👥 Holders: —（未检测）"
      : `👥 Holders: ${holderCount.toLocaleString("en-US")}`;
  const creatorShort =
    creator === null ? "—（未检测）" : `${creator.slice(0, 6)}…${creator.slice(-4)}`;
  // Creator wallet depth (feature A): age from the oldest signature plus a
  // serial-launcher warning when the creator recently launched many tokens.
  let creatorLine = `✍️ Creator: ${creatorShort}`;
  const cw = wallet?.creator;
  if (creator !== null && cw?.profile?.firstTxMs !== null && cw?.profile?.firstTxMs !== undefined) {
    const ageLabel = cw.profile.capped ? "≥" : "";
    const serial = cw.serialLauncher ? ` ⚠️ 連發${cw.createCount}` : "";
    creatorLine += ` | 🕐 ${ageLabel}${fmtAge(now - cw.profile.firstTxMs)}${serial}`;
  }
  // GMGN/Arkham lines are omitted entirely when the source is not
  // configured (or failed) — a "—（未配置）" placeholder is just noise on
  // every card. Same stance as the crime line below.
  const gmgnLine =
    gmgn === null
      ? null
      : `🧠 GMGN: 👤${gmgn.holderCount ?? "—"} 持倉 | 💰${gmgn.smartWallets ?? "—"} smart${gmgn.isWashTrading ? " | ⚠️ wash trading" : ""}`;
  const arkhamLine =
    arkham === null
      ? null
      : arkham.smartMoney.length === 0
        ? "🕵️ Arkham: 0 smart（Top100 无标注机构/鲸鱼）"
        : (() => {
            const names = arkham.smartMoney
              .slice(0, 2)
              .map((h) => h.entityName ?? h.address.slice(0, 6))
              .join("、");
            return `🕵️ Arkham: 💰${arkham.smartMoney.length} smart | ${names}`;
          })();
  // Crime-wallet line: hidden until the blocklist has actually loaded (a
  // disabled client, or the first minutes after a deploy before the first
  // fetch lands) — nothing is better than a misleading "无命中".
  const crimeLine = crime.loaded
    ? crime.hit
      ? `🚨 CrimeWallets: ⚠️ 命中 ${[
          ...(crime.creatorHit ? ["Creator"] : []),
          ...(crime.holderHits.length > 0
            ? [`${crime.holderHits.length} 持有者`]
            : []),
        ].join(" + ")}`
      : "🚨 CrimeWallets: ✅ 无命中"
    : null;
  // Top-holder wallet depth (feature B): how many of the top holders are
  // brand-new wallets, and whether the creator is itself a top holder.
  const holderAnalysisLine =
    wallet && wallet.ok && wallet.holders.checked > 0
      ? `🔍 持倉分析: ${wallet.holders.checked} 錢包 | ${wallet.holders.newWallets} 新(<${wallet.holders.newAgeHours}h)${wallet.holders.creatorRank ? ` | creator 持倉 #${wallet.holders.creatorRank}` : ""}`
      : null;
  // Cross-coin clustering (feature C): wallets that keep appearing as top
  // holders (or creators) of pushed coins — coordinated-activity signal.
  const clusterLine =
    wallet && wallet.holders.cluster.length > 0
      ? `🔁 關聯錢包: ${wallet.holders.cluster
          .slice(0, 2)
          .map(
            (c: { owner: string; coins: number; isCreator: boolean }) =>
              `${c.owner.slice(0, 4)}…${c.owner.slice(-4)} ×${c.coins}${c.isCreator ? "(creator)" : ""}`,
          )
          .join("、")} ⚠️`
      : null;

  // Flurry launch forensics — deploy-slot bundle + funding lineage. Hidden
  // entirely when the feature is disabled (same stance as GMGN/Arkham); a
  // configured-but-unverified coin shows 未分析 honestly (fail-open, never
  // misleading).
  const flurryLine =
    flurry === null
      ? null
      : flurry.report === null
        ? "🎭 Launch: —（未分析）"
        : flurry.report.bundled
          ? `🎭 Launch: 🔴 ${flurry.report.deploySlotWallets}錢包同slot買入 ${flurry.report.deploySlotSupplyPct}%供應${flurry.report.linkedWallets > 0 ? ` | ${flurry.report.linkedWallets}錢包同資金來源` : ""}（${flurryTierLabel(flurry.report.tier)}）`
          : `🎭 Launch: ✅ 乾淨（${flurry.report.deploySlotWallets}錢包 / ${flurry.report.deploySlotSupplyPct}%同slot）`;

  const organicLine =
    organic === null
      ? null
      : `🌱 有機度: ${
          organic.score === null
            ? "—"
            : `${organic.score.toFixed(1)}${organic.label ? `（${organic.label}）` : ""}`
        }${
          organic.tradersH1 === null
            ? ""
            : ` | 1h 交易者 ${organic.tradersH1.toLocaleString("en-US")}`
        }`;
  // Axiom summary replaces the five legacy enrichment lines when the
  // payload resolved; otherwise the card keeps today's exact shape.
  const axiomSummary = renderAxiomSummaryLine(axiom);
  const lines = [
    `🪙 ${name} (${symbol})`,
    `💵 价格: ${fmtUsd(price)}`,
    `💰 市值: ${fmtUsd(pair.marketCap)}`,
    `⚡ 5m 涨幅: ${pair.priceChange.m5 >= 0 ? "+" : ""}${pair.priceChange.m5.toFixed(2)}%`,
    `📊 5m 量: ${fmtUsd(pair.volume.m5)}`,
    ...(axiomSummary
      ? [axiomSummary]
      : [bundlerLine, top10Line, flowLine, sniperLine, holdersLine]),
    ...(organicLine ? [organicLine] : []),
    creatorLine,
    ...(gmgnLine ? [gmgnLine] : []),
    ...(arkhamLine ? [arkhamLine] : []),
    ...(crimeLine ? [crimeLine] : []),
    ...(holderAnalysisLine ? [holderAnalysisLine] : []),
    ...(clusterLine ? [clusterLine] : []),
    ...(flurryLine ? [flurryLine] : []),
    `📈 24h 量: ${fmtUsd(pair.volume.h24)}`,
    `💧 流动性: ${fmtUsd(liquidityUsd)}`,
    `⏱️ 上线: ${fmtAge(ageMs)}`,
    `🔑 合约: ${tokenAddress}`,
  ];
  return lines.join("\n");
}
