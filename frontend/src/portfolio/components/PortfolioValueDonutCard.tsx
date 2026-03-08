import { useMemo } from "react";
import Highcharts from "highcharts/highstock";
import HighchartsReact from "highcharts-react-official";
import { formatMoney, formatMoneySigned, formatPercent, formatPercentSigned } from "../formatters";

type PortfolioValueDonutCardProps = {
  cash: number | null | undefined;
  latent: number | null | undefined;
  latentPct: number | null | undefined;
  portfolioValue: number | null | undefined;
  currency: string;
};

type BreakdownItem = {
  key: "portfolio" | "cash";
  label: string;
  chartValue: number;
  color: string;
  formattedValue: string;
  shareValue?: string;
  tone: "neutral" | "positive" | "negative";
};

function PortfolioValueDonutCard({
  cash,
  latent,
  latentPct,
  portfolioValue,
  currency,
}: PortfolioValueDonutCardProps) {
  const total = useMemo(() => {
    const hasBreakdownValues = portfolioValue != null || cash != null;

    if (hasBreakdownValues) {
      return (portfolioValue ?? 0) + (cash ?? 0);
    }
    return null;
  }, [cash, portfolioValue]);

  const portfolioShare = useMemo(() => {
    if (total === null || total <= 0) return null;
    return (portfolioValue ?? 0) / total;
  }, [portfolioValue, total]);

  const cashShare = useMemo(() => {
    if (total === null || total <= 0) return null;
    return (cash ?? 0) / total;
  }, [cash, total]);

  const latentInsight = useMemo(() => {
    if (latent === null || latent === undefined) return null;
    return {
      label: "Latent P/L",
      value: formatMoneySigned(latent, currency),
      detail:
        latentPct === null || latentPct === undefined
          ? "Unrealized gain or loss on invested capital"
          : `${formatPercentSigned(latentPct)} of costs`,
      tone: latent >= 0 ? "positive" : "negative" as const,
    };
  }, [currency, latent, latentPct]);

  const breakdown = useMemo<BreakdownItem[]>(() => {
    const portfolioAmount = portfolioValue ?? 0;
    const cashAmount = cash ?? 0;

    return [
      {
        key: "portfolio",
        label: "Portfolio value",
        chartValue: Math.max(portfolioAmount, 0),
        color: "#8ec5ff",
        formattedValue: formatMoney(portfolioAmount, currency),
        shareValue:
          portfolioShare === null ? "No allocation yet" : `${formatPercent(portfolioShare)} of total wealth`,
        tone: "neutral",
      },
      {
        key: "cash",
        label: "Available cash",
        chartValue: Math.max(cashAmount, 0),
        color: "#f8bf24",
        formattedValue: formatMoney(cashAmount, currency),
        shareValue:
          cashShare === null ? "No allocation yet" : `${formatPercent(cashShare)} cash reserve`,
        tone: "neutral",
      },
    ];
  }, [cash, cashShare, currency, portfolioShare, portfolioValue]);

  const chartOptions = useMemo<Highcharts.Options>(() => {
    const hasData = breakdown.some((item) => item.chartValue > 0);
    const centerText = formatMoney(total, currency);
    const centerTitle = `<div class="donut-center donut-center-summary"><span>Total wealth</span><strong>${centerText}</strong><em>Portfolio + cash</em></div>`;
    const data = hasData
      ? breakdown.map((item) => ({
          name: item.label,
          y: Number(item.chartValue.toFixed(2)),
          color: item.color,
          formattedValue: item.formattedValue,
          shareValue: item.shareValue,
          isDummy: false,
        }))
      : [
          {
            name: "No portfolio data",
            y: 1,
            color: "rgba(255, 255, 255, 0.08)",
            formattedValue: "—",
            isDummy: true,
          },
        ];

    return {
      chart: {
        type: "pie",
        backgroundColor: "transparent",
        height: 270,
        spacing: [0, 0, 0, 0],
      },
      title: {
        useHTML: true,
        align: "center",
        verticalAlign: "middle",
        floating: true,
        style: { color: "#e9ecf4" },
        text: centerTitle,
      },
      tooltip: {
        useHTML: true,
        backgroundColor: "rgba(12, 18, 36, 0.95)",
        borderColor: "rgba(255, 255, 255, 0.08)",
        style: { color: "#e9ecf4" },
        formatter: function (this: Highcharts.Point) {
          const options = this.options as Highcharts.PointOptionsObject & {
            formattedValue?: string;
            shareValue?: string;
            isDummy?: boolean;
          };
          if (options.isDummy) {
            return "Add accounts or holdings to see the breakdown";
          }
          return `<strong>${this.name}</strong><br/>${options.formattedValue || "—"}${
            options.shareValue ? `<br/>${options.shareValue}` : ""
          }`;
        },
      },
      plotOptions: {
        pie: {
          innerSize: "70%",
          size: "83%",
          borderWidth: 0,
          dataLabels: {
            enabled: hasData,
            distance: 16,
            connectorColor: "rgba(255, 255, 255, 0.32)",
            connectorWidth: 1.2,
            softConnector: true,
            crop: false,
            overflow: "allow",
            style: {
              color: "#e9ecf4",
              textOutline: "none",
              fontWeight: "600",
              fontSize: "12px",
              lineHeight: "16px",
            },
            formatter: function (this: Highcharts.Point) {
              const options = this.options as Highcharts.PointOptionsObject & {
                formattedValue?: string;
                shareValue?: string;
                isDummy?: boolean;
              };
              if (options.isDummy) return "";
              return `${this.name}<br/>${options.formattedValue || "—"}<br/>${
                options.shareValue || ""
              }`;
            },
          },
          states: {
            hover: {
              halo: { size: 0 },
              brightness: 0.06,
            },
          },
        },
      },
      legend: { enabled: false },
      credits: { enabled: false },
      series: [
        {
          type: "pie",
          name: "Net value",
          data,
        },
      ],
    };
  }, [breakdown, currency, total]);

  return (
    <div className="stat-donut stat-donut-large">
      <div className="summary-chart-header stat-donut-header">
        <p className="eyebrow">Wealth</p>
        <div className="summary-chart-title">
          <h3>Total wealth</h3>
        </div>
        <p className="muted helper">Portfolio value + available cash</p>
      </div>
      <div className="stat-donut-layout">
        <div className="stat-donut-chart-shell">
          <div className="stat-donut-chart">
            <HighchartsReact highcharts={Highcharts} options={chartOptions} />
          </div>
        </div>
        <div className="stat-donut-content">
          <div className="summary-chart-latent-header">
            <span className="summary-chart-latent-title">Summary</span>
          </div>

          <div className="stat-donut-insights">
            <div className="stat-donut-insight">
              <span>Invested share</span>
              <strong>{portfolioShare === null ? "—" : formatPercent(portfolioShare)}</strong>
              <small>Placements</small>
            </div>
            <div className="stat-donut-insight">
              <span>Cash reserve</span>
              <strong>{cashShare === null ? "—" : formatPercent(cashShare)}</strong>
              <small>Ready to deploy</small>
            </div>
            {latentInsight ? (
              <div className={`stat-donut-insight ${latentInsight.tone}`}>
                <span>{latentInsight.label}</span>
                <strong>{latentInsight.value}</strong>
                <small>{latentInsight.detail}</small>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export default PortfolioValueDonutCard;
