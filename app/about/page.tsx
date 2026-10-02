import { useState } from "react";
import { Link } from "react-router-dom";
import Sigil, { type SigilName } from "../components/ui/Sigil";
import "./poster.css";

const keys: { name: SigilName; label: string; note: string; detail: string; tone: string }[] = [
  { name: "sun", label: "Sun", note: "Direct exposure", detail: "The sun mark points to direct light. Its position changes with the time you choose.", tone: "sun" },
  { name: "shade", label: "Shade", note: "Building shadow", detail: "Building shadows are modeled for the selected time, then used to estimate exposure along the walk.", tone: "shade" },
  { name: "tree", label: "Trees", note: "Canopy estimate", detail: "Tree cover is an estimate where canopy data is available. Check what is overhead outdoors.", tone: "canopy" },
  { name: "rain", label: "Rain", note: "Shelter estimate", detail: "The rain mark points to estimated shelter coverage. Weather and shelter data may be incomplete.", tone: "rain" },
  { name: "transit", label: "Transit", note: "Line and stop", detail: "A transit mark identifies a line or stop on a route with a ride segment.", tone: "ink" },
  { name: "walk", label: "Walk", note: "On foot", detail: "The walking mark identifies the part of a route traveled on foot.", tone: "ink" },
];

export default function About() {
  const [selectedKey, setSelectedKey] = useState<SigilName>("shade");
  const reading = keys.find((key) => key.name === selectedKey) ?? keys[1];

  return (
    <main className="about-poster min-h-screen bg-ground p-3 text-ink font-sans md:p-8">
      <div className="mx-auto max-w-6xl border-2 border-ink bg-panel shadow-hard-2">
        <header className="flex items-center justify-between gap-3 border-b-2 border-ink px-4 py-2 md:px-7">
          <span className="font-label text-caption font-extrabold uppercase tracking-widest">UMBRA / FIELD GUIDE / 02</span>
          <Link to="/" className="flex min-h-11 shrink-0 items-center font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current">← Back to map</Link>
        </header>

        <section className="grid border-b-2 border-ink md:grid-cols-5" aria-labelledby="about-title">
          <div className="about-poster__hero-copy min-w-0 px-5 py-10 md:col-span-3 md:px-12 md:py-16">
            <span className="about-poster__kicker inline-block bg-ink px-3 py-2 font-label text-caption font-extrabold uppercase tracking-wider text-on-ink">A guide to the sun side of the street</span>
            <h1 id="about-title" className="about-poster__wordmark mt-5 font-display font-semibold">Umbra<span className="text-sun">.</span></h1>
            <p className="mt-5 max-w-xl font-display text-4xl leading-tight font-semibold">Route planning with the changing shade in view.</p>
            <p className="mt-5 max-w-xl text-base leading-relaxed">Umbra draws building shadows for a selected time and compares walking routes by their estimated sun exposure. You can plan stops, inspect tradeoffs and bring a route along.</p>
          </div>
          <div className="about-poster__hero-mark flex min-h-64 flex-col items-center justify-center gap-5 border-t-2 border-ink p-7 md:col-span-2 md:border-t-0 md:border-l-2">
            <span className="about-poster__mark-label font-label text-caption font-extrabold uppercase tracking-widest">SUN / SHADOW</span>
            <Sigil name="disc" size={180} className="about-poster__disc" />
            <span className="about-poster__mark-caption font-label text-caption font-extrabold uppercase tracking-widest">The same mark, two sides</span>
          </div>
        </section>

        <div className="about-poster__plate-row">
          <div className="about-poster__plate about-poster__plate--sun"><span>01 / THE SUN</span><strong>Time changes the map.</strong></div>
          <div className="about-poster__plate about-poster__plate--shade"><span>02 / THE SHADE</span><strong>Exposure is an estimate.</strong></div>
          <div className="about-poster__plate about-poster__plate--ink"><span>03 / THE ROUTE</span><strong>The choice stays yours.</strong></div>
        </div>

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
            <p className="mt-4 text-sm leading-relaxed text-ink-muted">Choose a mark to read what it means.</p>
          </div>
          <ul className="grid grid-cols-2 md:col-span-2 md:grid-cols-3">
            {keys.map((key) => <li key={key.name} className="border-r border-b border-rule">
              <button type="button" aria-pressed={selectedKey === key.name} aria-controls="about-key-reading" onClick={() => setSelectedKey(key.name)} className="about-poster__key-button flex min-h-24 w-full items-center gap-3 p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-current">
                <Sigil name={key.name} size={28} className="shrink-0" />
                <span><strong className="block">{key.label}</strong><span className="about-poster__key-note block text-xs">{key.note}</span></span>
              </button>
            </li>)}
          </ul>
        </section>
        <section id="about-key-reading" className="about-poster__reading" data-tone={reading.tone} aria-label={`${reading.label} field note`} aria-live="polite">
          <div className="about-poster__reading-icon"><Sigil name={reading.name} size={88} /></div>
          <div className="about-poster__reading-copy umbra-ink-reveal" key={reading.name}>
            <span className="font-label text-caption font-extrabold uppercase tracking-widest">FIELD NOTE / {reading.label.toUpperCase()}</span>
            <h3 className="mt-3 font-display text-4xl font-semibold leading-none">{reading.note}</h3>
            <p className="mt-4 max-w-2xl text-base leading-relaxed">{reading.detail}</p>
          </div>
        </section>
        <footer className="flex flex-col gap-2 p-5 text-xs text-ink-muted md:flex-row md:items-center md:justify-between">
          <p className="max-w-2xl">Shadow, canopy, shelter, weather and place data can be incomplete or delayed. Check conditions outdoors.</p>
          <a href="https://github.com/marcopolocheung/umbra" target="_blank" rel="noreferrer" className="flex min-h-11 items-center font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current">Open source on GitHub ↗</a>
        </footer>
      </div>
    </main>
  );
}
