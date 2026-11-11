import { OpsShell } from '@/components/OpsShell';

export default function OpsLayout({ children }: { children: React.ReactNode }) {
  return <OpsShell>{children}</OpsShell>;
}
