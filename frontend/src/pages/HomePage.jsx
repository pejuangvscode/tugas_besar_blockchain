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
        <div className="absolute -right-10 top-8 h-32 w-32 rounded-full bg-cyan-300/30 blur-3xl" />
        <div className="absolute -left-10 bottom-2 h-36 w-36 rounded-full bg-orange-300/20 blur-3xl" />

        <p className="mb-3 inline-flex rounded-full border border-cyan-200/50 bg-cyan-200/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] text-cyan-100">
          Decentralized Medical Ledger
        </p>
        <h1 className="max-w-3xl font-heading text-4xl font-bold leading-tight sm:text-5xl">
          Clinical records that stay private, verifiable, and owned by patients.
        </h1>
        <p className="mt-4 max-w-2xl text-base text-slate-200 sm:text-lg">
          A full-stack DApp combining AES encryption, Merkle integrity proofs, Ethereum anchoring,
          and zk-SNARK certificates for trust-minimized healthcare record workflows.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            to="/doctor"
            className="rounded-full bg-cyan-300 px-5 py-3 text-sm font-bold text-slate-950 transition hover:bg-cyan-200"
          >
            Open Doctor Page
          </Link>
          <Link
            to="/patient"
            className="rounded-full border border-white/25 bg-white/10 px-5 py-3 text-sm font-bold text-white transition hover:bg-white/20"
          >
            Open Patient Page
          </Link>
          <Link
            to="/verifier"
            className="rounded-full border border-orange-200/40 bg-orange-300/10 px-5 py-3 text-sm font-bold text-orange-100 transition hover:bg-orange-300/20"
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
            <h2 className="font-heading text-xl font-semibold text-white">{pillar.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-200">{pillar.description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
