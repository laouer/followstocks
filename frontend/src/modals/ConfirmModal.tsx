interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string | React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  if (!open) return null;

  return (
    <div className="symbol-modal-backdrop" onClick={onClose}>
      <div
        className="symbol-modal confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="symbol-modal-header">
          <div>
            <h3 id="confirm-modal-title">{title}</h3>
          </div>
          <button className="modal-close" type="button" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="symbol-modal-body">
          <p>{message}</p>
        </div>
        <div className="symbol-modal-footer">
          <div className="footer-right">
            <button className="button" type="button" onClick={onClose}>
              {cancelLabel}
            </button>
            <button
              className={`button ${danger ? "danger" : "primary"}`}
              type="button"
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
