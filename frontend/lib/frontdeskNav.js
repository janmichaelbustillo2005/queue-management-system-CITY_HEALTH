export function frontdeskSidebarLinks(activePath) {
  return [
    {
      href: "/fill-up_form",
      icon: "fas fa-user-plus",
      label: "Patient Registration",
      active: activePath === "/fill-up_form"
    },
    {
      href: "/patient-management",
      icon: "fas fa-hospital-user",
      label: "Patient Management",
      active: activePath === "/patient-management"
    }
  ];
}
