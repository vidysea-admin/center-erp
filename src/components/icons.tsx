// Lucide-style stroke icons, inline SVG — no icon library dependency.
import { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };
const I = ({ size = 18, children, ...rest }: P & { children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...rest}>{children}</svg>
);

export const IconHome = (p: P) => <I {...p}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M9 21v-6h6v6" /></I>;
export const IconSync = (p: P) => <I {...p}><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></I>;
export const IconPin = (p: P) => <I {...p}><path d="M12 21s-7-5.3-7-11a7 7 0 0 1 14 0c0 5.7-7 11-7 11Z" /><circle cx="12" cy="10" r="2.5" /></I>;
export const IconUser = (p: P) => <I {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" /></I>;
export const IconUsers = (p: P) => <I {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" /><path d="M18.2 15.1c2 .8 3.3 2.4 3.3 4.9" /></I>;
export const IconCap = (p: P) => <I {...p}><path d="m2 9 10-5 10 5-10 5L2 9Z" /><path d="M6 11.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-4.5" /><path d="M22 9v5" /></I>;
export const IconWallet = (p: P) => <I {...p}><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M3 10h18" /><path d="M16.5 15h.01" /></I>;
export const IconGear = (p: P) => <I {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" /></I>;
export const IconSearch = (p: P) => <I {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></I>;
export const IconMenu = (p: P) => <I {...p}><path d="M4 6h16M4 12h16M4 18h16" /></I>;
export const IconX = (p: P) => <I {...p}><path d="M18 6 6 18M6 6l12 12" /></I>;
export const IconLogout = (p: P) => <I {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></I>;
export const IconChevronDown = (p: P) => <I {...p}><path d="m6 9 6 6 6-6" /></I>;
export const IconAlert = (p: P) => <I {...p}><path d="M12 3 2 21h20L12 3Z" /><path d="M12 10v5" /><path d="M12 18.5h.01" /></I>;
export const IconDoc = (p: P) => <I {...p}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" /><path d="M14 3v6h6" /></I>;
export const IconCalendar = (p: P) => <I {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /></I>;
export const IconTrendUp = (p: P) => <I {...p}><path d="m3 17 6-6 4 4 8-8" /><path d="M14 7h7v7" /></I>;
export const IconTrendDown = (p: P) => <I {...p}><path d="m3 7 6 6 4-4 8 8" /><path d="M14 17h7v-7" /></I>;
export const IconBuilding = (p: P) => <I {...p}><rect x="4" y="3" width="16" height="18" rx="1.5" /><path d="M9 21v-4h6v4" /><path d="M8 7h.01M12 7h.01M16 7h.01M8 11h.01M12 11h.01M16 11h.01M8 15h.01M16 15h.01" /></I>;
