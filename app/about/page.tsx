import { Link } from "react-router-dom";
import Sigil, { type SigilName } from "../components/ui/Sigil";
import "./poster.css";

const keys: { name: SigilName; label: string; note: string }[] = [
  { name: "sun", label: "Sun", note: "Direct exposure" },
  { name: "shade", label: "Shade", note: "Building shadow" },
  { name: "tree", label: "Trees", note: "Canopy estimate" },
  { name: "rain", label: "Rain", note: "Shelter estimate" },
  { name: "transit", label: "Transit", note: "Line and stop" },
  { name: "walk", label: "Walk", note: "On foot" },
];

export default function About() {
  return (
    <main className="about-poster min-h-screen bg-ground p-3 text-ink font-sans md:p-8">
      <div className="mx-auto max-w-6xl border-2 border-ink bg-panel shadow-hard-2">
        <header className="flex items-center justify-between gap-3 border-b-2 border-ink px-4 py-2 md:px-7">
          <span className="font-label text-caption font-extrabold uppercase tracking-widest">UMBRA / FIELD GUIDE / 02</span>
          <Link to="/" className="flex min-h-11 shrink-0 items-center font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current">← Back to map</Link>
        </header>

        <section className="grid border-b-2 border-ink md:grid-cols-5" aria-labelledby="about-title">
          <div className="min-w-0 px-5 py-10 md:col-span-3 md:px-12 md:py-16">
            <span className="inline-block bg-ink px-2 py-1 font-label text-caption font-extrabold uppercase tracking-wider text-on-ink" style={{ rotate: "var(--angle-label)" }}>A guide to the sun side of the street</span>
            <h1 id="about-title" className="mt-5 font-display font-semibold leading-none" style={{ fontSize: "clamp(5rem, 15vw, 11rem)" }}>Umbra<span className="text-sun">.</span></h1>
            <p className="mt-5 max-w-xl font-display text-4xl leading-tight font-semibold">Route planning with the changing shade in view.</p>
            <p className="mt-5 max-w-xl text-base leading-relaxed">Umbra draws building shadows for a selected time and compares walking routes by their estimated sun exposure. You can plan stops, inspect tradeoffs and bring a route along.</p>
          </div>
          <div className="flex min-h-64 flex-col items-center justify-center gap-5 border-t-2 border-ink bg-ink p-7 text-sun-bright md:col-span-2 md:border-t-0 md:border-l-2">
            <div className="w-3/4 border-t-2 border-current" />
            <Sigil name="disc" size={180} />
            <span className="font-label text-caption font-extrabold uppercase tracking-widest text-on-ink">The sun / its shadow</span>
          </div>
        </section>

        <section className="grid border-b-2 border-ink md:grid-cols-3" aria-labelledby="about-method-title">
          <div className="border-b-2 border-ink p-6 md:border-r-2 md:border-b-0">
            <span className="font-label text-caption font-extrabold uppercase tracking-widest">01 / THE METHOD</span>
            <h2 id="about-method-title" className="mt-4 font-display text-4xl leading-none font-semibold">Read the street.<br />Choose the route.</h2>
          </div>
          <ol className="grid md:col-span-2 md:grid-cols-3">
            <li className="border-b border-rule p-5 md:border-r md:border-b-0"><span className="font-label text-3xl text-sun">01</span><h3 className="mt-5 font-semibold">Set a time</h3><p className="mt-2 text-sm leading-relaxed text-ink-muted">The sun position changes the shadow drawn on the map.</p></li>
            <li className="border-b border-rule p-5 md:border-r md:border-b-0"><span className="font-label text-3xl text-sun">02</span><h3 className="mt-5 font-semibold">Compare routes</h3><p className="mt-2 text-sm leading-relaxed text-ink-muted">See route time and estimated sun exposure side by side.</p></li>
            <li className="p-5"><span className="font-label text-3xl text-sun">03</span><h3 className="mt-5 font-semibold">Check the basis</h3><p className="mt-2 text-sm leading-relaxed text-ink-muted">Look for unknown stretches and the source behind each estimate.</p></li>
          </ol>
        </section>

        <section className="grid border-b-2 border-ink md:grid-cols-3" aria-labelledby="about-key-title">
          <div className="border-b-2 border-ink p-6 md:border-r-2 md:border-b-0">
            <span className="font-label text-caption font-extrabold uppercase tracking-widest">02 / THE SYMBOLS</span>
            <h2 id="about-key-title" className="mt-4 font-display text-4xl leading-none font-semibold">The field key</h2>
          </div>
          <ul className="grid grid-cols-2 md:col-span-2 md:grid-cols-3">
            {keys.map((key) => <li key={key.name} className="flex min-h-24 items-center gap-3 border-r border-b border-rule p-3">
              <Sigil name={key.name} size={28} className="shrink-0" />
              <span><strong className="block">{key.label}</strong><span className="block text-xs text-ink-muted">{key.note}</span></span>
            </li>)}
          </ul>
        </section>
        <footer className="flex flex-col gap-2 p-5 text-xs text-ink-muted md:flex-row md:items-center md:justify-between">
          <p className="max-w-2xl">Shadow, canopy, shelter, weather and place data can be incomplete or delayed. Check conditions outdoors.</p>
          <a href="https://github.com/marcopolocheung/umbra" target="_blank" rel="noreferrer" className="flex min-h-11 items-center font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current">Open source on GitHub ↗</a>
        </footer>
      </div>
    </main>
  );
}
