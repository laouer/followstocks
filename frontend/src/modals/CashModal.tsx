import type { Account } from "../api";
import { formatMoney } from "../portfolio/formatters";
import { CASH_REASON_OPTIONS, CASH_REASON_DEFAULT } from "../constants";

interface CashFormState {
  amount: string;
  mode: "add" | "withdraw";
  reasonPreset: string;
  reasonCustom: string;
}

interface CashModalProps {
  account: Account | null;
  cashForm: CashFormState;
  onFormChange: (updater: (prev: CashFormState) => CashFormState) => void;
  onSubmit: (event: React.FormEvent) => void;
  onClose: () => void;
  totalCurrency: string;
  cashPreview: number | null;
}

export default function CashModal({
  account,
  cashForm,
  onFormChange,
  onSubmit,
  onClose,
  totalCurrency,
  cashPreview,
}: CashModalProps) {
  if (!account) return null;

  return (
    <div className="symbol-modal-backdrop" onClick={onClose}>
      <div
        className="symbol-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cash-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="symbol-modal-header">
          <div>
            <p className="eyebrow">Accounts</p>
            <h3 id="cash-modal-title">
              {cashForm.mode === "add" ? "Add cash" : "Withdraw cash"}
            </h3>
          </div>
          <button className="modal-close" type="button" onClick={onClose}>
            ×
          </button>
        </div>
        <form className="form" onSubmit={onSubmit}>
          <div className="symbol-modal-body cash-modal-body">
            <label>
              Amount
              <input
                type="number"
                step="any"
                min="0"
                placeholder="0"
                value={cashForm.amount}
                onChange={(e) =>
                  onFormChange((prev) => ({ ...prev, amount: e.target.value }))
                }
              />
            </label>
            <label>
              Action
              <select
                value={cashForm.mode}
                onChange={(e) =>
                  onFormChange((prev) => {
                    const mode = e.target.value as "add" | "withdraw";
                    const options = CASH_REASON_OPTIONS[mode] as readonly string[];
                    const defaultReason = CASH_REASON_DEFAULT[mode];
                    const shouldReplace =
                      !prev.reasonPreset || !options.includes(prev.reasonPreset);
                    return {
                      ...prev,
                      mode,
                      reasonPreset: shouldReplace ? defaultReason : prev.reasonPreset,
                      reasonCustom: shouldReplace ? "" : prev.reasonCustom,
                    };
                  })
                }
              >
                <option value="add">Add cash</option>
                <option value="withdraw">Withdraw cash</option>
              </select>
            </label>
            <label>
              Reason
              <div className="inline-row">
                <select
                  value={cashForm.reasonPreset}
                  onChange={(e) =>
                    onFormChange((prev) => ({
                      ...prev,
                      reasonPreset: e.target.value,
                      reasonCustom: e.target.value === "Other" ? prev.reasonCustom : "",
                    }))
                  }
                >
                  {CASH_REASON_OPTIONS[cashForm.mode].map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                {cashForm.reasonPreset === "Other" && (
                  <input
                    required
                    placeholder="Describe the reason"
                    value={cashForm.reasonCustom}
                    onChange={(e) =>
                      onFormChange((prev) => ({
                        ...prev,
                        reasonCustom: e.target.value,
                      }))
                    }
                  />
                )}
              </div>
            </label>
          </div>
          <div className="confirm-details">
            <span className="pill ghost">{account.name}</span>
            <span className="pill ghost">
              Cash available {formatMoney(account.liquidity, totalCurrency)}
            </span>
            {cashPreview !== null && (
              <span className={`pill ${cashPreview < 0 ? "danger" : "ghost"}`}>
                After {formatMoney(cashPreview, totalCurrency)}
              </span>
            )}
          </div>
          <div className="symbol-modal-footer">
            <div className="footer-right">
              <button className="button" type="button" onClick={onClose}>
                Cancel
              </button>
              <button className="button primary" type="submit">
                {cashForm.mode === "add" ? "Add cash" : "Withdraw cash"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
