import { AppShell } from "@/components/shell";

// SessionProvider lives in the root layout (src/components/providers.tsx)
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
