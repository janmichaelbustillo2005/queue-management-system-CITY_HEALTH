import Link from "next/link";
import { OfficeIdentity } from "./SystemLogo";

// The one navigation sidebar for every signed-in role: work pages only, from
// lib/navigation. Account actions belong to the header account menu.
export default function AppSidebar({ groups, location, visible, docked, closeRef, onNavigate, onClose, onSettings }) {
  function item(entry) {
    const isActive = Boolean(location.ready && entry.isActive?.(location));
    const className = `app-nav-item${isActive ? " is-active" : ""}`;
    const content = (
      <>
        <i className={`${entry.icon} app-nav-icon`} aria-hidden="true" />
        <span className="app-nav-label">{entry.label}</span>
        {entry.external ? <i className="fas fa-external-link-alt app-nav-external" aria-hidden="true" /> : null}
        {entry.external ? <span className="app-sr-only"> (opens in a new tab)</span> : null}
      </>
    );
    if (entry.opensSettings && onSettings) {
      return (
        <button key={entry.id} type="button" className={className} aria-current={isActive ? "page" : undefined}
          onClick={() => { onNavigate(); onSettings(); }}>
          {content}
        </button>
      );
    }
    return (
      <Link key={entry.id} href={entry.href} className={className} aria-current={isActive ? "page" : undefined}
        onClick={onNavigate} {...(entry.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
        {content}
      </Link>
    );
  }

  return (
    // Hidden sidebars are inert so their links leave the tab order.
    <aside id="app-sidebar" className={`app-sidebar${visible ? " is-visible" : ""}`} inert={!visible}>
      <div className="app-sidebar-brand">
        <OfficeIdentity variant="sidebar" />
        {!docked ? (
          <button type="button" ref={closeRef} className="app-sidebar-close" aria-label="Close navigation"
            onClick={() => onClose(true)}>
            <i className="fas fa-times" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <nav className="app-sidebar-nav" aria-label="Main navigation">
        {groups.map((group) => (
          <div key={group.id} className="app-nav-group" role="group" aria-labelledby={`app-nav-group-${group.id}`}>
            <div id={`app-nav-group-${group.id}`} className="app-nav-group-label">{group.label}</div>
            {group.items.map(item)}
          </div>
        ))}
      </nav>
    </aside>
  );
}
