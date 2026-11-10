'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

// A native <dialog>: focus is trapped, Escape closes it, and the page behind is inert.
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="sheet-body">
          <div className="sheet-head">
            <h2 className="h2">{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={22} aria-hidden />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
