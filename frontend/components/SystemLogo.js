import { SYSTEM_BRANDING } from "../lib/branding";

export default function SystemLogo({ variant = "header", className = "" }) {
  return (
    <img
      src={SYSTEM_BRANDING.logoSrc}
      alt={SYSTEM_BRANDING.logoAlt}
      width={SYSTEM_BRANDING.logoWidth}
      height={SYSTEM_BRANDING.logoHeight}
      className={`system-logo system-logo--${variant}${className ? ` ${className}` : ""}`}
      decoding="async"
      draggable={false}
    />
  );
}
