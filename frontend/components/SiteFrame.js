import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import SystemLogo from "./SystemLogo";

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

export default function SiteFrame({
  title,
  icon,
  welcome,
  children,
  showSidebar = false,
  sidebarLinks = [],
  hideMenu = false,
  onSettings,
  onShowHome,
  onShowQueue,
  sidebarTitle = "Admin Menu",
  showProfileMenu = false,
  profileMenuLinks = [],
  profileIcon = "fas fa-user-md",
  contentClassName = ""
}) {
  const { user, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef(null);
  
  const displayWelcome = welcome || (user ? `Welcome, ${user.role === 'superadmin' ? 'Super Admin' : user.doctor_name || user.id_num}` : "Welcome, Guest");
  const dateTime = useDateTime(
    useMemo(
      () => (date) => `${date.toLocaleTimeString()} - ${date.toLocaleDateString()}`,
      []
    )
  );

  const toggleSidebar = () => setSidebarOpen((current) => !current);
  const toggleProfileMenu = () => setProfileMenuOpen((current) => !current);

  useEffect(() => {
    if (!profileMenuOpen) return undefined;

    function handleClickOutside(event) {
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target)) {
        setProfileMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [profileMenuOpen]);

  return (
    <div className="layout-shell">
      {showSidebar ? (
        <>
          <div id="sidebar" className={`sidebar ${sidebarOpen ? "active" : ""}`}>
            <div className="sidebar-header">
              <div className="sidebar-brand">
                <SystemLogo variant="sidebar" />
                <div className="sidebar-title">{sidebarTitle}</div>
              </div>
              <button className="sidebar-close" onClick={toggleSidebar}>
                <i className="fas fa-times" />
              </button>
            </div>
            <div className="sidebar-menu">
              {onShowHome ? (
                <button className="sidebar-menu-item" onClick={() => { onShowHome(); toggleSidebar(); }}>
                  <i className="fas fa-home mr-3" />
                  Home
                </button>
              ) : null}
              {sidebarLinks.map((link, idx) => {
                const isActive = link.active;
                return link.type === "button" ? (
                  <button
                      key={idx}
                      onClick={() => { link.onClick(); toggleSidebar(); }}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 ${
                        isActive 
                          ? "brand-nav-active font-semibold backdrop-blur-sm shadow-sm"
                          : "text-white hover:bg-white/5"
                      }`}
                    >
                      <i className={`${link.icon} w-5 text-center`} />
                      <span>{link.label}</span>
                    </button>
                  ) : (
                    <Link
                      key={idx}
                      href={link.href}
                      onClick={toggleSidebar}
                      className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 no-underline ${
                        isActive 
                          ? "brand-nav-active font-semibold backdrop-blur-sm shadow-sm"
                          : "text-white hover:bg-white/5"
                      }`}
                    >
                    <i className={`${link.icon} w-5 text-center`} />
                    <span>{link.label}</span>
                  </Link>
                );
              })}
              {onShowQueue ? (
                <button className="sidebar-menu-item" onClick={() => { onShowQueue(); toggleSidebar(); }}>
                  <i className="fas fa-list mr-3" />
                  Queue Management
                </button>
              ) : null}
              {onSettings ? (
                <button className="sidebar-menu-item" onClick={() => { onSettings(); toggleSidebar(); }}>
                  <i className="fas fa-cog mr-3" />
                  Settings
                </button>
              ) : null}
              {user ? (
                <button 
                  className="sidebar-menu-item text-red-400 hover:text-red-300" 
                  onClick={() => { logout(); toggleSidebar(); }}
                >
                  <i className="fas fa-sign-out-alt mr-3" />
                  Logout
                </button>
              ) : null}
            </div>
          </div>
          <div className={`overlay ${sidebarOpen ? "active" : ""}`} onClick={toggleSidebar} />
        </>
      ) : null}

      <header className="site-header mb-4">
        <div className="header-left text-white flex items-center py-1">
          {showSidebar && !hideMenu ? (
            <button className="menu-toggle mr-2" onClick={toggleSidebar}>
              <i className="fas fa-bars" />
            </button>
          ) : null}
          <SystemLogo />
          <span className="text-base md:text-lg font-bold leading-tight break-words">{title}</span>
        </div>
        {showProfileMenu && user ? (
          <div className="header-right text-white py-1 relative" ref={profileMenuRef}>
            <button
              type="button"
              onClick={toggleProfileMenu}
              className="header-profile-button"
              aria-haspopup="menu"
              aria-expanded={profileMenuOpen}
            >
              <span className="flex flex-col items-end min-w-0">
                <span className="header-datetime font-semibold">{dateTime}</span>
                <span className="header-welcome opacity-90">{displayWelcome}</span>
              </span>
              <span className="header-profile-avatar">
                <i className={profileIcon} />
              </span>
              <i className={`fas fa-chevron-down text-[10px] transition-transform ${profileMenuOpen ? "rotate-180" : ""}`} />
            </button>

            {profileMenuOpen ? (
              <div className="header-profile-menu" role="menu">
                {profileMenuLinks.map((link, idx) => (
                  link.type === "button" ? (
                    <button
                      key={idx}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        link.onClick?.();
                      }}
                      className="header-profile-menu-item"
                    >
                      <i className={`${link.icon} w-4 text-center`} />
                      <span>{link.label}</span>
                    </button>
                  ) : (
                    <Link
                      key={idx}
                      href={link.href}
                      role="menuitem"
                      onClick={() => setProfileMenuOpen(false)}
                      className="header-profile-menu-item no-underline"
                    >
                      <i className={`${link.icon} w-4 text-center`} />
                      <span>{link.label}</span>
                    </Link>
                  )
                ))}
                {profileMenuLinks.length ? <div className="header-profile-menu-divider" /> : null}
                <button
                  type="button"
                  role="menuitem"
                  className="header-profile-menu-item text-red-700"
                  onClick={() => {
                    setProfileMenuOpen(false);
                    logout();
                  }}
                >
                  <i className="fas fa-sign-out-alt w-4 text-center" />
                  <span>Logout</span>
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="header-right text-white flex flex-col justify-center py-1">
            <div className="header-datetime font-semibold">{dateTime}</div>
            <div className="header-welcome opacity-90">{displayWelcome}</div>
          </div>
        )}
      </header>

      <main className={`page-content ${sidebarOpen ? "sidebar-active" : ""} ${contentClassName}`}>{children}</main>
      <footer className="site-footer">2025 Smart Queuing System. All rights reserved.</footer>
    </div>
  );
}
