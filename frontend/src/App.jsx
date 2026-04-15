import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";

import DoctorDashboard from "./pages/DoctorDashboard";
import HomePage from "./pages/HomePage";
import PatientDashboard from "./pages/PatientDashboard";
import ThirdPartyVerifierPage from "./pages/ThirdPartyVerifierPage";
import { useMetaMask } from "./hooks/useMetaMask";
import { getWalletRole, upsertWalletRole } from "./services/api";
import { buildWalletRoleTypedData, signTypedData } from "./services/eip712";

const ROLE_LABELS = {
  doctor: "Doctor",
  patient: "Patient",
  verifier: "Third-Party Verifier",
};

const ROLE_PATHS = {
  doctor: "/doctor",
  patient: "/patient",
  verifier: "/verifier",
};

function truncateAddress(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getRolePath(role) {
  return ROLE_PATHS[role] || "/";
}

function AccessRoute({ account, walletRole, requiredRole, children }) {
  const location = useLocation();
  const nextPath = encodeURIComponent(`${location.pathname}${location.search}`);

  if (!account) {
    return <Navigate to={`/?next=${nextPath}`} replace />;
  }

  if (!walletRole) {
    return <Navigate to={`/?next=${nextPath}`} replace />;
  }

  if (walletRole !== requiredRole) {
    return <Navigate to={getRolePath(walletRole)} replace />;
  }

  return children;
}

function NavLink({ to, label }) {
  const location = useLocation();
  const isActive = location.pathname === to;

  return (
    <Link
      to={to}
      className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
        isActive
          ? "bg-white/20 text-white"
          : "bg-white/5 text-slate-200 hover:bg-white/15 hover:text-white"
      }`}
    >
      {label}
    </Link>
  );
}

export default function App() {
  const [searchParams] = useSearchParams();
  const [walletRole, setWalletRole] = useState(null);
  const [isRoleLoading, setIsRoleLoading] = useState(false);
  const [roleError, setRoleError] = useState("");
  const [isAssigningRole, setIsAssigningRole] = useState(false);

  const {
    account,
    isSepolia,
    connectWallet,
    switchWalletAccount,
    switchToSepolia,
    requiredChainId,
    isConnecting,
    walletError,
  } = useMetaMask();

  const rolePath = useMemo(() => getRolePath(walletRole), [walletRole]);

  useEffect(() => {
    if (!account) {
      setWalletRole(null);
      setRoleError("");
      return;
    }

    let isMounted = true;

    const run = async () => {
      try {
        setIsRoleLoading(true);
        setRoleError("");

        const response = await getWalletRole(account);
        if (!isMounted) return;

        setWalletRole(response.role || null);
      } catch (error) {
        if (!isMounted) return;
        setRoleError(error?.message || "Failed to load wallet role.");
      } finally {
        if (isMounted) {
          setIsRoleLoading(false);
        }
      }
    };

    run();

    return () => {
      isMounted = false;
    };
  }, [account]);

  const handleAssignRole = async (role) => {
    if (!account) {
      return;
    }

    try {
      setIsAssigningRole(true);
      setRoleError("");

      const nonce = `${Date.now()}`;
      const typedData = buildWalletRoleTypedData({
        walletAddress: account,
        role,
        nonce,
      });
      const signature = await signTypedData(account, typedData);

      await upsertWalletRole({
        wallet_address: account,
        role,
        signature,
        nonce,
      });

      setWalletRole(role);
    } catch (error) {
      setRoleError(error?.message || "Failed to set wallet role.");
    } finally {
      setIsAssigningRole(false);
    }
  };

  const roleBadge = walletRole ? ROLE_LABELS[walletRole] : "No role";
  const requiredNetworkLabel = requiredChainId === 11155111 ? "Sepolia" : `Chain ${requiredChainId}`;
  const requestedPath = searchParams.get("next") || "";
  const safeRequestedPath = requestedPath.startsWith("/") ? requestedPath : "";

  const targetPathAfterRole = useMemo(() => {
    if (!walletRole) {
      return "/";
    }

    const defaultPath = getRolePath(walletRole);
    if (!safeRequestedPath) {
      return defaultPath;
    }

    if (safeRequestedPath.startsWith(defaultPath)) {
      return safeRequestedPath;
    }

    return defaultPath;
  }, [walletRole, safeRequestedPath]);

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 soft-grid opacity-30" />

      <header className="sticky top-0 z-20 border-b border-white/15 bg-slate-950/40 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <Link to="/" className="font-heading text-xl font-bold tracking-tight text-white">
            RAPHA<span className="gradient-text">Medical</span>
          </Link>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold text-slate-100">
              {roleBadge}
            </span>

            {walletRole && <NavLink to={rolePath} label="My Page" />}

            <button
              type="button"
              onClick={connectWallet}
              disabled={isConnecting}
              className="rounded-full bg-cyan-300 px-4 py-2 text-xs font-bold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {account ? truncateAddress(account) : "Connect Wallet"}
            </button>

            {account && (
              <button
                type="button"
                onClick={switchWalletAccount}
                className="rounded-full border border-cyan-200/60 bg-cyan-300/10 px-3 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-300/20"
              >
                Switch Wallet
              </button>
            )}

            {account && !isSepolia && (
              <button
                type="button"
                onClick={switchToSepolia}
                className="rounded-full border border-orange-200/60 bg-orange-200/10 px-3 py-2 text-xs font-semibold text-orange-100 hover:bg-orange-200/20"
              >
                {`Switch ${requiredNetworkLabel}`}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6 lg:px-8">
        {(walletError || roleError) && (
          <div className="mb-6 rounded-xl border border-red-200/40 bg-red-500/10 p-3 text-sm text-red-100">
            {walletError || roleError}
          </div>
        )}

        <Routes>
          <Route
            path="/"
            element={
              !account ? (
                <HomePage />
              ) : isRoleLoading ? (
                <section className="panel rounded-3xl p-8 text-center shadow-glow">
                  <p className="text-sm text-slate-200">Loading wallet role...</p>
                </section>
              ) : !walletRole ? (
                <section className="panel rounded-3xl p-6 shadow-glow sm:p-8">
                  <h1 className="font-heading text-3xl font-bold text-white">Select Role for This Wallet</h1>
                  <p className="mt-2 max-w-2xl text-sm text-slate-200">
                    This wallet has no role yet. Choose one role so the app can open the correct page
                    automatically on next login.
                  </p>

                  <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    {[
                      { value: "doctor", label: "Doctor" },
                      { value: "patient", label: "Patient" },
                      { value: "verifier", label: "Third-Party Verifier" },
                    ].map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => handleAssignRole(item.value)}
                        disabled={isAssigningRole}
                        className="rounded-2xl border border-white/20 bg-white/5 p-4 text-left text-slate-100 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <p className="text-sm font-bold uppercase tracking-[0.08em]">{item.label}</p>
                        <p className="mt-2 text-xs text-slate-300">Use this wallet primarily as {item.label}.</p>
                      </button>
                    ))}
                  </div>

                  <p className="mt-4 text-xs text-slate-300">
                    {isAssigningRole
                      ? "Waiting for wallet signature to save role..."
                      : "Role change requires wallet signature for proof of ownership."}
                  </p>

                  {safeRequestedPath && (
                    <p className="mt-2 text-xs text-slate-300">
                      After role setup, you will return to the shared verification link automatically.
                    </p>
                  )}
                </section>
              ) : (
                <Navigate to={targetPathAfterRole} replace />
              )
            }
          />

          <Route
            path="/doctor"
            element={
              <AccessRoute account={account} walletRole={walletRole} requiredRole="doctor">
                <DoctorDashboard />
              </AccessRoute>
            }
          />
          <Route
            path="/patient"
            element={
              <AccessRoute account={account} walletRole={walletRole} requiredRole="patient">
                <PatientDashboard />
              </AccessRoute>
            }
          />
          <Route
            path="/verifier"
            element={
              <AccessRoute account={account} walletRole={walletRole} requiredRole="verifier">
                <ThirdPartyVerifierPage />
              </AccessRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
