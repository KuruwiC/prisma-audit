import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';

type DrawerProps = { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode };

/** Native dialog: focus trapping and Escape come with it */
export const Drawer = ({ open, onClose, title, children }: DrawerProps) => {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-0 ml-auto h-dvh max-h-dvh w-full max-w-[480px] bg-trace text-trace-ink shadow-2xl backdrop:bg-ink/40"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-trace-line px-5 py-4">
          <div className="min-w-0">{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-control p-1.5 text-trace-muted hover:bg-trace-raised hover:text-trace-ink"
          >
            <X size={18} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </dialog>
  );
};
