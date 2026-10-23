import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { OfficeIdentity } from "./SystemLogo";
import AppSidebar from "./AppSidebar";
import AccountMenu, { ProfileDialog } from "./AccountMenu";
import { OFFICE_IDENTITY } from "../lib/branding";
import { navigationFor, readNavLocation, resolveAccount } from "../lib/navigation";

// Wide screens keep the sidebar docked beside the page; narrower ones use a drawer.
const DOCKED_QUERY = "(min-width: 1200px)";
const COLLAPSED_KEY = "city_health_sidebar_collapsed";

function useDateTime(formatter) {
  const [value, setValue] = useState("");

  useEffect(() => {
    const update = () => setValue(formatter(new Date()));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [formatter]);

  return value;
}

function readCollapsed() {
  try { return window.localStorage.getItem(COLLAPSED_KEY) === "1"; } catch (_error) { return false; }
}

function writeCollapsed(value) {
  try { window.localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0"); } catch (_error) { /* preference only */ }
}

// The authenticated layout: office identity, page title, account menu and the
// role's navigation. Navigation comes from the signed-in session, not from
// the page, so every page a role opens shows the same menu.
export default function SiteFrame({
  title,
  icon,
  children,
  onSettings,
  accountActions = [],
  contentClassName = ""
}) {
  const { user, logout, logoutError } = useAuth();
  const router = useRouter();
  const account = resolveAccount(user);
  const groups = navigationFor(account);
  const hasNav = groups.length > 0;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [docked, setDocked] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const menuToggleRef = useRef(null);
  const sidebarCloseRef = useRef(null);
  const profileReturnRef = useRef(null);
  const dateTime = useDateTime(
    useMemo(() => (date) => `${date.toLocaleTimeString()} · ${date.toLocaleDateString()}`, [])
  );
  const sidebarVisible = hasNav && (docked ? !collapsed : drawerOpen);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(DOCKED_QUERY);
    const sync = () => { setDocked(media.matches); setDrawerOpen(false); };
    setCollapsed(readCollapsed());
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);

  // Dismissing the drawer (close button, overlay, Escape) hands focus back to
  // the menu button; following a link leaves focus where navigation puts it.
  const closeDrawer = (restoreFocus = false) => {
    setDrawerOpen(false);
    if (restoreFocus) menuToggleRef.current?.focus();
  };

  function toggleNavigation() {
    if (docked) {
      setCollapsed(!collapsed);
      writeCollapsed(!collapsed);
    } else {
      setDrawerOpen((current) => !current);
    }
  }

  useEffect(() => {
    if (!drawerOpen) return undefined;
    sidebarCloseRef.current?.focus({ preventScroll: true });
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setDrawerOpen(false);
        menuToggleRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [drawerOpen]);

  const openProfile = () => {
    profileReturnRef.current = typeof document !== "undefined" ? document.activeElement : null;
    setProfileOpen(true);
  };
  const closeProfile = useCallback(() => {
    setProfileOpen(false);
    const target = profileReturnRef.current;
    // Focus returns to whatever opened the dialog, or the menu button if that is gone.
    (target?.isConnected ? target : menuToggleRef.current)?.focus?.();
  }, []);

  // layout-shell keeps the existing page-wide form styles; the docked layout itself is CSS (see app-shell.css).
  const shellClass = ["layout-shell app-shell", hasNav ? "app-shell--nav" : "", collapsed ? "is-collapsed" : ""]
    .filter(Boolean).join(" ");

  return (
    <div className={shellClass}>
      {logoutError ? (
        <div role="alert" className="app-alert">{logoutError}</div>
      ) : null}
      {hasNav ? (
        <>
          <AppSidebar
            groups={groups}
            location={readNavLocation(router)}
            visible={sidebarVisible}
            docked={docked}
            closeRef={sidebarCloseRef}
            onNavigate={() => { if (!docked) closeDrawer(); }}
            onClose={closeDrawer}
            onSettings={onSettings}
          />
          <div className={`app-overlay${drawerOpen && !docked ? " is-visible" : ""}`} onClick={() => closeDrawer(true)} />
        </>
      ) : null}

      <div className="app-frame">
        <header className="app-header">
          {hasNav ? (
            <button type="button" ref={menuToggleRef} className="app-menu-toggle" onClick={toggleNavigation}
              aria-label={sidebarVisible ? "Hide navigation" : "Show navigation"}
              aria-controls="app-sidebar" aria-expanded={sidebarVisible}>
              <i className="fas fa-bars" aria-hidden="true" />
            </button>
          ) : null}
          <OfficeIdentity variant="header" />
          <div className="app-page-title">
            {icon ? <i className={icon} aria-hidden="true" /> : null}
            <h1>{title}</h1>
          </div>
          <div className="app-header-tools">
            <span className="app-header-clock">{dateTime}</span>
            {account ? (
              <AccountMenu account={account} onProfile={openProfile} onLogout={logout} />
            ) : null}
          </div>
        </header>

        <main className={`page-content app-main ${contentClassName}`}>{children}</main>
        <footer className="app-footer">{OFFICE_IDENTITY.fullName} · {OFFICE_IDENTITY.system}</footer>
      </div>

      {/* Page-specific account management (a doctor's cancellation request) lives in My Profile. */}
      {profileOpen && account ? <ProfileDialog account={account} actions={accountActions} onClose={closeProfile} /> : null}
    </div>
  );
}
