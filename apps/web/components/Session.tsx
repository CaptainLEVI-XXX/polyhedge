'use client';

import { PrivyProvider, usePrivy, useWallets, useLogin } from '@privy-io/react-auth';
import { createContext, useContext, useMemo, useState, useCallback, type ReactNode } from 'react';
import type { WalletFacts } from '@/lib/wallet-readiness';

/**
 * Privy's role is login and owner-key custody. That is all.
 *
 * It does NOT authorise trading. Polymarket's own native session keys do that,
 * and conflating the two is the easiest mistake available here — Privy supplies
 * the embedded wallet whose EOA acts as the Deposit Wallet's **owner**, and the
 * owner is what signs. Until session keys are turned on, the owner signs every
 * order itself.
 *
 * Everything user-scoped reads `useSession()` and nothing touches Privy
 * directly, so what the rest of the app sees is the same shape whether someone
 * is signed in or not.
 */

export interface Session {
  available: boolean;
  error: string | null;
  address: string | null;
  status: 'disconnected' | 'connecting' | 'connected';
  login: () => void;
  logout: () => void;
  /** What readiness needs. Everything unknown is null or false, never assumed. */
  facts: WalletFacts;
}

const SessionContext = createContext<Session>({
  available: false,
  error: null,
  address: null,
  status: 'disconnected',
  login: () => undefined,
  logout: () => undefined,
  facts: {
    address: null,
    provisioned: false,
    approvalsReady: false,
    availableMicros: null,
    pendingDepositMicros: 0,
  },
});

export function useSession(): Session {
  return useContext(SessionContext);
}

function SessionBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, logout } = usePrivy();
  const [error, setError] = useState<string | null>(null);
  const { login: startLogin } = useLogin({
    onComplete: () => setError(null),
    onError: code => setError(code === 'exited_auth_flow' ? null : 'Sign-in did not complete. Please try again.'),
  });
  const login = useCallback(() => { setError(null); startLogin(); }, [startLogin]);
  const { wallets } = useWallets();

  const value = useMemo<Session>(() => {
    const address = authenticated ? (wallets[0]?.address ?? null) : null;
    return {
      available: true,
      error,
      address,
      status: !ready ? 'connecting' : authenticated ? 'connected' : 'disconnected',
      login,
      logout,
      facts: {
        address,
        // Signing in proves who someone is. It does not deploy a Deposit
        // Wallet, grant approvals or put pUSD anywhere — each of those is its
        // own step with its own failure, and claiming them here would mean the
        // UI offers an order the venue then refuses.
        provisioned: false,
        approvalsReady: false,
        availableMicros: null,
        pendingDepositMicros: 0,
      },
    };
  }, [ready, authenticated, wallets, login, logout, error]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  // Without an app id there is no login to offer. The app still works for
  // everything that does not need a wallet, and says so, rather than rendering
  // a button that cannot do anything.
  if (appId === undefined || appId === '') {
    return <>{children}</>;
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        // An embedded wallet for people without one, which is the whole point:
        // the owner key has to exist before a Deposit Wallet can be derived
        // from it.
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
        loginMethods: ['email', 'wallet'],
        appearance: { theme: 'light', accentColor: '#2f5cf5' },
      }}
    >
      <SessionBridge>{children}</SessionBridge>
    </PrivyProvider>
  );
}

/**
 * Signing in, which proves identity and nothing else.
 *
 * Not "connect wallet": no funds move, nothing is provisioned and no approval
 * is granted by this button. Naming it for what it does keeps the later steps —
 * provisioning, approval, a pUSD balance — visible as the separate things they
 * are.
 */
export function Connect() {
  const session = useSession();

  if (!session.available) return <button disabled title="Sign-in is not configured on this deployment">Sign-in unavailable</button>;
  if (session.status === 'connecting') return <button disabled>Loading sign-in…</button>;

  if (session.status !== 'connected') {
    return (
      <span className="sign-in-control"><button className="primary" onClick={session.login} style={{ padding: '8px 16px' }}>
        Sign in
      </button>{session.error && <span role="alert" className="note warn">{session.error}</span>}</span>
    );
  }

  const short = session.address ? `${session.address.slice(0, 6)}…${session.address.slice(-4)}` : 'Signed in';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s3)' }}>
      <span className="tag">{short}</span>
      <button onClick={session.logout} style={{ padding: '8px 14px' }}>
        Sign out
      </button>
    </span>
  );
}
