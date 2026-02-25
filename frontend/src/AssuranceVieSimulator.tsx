import { useMemo, useState } from "react";
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";
import ChatWidget from "./chat/ChatWidget";
import PageAvatarMenu from "./PageAvatarMenu";
import { API_BASE } from "./api";

const formatMoney = (value?: number | null, currency = "EUR") => {
  if (value === null || value === undefined) return "—";
  if (currency === "EUR") {
    return `${value.toLocaleString("fr-FR", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })} €`;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
};

const formatPercent = (value?: number | null) => {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(2)}%`;
};

const parseNumber = (value: string, fallback = 0) => {
  const normalized = value.replace(",", ".").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const computeAxisBounds = (values: number[]) => {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) return { min: undefined, max: undefined };
  const minVal = Math.min(...filtered);
  const maxVal = Math.max(...filtered);
  const padding = Math.max(Math.abs(minVal), Math.abs(maxVal)) * 0.1;
  if (minVal === maxVal) {
    return {
      min: minVal - (padding || 1),
      max: maxVal + (padding || 1),
    };
  }
  return {
    min: minVal - Math.abs(minVal) * 0.1,
    max: maxVal + Math.abs(maxVal) * 0.1,
  };
};

const computeIrr = (cashFlows: number[]) => {
  const npv = (rate: number) =>
    cashFlows.reduce((sum, cashFlow, index) => {
      return sum + cashFlow / Math.pow(1 + rate, index);
    }, 0);

  let low = -0.9999;
  let high = 10;
  let lowNpv = npv(low);
  let highNpv = npv(high);

  if (!Number.isFinite(lowNpv) || !Number.isFinite(highNpv) || lowNpv * highNpv > 0) {
    return null;
  }

  for (let i = 0; i < 100; i += 1) {
    const mid = (low + high) / 2;
    const midNpv = npv(mid);
    if (Math.abs(midNpv) < 1e-6) return mid;
    if (lowNpv * midNpv < 0) {
      high = mid;
      highNpv = midNpv;
    } else {
      low = mid;
      lowNpv = midNpv;
    }
  }

  return (low + high) / 2;
};

const CHAT_API_BASE = API_BASE;
const CHAT_TRANSLATOR = (value: string) => {
  if (value === "Hello, I can help with your portfolio analysis today.") {
    return "Hello, I can help with assurance vie and investment simulation questions.";
  }
  if (value === "Ask a question") {
    return "Ask a question about assurance vie";
  }
  return value;
};
const resolveChatLang = () => {
  if (typeof navigator === "undefined" || !navigator.language) return "en";
  return navigator.language.split("-")[0] || "en";
};

function AssuranceVieSimulator() {
  const [chatOpen, setChatOpen] = useState(false);
  const [chatToggleToken, setChatToggleToken] = useState(0);
  const chatLang = resolveChatLang();
  const [form, setForm] = useState({
    initialInvestment: "10000",
    annualContribution: "1500",
    years: "10",
    annualInterestRate: "4.5",
    managementFeePct: "0.7",
    inputFeePct: "2",
    versementFeePct: "0",
    exitFeePct: "0.5",
    taxRatePct: "7.5",
    socialTaxRatePct: "17.2",
    taxAllowance: "4600",
  });

  const inputs = useMemo(() => {
    const yearsRaw = parseNumber(form.years, 10);
    return {
      initialInvestment: Math.max(0, parseNumber(form.initialInvestment, 0)),
      annualContribution: Math.max(0, parseNumber(form.annualContribution, 0)),
      years: Math.max(0, Math.round(yearsRaw)),
      annualInterestRate: parseNumber(form.annualInterestRate, 0),
      managementFeePct: Math.max(0, parseNumber(form.managementFeePct, 0)),
      inputFeePct: Math.max(0, parseNumber(form.inputFeePct, 0)),
      versementFeePct: Math.max(0, parseNumber(form.versementFeePct, 0)),
      exitFeePct: Math.max(0, parseNumber(form.exitFeePct, 0)),
      taxRatePct: Math.max(0, parseNumber(form.taxRatePct, 0)),
      socialTaxRatePct: Math.max(0, parseNumber(form.socialTaxRatePct, 0)),
      taxAllowance: Math.max(0, parseNumber(form.taxAllowance, 0)),
    };
  }, [form]);

  const simulation = useMemo(() => {
    const annualRate = inputs.annualInterestRate / 100;
    const managementRate = inputs.managementFeePct / 100;
    const inputFeeRate = inputs.inputFeePct / 100;
    const versementFeeRate = inputs.versementFeePct / 100;
    const exitFeeRate = inputs.exitFeePct / 100;
    const taxRate = inputs.taxRatePct / 100;
    const socialRate = inputs.socialTaxRatePct / 100;

    let value = 0;
    let totalContributions = 0;
    let totalInputFees = 0;
    let totalVersementFees = 0;
    let totalManagementFees = 0;
    const rows: Array<{
      year: number;
      valueBeforeTax: number;
      valueAfterTax: number;
      contributions: number;
    }> = [];

    const contribute = (amount: number, feeRate: number, feeBucket: "input" | "versement") => {
      if (amount <= 0) return;
      totalContributions += amount;
      const fee = amount * feeRate;
      if (feeBucket === "input") {
        totalInputFees += fee;
      } else {
        totalVersementFees += fee;
      }
      value += amount - fee;
    };

    contribute(inputs.initialInvestment, inputFeeRate, "input");
    rows.push({
      year: 0,
      valueBeforeTax: value,
      valueAfterTax: value,
      contributions: totalContributions,
    });

    for (let year = 1; year <= inputs.years; year += 1) {
      contribute(inputs.annualContribution, versementFeeRate, "versement");
      value *= 1 + annualRate;
      const managementFee = value * managementRate;
      totalManagementFees += managementFee;
      value -= managementFee;
      rows.push({
        year,
        valueBeforeTax: value,
        valueAfterTax: value,
        contributions: totalContributions,
      });
    }

    const exitFeeAmount = value * exitFeeRate;
    value -= exitFeeAmount;
    if (rows.length > 0) {
      rows[rows.length - 1].valueBeforeTax = value;
    }

    const valueBeforeTax = value;
    const netContributions = totalContributions - totalInputFees - totalVersementFees;
    const gainBeforeTax = valueBeforeTax - netContributions;
    const taxableGain = Math.max(0, gainBeforeTax - inputs.taxAllowance);
    const taxAmount = taxableGain * (taxRate + socialRate);
    const finalValue = valueBeforeTax - taxAmount;
    const gain = finalValue - totalContributions;
    if (rows.length > 0) {
      rows[rows.length - 1].valueAfterTax = finalValue;
    }

    let annualizedReturn = null;
    if (inputs.years >= 0 && (inputs.initialInvestment > 0 || inputs.annualContribution > 0)) {
      const cashFlows = Array.from({ length: inputs.years + 1 }, (_, idx) => {
        if (idx === 0) return -inputs.initialInvestment;
        return -inputs.annualContribution;
      });
      if (cashFlows.length) {
        cashFlows[cashFlows.length - 1] += finalValue;
        annualizedReturn = computeIrr(cashFlows);
      }
    }

    return {
      rows,
      totalContributions,
      valueBeforeTax,
      netContributions,
      gain,
      finalValue,
      totalInputFees,
      totalVersementFees,
      totalManagementFees,
      exitFeeAmount,
      taxAmount,
      totalFees:
        totalInputFees + totalVersementFees + totalManagementFees + exitFeeAmount + taxAmount,
      annualizedReturn,
    };
  }, [inputs]);

  const chartOptions = useMemo<Highcharts.Options>(() => {
    const categories = simulation.rows.map((row) => `Année ${row.year}`);
    const valueBeforeTax = simulation.rows.map((row) => Number(row.valueBeforeTax.toFixed(2)));
    const valueAfterTax = simulation.rows.map((row) => Number(row.valueAfterTax.toFixed(2)));
    const contributions = simulation.rows.map((row) =>
      Number(row.contributions.toFixed(2))
    );
    const axisBounds = computeAxisBounds([
      ...valueBeforeTax,
      ...valueAfterTax,
      ...contributions,
    ]);

    return {
      chart: {
        type: "areaspline",
        backgroundColor: "transparent",
        height: 320,
      },
      title: { text: null },
      xAxis: {
        categories,
        tickmarkPlacement: "on",
        lineColor: "rgba(255, 255, 255, 0.15)",
        labels: {
          style: { color: "#9fb3d1", fontSize: "11px" },
        },
      },
      yAxis: {
        title: { text: null },
        gridLineColor: "rgba(255, 255, 255, 0.08)",
        min: axisBounds.min,
        max: axisBounds.max,
        labels: {
          style: { color: "#9fb3d1", fontSize: "11px" },
          formatter: function (this: Highcharts.AxisLabelsFormatterContextObject) {
            return formatMoney(this.value as number, "EUR");
          },
        },
      },
      tooltip: {
        shared: true,
        useHTML: true,
        backgroundColor: "rgba(12, 18, 36, 0.95)",
        borderColor: "rgba(255, 255, 255, 0.08)",
        style: { color: "#e9ecf4" },
        formatter: function (this: Highcharts.TooltipFormatterContextObject) {
          const points = this.points || [];
          const lines = points.map((point) => {
            const value = formatMoney(point.y as number, "EUR");
            return `<span style="color:${point.color}">●</span> ${
              point.series.name
            }: <strong>${value}</strong>`;
          });
          return `<strong>${this.x}</strong><br/>${lines.join("<br/>")}`;
        },
      },
      plotOptions: {
        areaspline: {
          fillOpacity: 0.2,
          marker: { radius: 2 },
        },
        series: {
          marker: { enabled: false },
        },
      },
      legend: {
        itemStyle: { color: "#e9ecf4", fontWeight: "500" },
      },
      credits: { enabled: false },
      series: [
        {
          type: "areaspline",
          name: "Valeur avant impôt",
          data: valueBeforeTax,
          color: "#0ea5e9",
        },
        {
          type: "line",
          name: "Valeur après impôt",
          data: valueAfterTax,
          color: "#22c55e",
        },
        {
          type: "line",
          name: "Versements",
          data: contributions,
          color: "#f59e0b",
          dashStyle: "ShortDash",
        },
      ],
    };
  }, [simulation.rows]);

  return (
    <div className="page">
      <main className="grid">
        <section className="card sim-card">
          <div className="card-header">
            <div>
              <p className="eyebrow">Simulateur</p>
              <h2>Projection assurance vie</h2>
              <p className="muted helper">
                Modélisez les frais d'entrée, de gestion et de sortie avec vos hypothèses fiscales.
              </p>
            </div>
            <div className="card-actions">
              <PageAvatarMenu
                chatActive={chatOpen}
                onChatToggle={() => setChatToggleToken((prev) => prev + 1)}
              />
            </div>
          </div>

          <div className="sim-grid">
            <div className="sim-form">
              <form className="form">
                <div className="sim-block">
                  <h4>Versements</h4>
                  <label>
                    Placement initial
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={form.initialInvestment}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          initialInvestment: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Versement annuel
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={form.annualContribution}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          annualContribution: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Nombre d'années
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={form.years}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          years: e.target.value,
                        }))
                      }
                    />
                  </label>
                </div>

                <div className="sim-block">
                  <h4>Rendement & frais</h4>
                  <label>
                    Taux d'intérêt annuel (%)
                    <input
                      type="number"
                      step="0.01"
                      value={form.annualInterestRate}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          annualInterestRate: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Frais de gestion (%)
                    <input
                      type="number"
                      step="0.01"
                      value={form.managementFeePct}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          managementFeePct: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Frais d'entrée (%)
                    <input
                      type="number"
                      step="0.01"
                      value={form.inputFeePct}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          inputFeePct: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Frais de versement (%)
                    <input
                      type="number"
                      step="0.01"
                      value={form.versementFeePct}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          versementFeePct: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Frais de sortie (%)
                    <input
                      type="number"
                      step="0.01"
                      value={form.exitFeePct}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          exitFeePct: e.target.value,
                        }))
                      }
                    />
                  </label>
                </div>

                <div className="sim-block">
                  <h4>Fiscalité</h4>
                  <label>
                    Taux d'imposition sur les gains (%)
                    <input
                      type="number"
                      step="0.01"
                      value={form.taxRatePct}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          taxRatePct: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Prélèvements sociaux (%)
                    <input
                      type="number"
                      step="0.01"
                      value={form.socialTaxRatePct}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          socialTaxRatePct: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Abattement fiscal
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={form.taxAllowance}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          taxAllowance: e.target.value,
                        }))
                      }
                    />
                  </label>
                </div>
              </form>
            </div>

            <div className="sim-summary">
              <div className="summary-grid sim-kpis">
                <div className="stat">
                  <p>Total versé</p>
                  <h3>{formatMoney(simulation.totalContributions, "EUR")}</h3>
                </div>
                <div className="stat">
                  <p>Valeur totale avant impôt</p>
                  <h3>{formatMoney(simulation.valueBeforeTax, "EUR")}</h3>
                </div>
                <div className="stat">
                  <p>Total frais & impôts</p>
                  <h3>{formatMoney(simulation.totalFees, "EUR")}</h3>
                </div>
                <div className="stat">
                  <p>Valeur totale après impôt</p>
                  <h3>{formatMoney(simulation.finalValue, "EUR")}</h3>
                </div>
                <div className="stat">
                  <p>Gain net</p>
                  <h3 className={simulation.gain >= 0 ? "positive" : "negative"}>
                    {formatMoney(simulation.gain, "EUR")}
                  </h3>
                </div>
                <div className="stat">
                  <p>Rendement annuel</p>
                  <h3>{formatPercent(simulation.annualizedReturn)}</h3>
                </div>
              </div>

              <div className="sim-chart">
                <HighchartsReact highcharts={Highcharts} options={chartOptions} />
              </div>

              <div className="sim-footer muted">
                <p>
                  Les frais d'entrée s'appliquent au placement initial, les frais de versement aux
                  versements annuels, les frais de gestion sont annuels et les impôts s'appliquent à
                  la fin.
                </p>
                <p>
                  La fiscalité varie selon le contrat et la juridiction ; ajustez les taux et
                  l'abattement pour coller à votre situation.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
      <ChatWidget
        apiBase={CHAT_API_BASE}
        lang={chatLang}
        t={CHAT_TRANSLATOR}
        toggleToken={chatToggleToken}
        hideFab
        onOpenChange={setChatOpen}
      />
    </div>
  );
}

export default AssuranceVieSimulator;
