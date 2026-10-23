import { OFFICE_IDENTITY, SYSTEM_BRANDING } from "../lib/branding";

export default function SystemLogo({ variant = "header", className = "", decorative = false }) {
  return (
    <img
      src={SYSTEM_BRANDING.logoSrc}
      alt={decorative ? "" : SYSTEM_BRANDING.logoAlt}
      width={SYSTEM_BRANDING.logoWidth}
      height={SYSTEM_BRANDING.logoHeight}
      className={`system-logo system-logo--${variant}${className ? ` ${className}` : ""}`}
      decoding="async"
      draggable={false}
    />
  );
}

// Logo plus the office name, the same wording everywhere it appears. Narrow
// screens drop the second and third lines, never the office name itself.
export function OfficeIdentity({ variant = "header" }) {
  return (
    <div className={`office-identity office-identity--${variant}`}>
      {/* The office name is right beside it, so the logo is decorative here. */}
      <SystemLogo variant={variant} decorative />
      <div className="office-identity-text">
        <span className="office-identity-name">{OFFICE_IDENTITY.name}</span>
        <span className="office-identity-center">{OFFICE_IDENTITY.center}</span>
        {variant === "sidebar" ? <span className="office-identity-system">{OFFICE_IDENTITY.system}</span> : null}
      </div>
    </div>
  );
}
