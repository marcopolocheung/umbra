# C5 claim receipts

The assistant's correctness object is an evidence graph, not model prose. Each executed public
tool result is wrapped in a `ToolResultEnvelope` with a deterministic result id, production time,
and (for routes) C4's `requestId`, `actionId`, and `planRevision`. Cache hits reuse that envelope
and id; they do not create a second observation.

The model may propose receipts, but it never supplies presentation prose. `verifyAnswer` ignores
all model text and unknown blocks, then deterministically renders only canonical receipt labels or
a small fixed notice/unknown vocabulary. It rebuilds claim receipts only when their evidence is
compatible: a place's canonical subject comes from the exact matching geocode/search item (never
the pin label), shadow needs its own matching coordinate/time observation and application-owned
shadow target, time needs the latest matching `set_time`, and route completion needs C4's
`completed` terminal result at the routing owner's current revision. A partial route remains
partial; cancelled, error, no-plan, malformed, and superseded results cannot become completion
claims.

Malformed JSON and every model-authored factual or unknown block fail closed. The application uses
a deterministic evidence-derived fallback rather than retrying the model, so C6's request budget
is unchanged. Stored and cached envelopes pass a runtime shape boundary; cache hits retain their
original result id, reset clears the cache/evidence graph, and injected result ids remain monotonic
for the hook lifetime. Receipts are revalidated against current pins and the route owner's current
revision before every render. The panel exposes source/version, observation time, confidence,
evidence id, and rejection reason, and sends opaque map-object ids back to the application map
owner for focusing; the verifier has no map mutation authority.

The deterministic suite reports proposed, supported, rejected, and unknown counts plus a support
rate separately for place, shadow, time, route, and accessibility claims. `unsupportedClaimEscapes`
is zero by construction only because model prose is never rendered; discarded prose is separately
counted as `rejectedUnsupportedProse`. These are development-suite measures, not C13 held-out or
production-grounding claims.

The current tools cannot verify accessibility, venue hours, live crowding, temporary closures,
or physical conditions outside their sampled shadow and route data. Accessibility is therefore
explicitly unknown in C5. C10's trusted/untrusted authority boundary, C12 visual observations,
C13 held-out evaluation, and C15's full assistive-technology workflow remain separate work.
