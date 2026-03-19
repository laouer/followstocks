import { formatDateInput, formatMoney } from "../portfolio/formatters";

interface AccountFormState {
  name: string;
  account_type: string;
  liquidity: string;
  manual_invested: string;
  created_at: string;
}

interface AccountModalProps {
  open: boolean;
  editingAccountId: number | null;
  accountForm: AccountFormState;
  onFormChange: (updater: (prev: AccountFormState) => AccountFormState) => void;
  onSubmit: (event: React.FormEvent) => void;
  onClose: () => void;
  // refs for guided tour
  nameInputRef?: React.RefObject<HTMLInputElement | null>;
  typeInputRef?: React.RefObject<HTMLInputElement | null>;
  openedAtInputRef?: React.RefObject<HTMLInputElement | null>;
  liquidityInputRef?: React.RefObject<HTMLInputElement | null>;
  contributedInputRef?: React.RefObject<HTMLInputElement | null>;
  saveButtonRef?: React.RefObject<HTMLButtonElement | null>;
}

export default function AccountModal({
  open,
  editingAccountId,
  accountForm,
  onFormChange,
  onSubmit,
  onClose,
  nameInputRef,
  typeInputRef,
  openedAtInputRef,
  liquidityInputRef,
  contributedInputRef,
  saveButtonRef,
}: AccountModalProps) {
  if (!open) return null;

  return (
    <div className="symbol-modal-backdrop" onClick={onClose}>
      <div
        className="symbol-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="symbol-modal-header">
          <div>
            <p className="eyebrow">Accounts</p>
            <h3 id="account-modal-title">
              {editingAccountId ? "Edit account" : "Add account"}
            </h3>
          </div>
          <button className="modal-close" type="button" onClick={onClose}>
            ×
          </button>
        </div>
        <form className="form" onSubmit={onSubmit}>
          <div className="symbol-modal-body account-modal-body">
            <label>
              Name
              <input
                required
                placeholder="Compte titres"
                ref={nameInputRef}
                value={accountForm.name}
                onChange={(e) =>
                  onFormChange((prev) => ({ ...prev, name: e.target.value }))
                }
              />
            </label>
            <label>
              Type
              <input
                list="account-type-list"
                placeholder="PEA, Assurance vie"
                ref={typeInputRef}
                value={accountForm.account_type}
                onChange={(e) =>
                  onFormChange((prev) => ({ ...prev, account_type: e.target.value }))
                }
              />
              <datalist id="account-type-list">
                <option value="Compte titres" />
                <option value="PEA" />
                <option value="Assurance vie" />
                <option value="PER" />
                <option value="Livret A" />
                <option value="LDD" />
                <option value="Cash" />
              </datalist>
            </label>
            <label>
              Opened at
              <input
                type="date"
                required
                ref={openedAtInputRef}
                value={accountForm.created_at}
                onChange={(e) =>
                  onFormChange((prev) => ({ ...prev, created_at: e.target.value }))
                }
              />
              <small className="muted">
                Used to compute annual performance for the account.
              </small>
            </label>
            <label>
              Cash available
              <input
                type="number"
                step="any"
                min="0"
                placeholder="0"
                ref={liquidityInputRef}
                value={accountForm.liquidity}
                onChange={(e) =>
                  onFormChange((prev) => ({ ...prev, liquidity: e.target.value }))
                }
              />
              <small className="muted">Cash available before contributions.</small>
            </label>
            <label>
              Capital
              <input
                type="number"
                step="any"
                min="0"
                placeholder="0"
                ref={contributedInputRef}
                value={accountForm.manual_invested}
                onChange={(e) =>
                  onFormChange((prev) => ({ ...prev, manual_invested: e.target.value }))
                }
              />
              <small className="muted">Added to liquidity to track contributions.</small>
            </label>
          </div>
          <div className="symbol-modal-footer">
            <div className="footer-right">
              <button className="button" type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="button primary" ref={saveButtonRef}>
                {editingAccountId ? "Save changes" : "Save account"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
