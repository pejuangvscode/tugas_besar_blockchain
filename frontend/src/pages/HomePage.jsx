import { Link } from "react-router-dom";

const pillars = [
  {
    title: "Patient Sovereignty",
    description: "Records are encrypted at source and controlled by wallet-based ownership.",
  },
  {
    title: "Integrity Anchoring",
    description: "Merkle roots are anchored on Sepolia, enabling tamper-evident verification.",
  },
  {
    title: "Privacy Proofs",
    description: "Generate zero-knowledge certificates without exposing the underlying note text.",
  },
  {
    title: "Third-Party Validation",
    description:
      "Insurers and auditors can validate integrity packages against on-chain roots.",
  },
];

export default function HomePage() {
  return (
    <section className="animate-fadeInUp space-y-8">
      <div className="panel relative overflow-hidden rounded-3xl p-8 shadow-glow sm:p-12">
        <div className="absolute left-0 top-0 h-1 w-36 rounded-r-full bg-sky-600" />

        <p className="mb-3 inline-flex rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] text-slate-700">
          Decentralized Medical Ledger
        </p>
        <h1 className="max-w-3xl font-heading text-4xl font-bold leading-tight text-slate-900 sm:text-5xl">
          Clinical records that stay private, verifiable, and owned by patients.
        </h1>
        <p className="mt-4 max-w-2xl text-base text-slate-600 sm:text-lg">
          A full-stack DApp combining AES encryption, Merkle integrity proofs, Ethereum anchoring,
          and zk-SNARK certificates for trust-minimized healthcare record workflows.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            to="/doctor"
            className="rounded-full bg-sky-600 px-5 py-3 text-sm font-bold text-slate-50 transition hover:bg-sky-700"
          >
            Open Doctor Page
          </Link>
          <Link
            to="/patient"
            className="rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-bold text-slate-700 transition hover:bg-slate-100"
          >
            Open Patient Page
          </Link>
          <Link
            to="/verifier"
            className="rounded-full border border-slate-300 bg-slate-900 px-5 py-3 text-sm font-bold text-slate-50 transition hover:bg-slate-700"
          >
            Open Third-Party Verifier
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {pillars.map((pillar, index) => (
          <article
            key={pillar.title}
            className="panel rounded-2xl p-5 shadow-glow animate-fadeInUp"
            style={{ animationDelay: `${index * 100}ms` }}
          >
            <h2 className="font-heading text-xl font-semibold text-slate-900">{pillar.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">{pillar.description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
