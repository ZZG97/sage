import { NavLink, Outlet } from 'react-router-dom';
import { clsx } from 'clsx';
import { type FormEvent, useEffect, useState } from 'react';
import { httpAuth, SageApiError } from '../lib/api';

const navItems = [
  { to: '/management', label: 'Management' },
  { to: '/operations', label: 'Operations' },
  { to: '/scheduler', label: 'Scheduler' },
  { to: '/health-dashboard', label: 'Health' },
  { to: '/debug', label: 'Debug' },
];

export function Layout() {
  const [authRequired, setAuthRequired] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [authError, setAuthError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function loadAuthStatus() {
      try {
        const status = await httpAuth.getStatus();
        if (!cancelled) {
          setAuthRequired(status.authRequired);
          setAuthenticated(status.authenticated);
          setAuthError(status.configured ? '' : '未配置服务端 Token');
        }
      } catch (error) {
        if (!cancelled) {
          setAuthRequired(true);
          setAuthenticated(false);
          setAuthError(error instanceof Error ? error.message : String(error));
        }
      }
    }
    loadAuthStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleTokenSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = tokenInput.trim();
    if (!token) return;

    try {
      setAuthError('');
      await httpAuth.createSession(token);
      const status = await httpAuth.getStatus();
      setAuthRequired(status.authRequired);
      setAuthenticated(status.authenticated);
      setTokenInput('');
      if (!status.authenticated) {
        setAuthError('Token 未通过校验');
      }
    } catch (error) {
      setAuthenticated(false);
      setAuthError(error instanceof SageApiError && error.status === 401
        ? 'Token 不正确'
        : error instanceof Error ? error.message : String(error));
    }
  }

  async function handleLogout() {
    setAuthenticated(false);
    setTokenInput('');
    setAuthError('');
    await httpAuth.clearSession().catch(() => undefined);
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-[var(--color-border)] px-6 py-3 flex items-center gap-8">
        <h1 className="text-lg font-bold tracking-tight">Sage</h1>
        <nav className="flex gap-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                clsx(
                  'px-3 py-1.5 rounded-md text-sm transition-colors',
                  isActive
                    ? 'bg-[var(--color-primary)] text-white'
                    : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        {authRequired && (
          <div className="ml-auto flex items-center gap-2">
            {authenticated ? (
              <>
                <span className="text-xs text-[var(--color-success)]">Authed</span>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="px-2.5 py-1 rounded-md border border-[var(--color-border)] text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
                >
                  Clear
                </button>
              </>
            ) : (
              <form onSubmit={handleTokenSubmit} className="flex items-center gap-2">
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.target.value)}
                  placeholder="HTTP token"
                  className="w-40 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-card)] px-2.5 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-primary)]"
                />
                <button
                  type="submit"
                  className="px-2.5 py-1 rounded-md bg-[var(--color-primary)] text-xs text-white hover:bg-[var(--color-primary-light)]"
                >
                  Unlock
                </button>
                {authError && <span className="text-xs text-[var(--color-danger)]">{authError}</span>}
              </form>
            )}
          </div>
        )}
      </header>

      {/* Content */}
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
