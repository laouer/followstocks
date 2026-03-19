import { useRef, useState } from "react";

interface BackupImportModalProps {
  open: boolean;
  onImport: (file: File) => void;
  onClose: () => void;
}

export default function BackupImportModal({
  open,
  onImport,
  onClose,
}: BackupImportModalProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedFile) {
      onImport(selectedFile);
      setSelectedFile(null);
    }
  };

  return (
    <div className="symbol-modal-backdrop" onClick={onClose}>
      <div
        className="symbol-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="backup-import-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="symbol-modal-header">
          <div>
            <p className="eyebrow">Backup</p>
            <h3 id="backup-import-title">Import backup</h3>
          </div>
          <button className="modal-close" type="button" onClick={onClose}>
            ×
          </button>
        </div>
        <form className="form" onSubmit={handleSubmit}>
          <div className="symbol-modal-body">
            <label>
              Select a JSON backup file
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <small className="muted">
              This will <strong>replace</strong> all existing data (accounts,
              holdings, placements, cash history) with the contents of the
              backup file.
            </small>
          </div>
          <div className="symbol-modal-footer">
            <div className="footer-right">
              <button className="button" type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                className="button danger"
                type="submit"
                disabled={!selectedFile}
              >
                Import &amp; replace
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
