import { queuePageItems, queuePageSummary } from "../lib/queueView";

const BUTTON_CLASS = "h-8 min-w-[2rem] px-2.5 rounded-lg border text-xs font-semibold transition-colors " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 " +
  "disabled:opacity-50 disabled:cursor-not-allowed";
const IDLE_CLASS = "brand-border bg-white brand-text brand-hover-subtle";
const CURRENT_CLASS = "brand-button border-transparent";

// The footer of Front Desk Patient Management and Superadmin Queue Management: what is shown
// ("Showing 11–20 of 25") and, once there is more than one page, Previous, page numbers and Next.
// `pagination` comes from paginateQueueRows (lib/queueView.js); onPageChange receives a page number.
// `className` sets the footer's spacing and border for the table it sits under.
export default function QueuePagination({ pagination, onPageChange, label = "Queue pages", className = "px-4 py-3 border-t brand-border" }) {
  const { page, pageCount, total } = pagination;
  if (!total) return null;
  return (
    <div data-queue-pagination className={`flex flex-wrap items-center justify-between gap-3 ${className}`}>
      <p className="text-xs font-semibold brand-text-muted m-0" role="status" aria-live="polite" data-queue-page-summary>
        {queuePageSummary(pagination)}
      </p>
      {pageCount > 1 ? (
        <nav aria-label={label} className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            data-page-nav="previous"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className={`${BUTTON_CLASS} ${IDLE_CLASS}`}
          >
            <i className="fas fa-chevron-left me-1" aria-hidden="true" />
            Previous
          </button>
          {queuePageItems(page, pageCount).map((item, index) =>
            item === "gap" ? (
              <span key={`gap-${index}`} className="px-1 text-xs brand-text-muted" aria-hidden="true">…</span>
            ) : (
              <button
                key={item}
                type="button"
                data-page={item}
                onClick={() => onPageChange(item)}
                aria-label={`Page ${item}`}
                aria-current={item === page ? "page" : undefined}
                className={`${BUTTON_CLASS} ${item === page ? CURRENT_CLASS : IDLE_CLASS}`}
              >
                {item}
              </button>
            )
          )}
          <button
            type="button"
            data-page-nav="next"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= pageCount}
            className={`${BUTTON_CLASS} ${IDLE_CLASS}`}
          >
            Next
            <i className="fas fa-chevron-right ms-1" aria-hidden="true" />
          </button>
        </nav>
      ) : null}
    </div>
  );
}
