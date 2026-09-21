import { SessionProvider } from '@/components/Session';
import { Studio } from '@/components/Studio';

export default function Home() {
  return (
    <SessionProvider>
      <Studio />
    </SessionProvider>
  );
}
