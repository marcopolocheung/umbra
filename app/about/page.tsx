import { Link } from "react-router-dom";

export default function About() {
  return (
    <div className="min-h-screen bg-canvas text-ink p-8 font-sans">
      <div className="max-w-2xl mx-auto">
        <Link
          to="/"
          className="text-ink-muted text-sm hover:text-ink transition-colors underline-offset-2 mb-8 block"
        >
          ← Map
        </Link>

        <h1 className="text-3xl font-semibold mb-2" style={{ color: "var(--color-ink)" }}>Umbra</h1>
        <p className="text-body text-ink-muted mb-4">
          A personal open-source shadowed-route navigation project.
        </p>

        <section className="mb-10">
          <h2 className="text-eyebrow font-semibold uppercase tracking-wider mb-4 text-chrome">
            What It Does
          </h2>
          <ul className="space-y-2 text-sm text-ink-muted">
            <li>Simulates building shadows on a MapLibre map.</li>
            <li>Finds walking routes with shortest, balanced, and most-shadowed options.</li>
            <li>Shows route tradeoffs such as added time and reduced sun exposure.</li>
            <li>Supports saved routes, shareable map links, and multi-stop route planning.</li>
            <li>Provides cloud-cover context so shadowed routing is easier to trust.</li>
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="text-eyebrow font-semibold uppercase tracking-wider mb-4 text-chrome">
            Built With
          </h2>
          <div className="space-y-3">
            <div className="bg-raised border border-hairline rounded-xl p-4">
              <h3 className="font-medium mb-1 text-ink">MapLibre GL</h3>
              <p className="text-sm text-ink-muted">
                Browser map rendering, camera controls, and vector tile display.
              </p>
            </div>

            <div className="bg-raised border border-hairline rounded-xl p-4">
              <h3 className="font-medium mb-1 text-ink">mapbox-gl-shadow-simulator</h3>
              <p className="text-sm text-ink-muted">
                Local WebGL building-shadow simulation used by the app.
              </p>
            </div>

            <div className="bg-raised border border-hairline rounded-xl p-4">
              <h3 className="font-medium mb-1 text-ink">OpenStreetMap and Open-Meteo</h3>
              <p className="text-sm text-ink-muted">
                Routing/search context and cloud-cover data for route planning.
              </p>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-eyebrow font-semibold uppercase tracking-wider mb-4 text-chrome">
            Project Scope
          </h2>
          <p className="text-sm text-ink-muted">
            Umbra is experimental navigation software. Shadow, route, weather,
            and place data can be incomplete or delayed; use normal judgment outdoors.
          </p>
        </section>
      </div>
    </div>
  );
}
