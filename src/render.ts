import { fmtAge, fmtUsd } from "./format";
import type { ArkhamTokenHolders } from "./arkham";
import type { CrimeCheckResult } from "./crimewallets";
import type { GmgnTokenInfo } from "./gmgn";
import type { QualifyingCoin } from "./scanner";
import type { WalletAnalysisResult } from "./walletanalysis";

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
  const lines = [
    `🪙 ${name} (${symbol})`,
    `💵 价格: ${fmtUsd(price)}`,
    `💰 市值: ${fmtUsd(pair.marketCap)}`,
    `⚡ 5m 涨幅: ${pair.priceChange.m5 >= 0 ? "+" : ""}${pair.priceChange.m5.toFixed(2)}%`,
    `📊 5m 量: ${fmtUsd(pair.volume.m5)}`,
    bundlerLine,
    top10Line,
    flowLine,
    sniperLine,
    holdersLine,
    ...(organicLine ? [organicLine] : []),
    creatorLine,
    ...(gmgnLine ? [gmgnLine] : []),
    ...(arkhamLine ? [arkhamLine] : []),
    ...(crimeLine ? [crimeLine] : []),
    ...(holderAnalysisLine ? [holderAnalysisLine] : []),
    ...(clusterLine ? [clusterLine] : []),
    `📈 24h 量: ${fmtUsd(pair.volume.h24)}`,
    `💧 流动性: ${fmtUsd(liquidityUsd)}`,
    `⏱️ 上线: ${fmtAge(ageMs)}`,
    `🔑 合约: ${tokenAddress}`,
  ];
  return lines.join("\n");
}
