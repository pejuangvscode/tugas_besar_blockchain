import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";

import DoctorDashboard from "./pages/DoctorDashboard";
import HomePage from "./pages/HomePage";
import PatientDashboard from "./pages/PatientDashboard";

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
  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 soft-grid opacity-30" />

      <header className="sticky top-0 z-20 border-b border-white/15 bg-slate-950/40 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <Link to="/" className="font-heading text-xl font-bold tracking-tight text-white">
            RAPHA<span className="gradient-text">MEDICAL</span>
          </Link>

          <nav className="flex items-center gap-2">
            <NavLink to="/doctor" label="Doctor" />
            <NavLink to="/patient" label="Patient" />
          </nav>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6 lg:px-8">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/doctor" element={<DoctorDashboard />} />
          <Route path="/patient" element={<PatientDashboard />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
