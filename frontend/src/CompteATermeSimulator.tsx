import { useMemo, useState } from "react";
import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";
import FloatingSidebar from "./FloatingSidebar";

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

type Capitalization = "monthly" | "quarterly" | "annual" | "maturity";

const capitalizationOptions: Array<{ value: Capitalization; label: string }> = [
  { value: "monthly", label: "Mensuelle" },
  { value: "quarterly", label: "Trimestrielle" },
  { value: "annual", label: "Annuelle" },
  { value: "maturity", label: "A l'echeance (actuariel)" },
];

const computeValue = (
  principal: number,
  annualRate: number,
  years: number,
  capitalization: Capitalization
) => {
  if (years <= 0) return principal;
  if (capitalization === "maturity") {
    return principal * Math.pow(1 + annualRate, years);
  }
  const periodsPerYear =
    capitalization === "monthly" ? 12 : capitalization === "quarterly" ? 4 : 1;
  const periodicRate = Math.pow(1 + annualRate, 1 / periodsPerYear) - 1;
  return principal * Math.pow(1 + periodicRate, years * periodsPerYear);
};

function CompteATermeSimulator() {
  const [form, setForm] = useState({
    initialDeposit: "10000",
    durationMonths: "24",
    annualInterestRate: "3.2",
    capitalization: "monthly" as Capitalization,
    taxRatePct: "12.8",
    socialTaxRatePct: "17.2",
  });

  const inputs = useMemo(() => {
    const monthsRaw = parseNumber(form.durationMonths, 0);
    return {
      initialDeposit: Math.max(0, parseNumber(form.initialDeposit, 0)),
      durationMonths: Math.max(0, Math.round(monthsRaw)),
      annualInterestRate: parseNumber(form.annualInterestRate, 0),
      capitalization: form.capitalization,
      taxRatePct: Math.max(0, parseNumber(form.taxRatePct, 0)),
      socialTaxRatePct: Math.max(0, parseNumber(form.socialTaxRatePct, 0)),
    };
  }, [form]);

  const simulation = useMemo(() => {
    const annualRate = inputs.annualInterestRate / 100;
    const years = inputs.durationMonths / 12;
    const totalTaxRate = (inputs.taxRatePct + inputs.socialTaxRatePct) / 100;

    const finalBeforeTax = computeValue(
      inputs.initialDeposit,
      annualRate,
      years,
      inputs.capitalization
    );
    const interestGross = Math.max(0, finalBeforeTax - inputs.initialDeposit);
    const taxAmount = interestGross * totalTaxRate;
    const finalAfterTax = finalBeforeTax - taxAmount;
    const interestNet = finalAfterTax - inputs.initialDeposit;
    const annualizedReturn =
      years > 0 && inputs.initialDeposit > 0
        ? Math.pow(finalAfterTax / inputs.initialDeposit, 1 / years) - 1
        : null;

    const stepMonths =
      inputs.durationMonths <= 24
        ? 1
        : inputs.durationMonths <= 60
        ? 3
        : inputs.durationMonths <= 120
        ? 6
        : 12;

    const points: Array<{
      label: string;
      valueBeforeTax: number;
      valueAfterTax: number;
    }> = [];

    const pushPoint = (month: number) => {
      const elapsedYears = month / 12;
      const value = computeValue(
        inputs.initialDeposit,
        annualRate,
        elapsedYears,
        inputs.capitalization
      );
      const label =
        month % 12 === 0 ? `Année ${month / 12}` : `Mois ${month}`;
      const afterTax = month === inputs.durationMonths ? value - taxAmount : value;
      points.push({
        label,
        valueBeforeTax: value,
        valueAfterTax: afterTax,
      });
    };

    if (inputs.durationMonths === 0) {
      pushPoint(0);
    } else {
      for (let month = 0; month <= inputs.durationMonths; month += stepMonths) {
        pushPoint(month);
      }
      const lastPoint = points[points.length - 1];
      const lastMonth = lastPoint ? lastPoint.label : null;
      const expectedLabel =
        inputs.durationMonths % 12 === 0
          ? `Année ${inputs.durationMonths / 12}`
          : `Mois ${inputs.durationMonths}`;
      if (lastMonth !== expectedLabel) {
        pushPoint(inputs.durationMonths);
      }
    }

    return {
      points,
      finalBeforeTax,
      finalAfterTax,
      interestGross,
      interestNet,
      taxAmount,
      annualizedReturn,
    };
  }, [inputs]);

  const chartOptions = useMemo<Highcharts.Options>(() => {
    const categories = simulation.points.map((point) => point.label);
    const valueBeforeTax = simulation.points.map((point) =>
      Number(point.valueBeforeTax.toFixed(2))
    );
    const valueAfterTax = simulation.points.map((point) =>
      Number(point.valueAfterTax.toFixed(2))
    );
    const axisBounds = computeAxisBounds([...valueBeforeTax, ...valueAfterTax]);

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
          name: "Capital brut",
          data: valueBeforeTax,
          color: "#0ea5e9",
        },
        {
          type: "line",
          name: "Capital net",
          data: valueAfterTax,
          color: "#22c55e",
        },
      ],
    };
  }, [simulation.points]);

  return (
    <div className="page">
      <FloatingSidebar />
      <main className="grid">
        <section className="card sim-card sim-card-term">
          <div className="card-header">
            <div>
              <p className="eyebrow">Simulateur</p>
              <h2>Compte a terme</h2>
              <p className="muted helper">
                Simulez un compte a terme avec un taux actuariel et fiscalite.
              </p>
            </div>
          </div>

          <div className="sim-grid">
            <div className="sim-form">
              <form className="form">
                <div className="sim-block">
                  <h4>Placement</h4>
                  <label>
                    Montant initial
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={form.initialDeposit}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          initialDeposit: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Duree (mois)
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={form.durationMonths}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          durationMonths: e.target.value,
                        }))
                      }
                    />
                  </label>
                </div>

                <div className="sim-block">
                  <h4>Rendement</h4>
                  <label>
                    Taux actuariel annuel (%)
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
                    Capitalisation
                    <select
                      value={form.capitalization}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          capitalization: e.target.value as Capitalization,
                        }))
                      }
                    >
                      {capitalizationOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="sim-block">
                  <h4>Fiscalite</h4>
                  <label>
                    Taux d'imposition sur les interets (%)
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
                    Prelevements sociaux (%)
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
                </div>
              </form>
            </div>

            <div className="sim-summary">
              <div className="summary-grid sim-kpis">
                <div className="stat">
                  <p>Montant initial</p>
                  <h3>{formatMoney(inputs.initialDeposit, "EUR")}</h3>
                </div>
                <div className="stat">
                  <p>Valeur brute a l'echeance</p>
                  <h3>{formatMoney(simulation.finalBeforeTax, "EUR")}</h3>
                </div>
                <div className="stat">
                  <p>Impots & prelevements</p>
                  <h3>{formatMoney(simulation.taxAmount, "EUR")}</h3>
                </div>
                <div className="stat">
                  <p>Valeur nette a l'echeance</p>
                  <h3>{formatMoney(simulation.finalAfterTax, "EUR")}</h3>
                </div>
                <div className="stat">
                  <p>Interets nets</p>
                  <h3
                    className={simulation.interestNet >= 0 ? "positive" : "negative"}
                  >
                    {formatMoney(simulation.interestNet, "EUR")}
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
                  Le taux saisi est un taux actuariel annuel. Les interets sont
                  capitalises selon la periodicite choisie, et la fiscalite est
                  appliquee a l'echeance.
                </p>
                <p>
                  Ajustez les taux selon votre tranche d'imposition et le regime
                  applicable.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default CompteATermeSimulator;
