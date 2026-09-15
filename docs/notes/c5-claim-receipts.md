# C5 claim receipts

The assistant's correctness object is an evidence graph, not model prose. Each executed public
tool result is wrapped in a `ToolResultEnvelope` with a deterministic result id, production time,
and (for routes) C4's `requestId`, `actionId`, and `planRevision`. Cache hits reuse that envelope
and id; they do not create a second observation.

The write model proposes a `VerifiedAnswer`: connective text, claim references, explicit-unknown
blocks, and receipt proposals. `verifyAnswer` is deterministic and runs before display. It rebuilds
canonical claim receipts only when their evidence is compatible: places need a matching geocode or
search result *and* pin, shadow needs its own matching coordinate/time observation, time needs a
matching `set_time`, and a route completion needs C4's `completed` terminal result at the routing
owner's current revision. A partial route remains partial; cancelled, error, no-plan, malformed,
and superseded results cannot become completion claims.

Malformed JSON and factual prose outside a claim block fail closed. The application uses a
deterministic evidence-derived fallback rather than retrying the model, so C6's request budget is
unchanged. The panel renders the canonical receipts, and sends opaque map-object ids back to the
application's map owner for focusing; the verifier has no map mutation authority.

The current tools cannot verify accessibility, venue hours, live crowding, temporary closures,
or physical conditions outside their sampled shadow and route data. Accessibility is therefore
explicitly unknown in C5. C10's trusted/untrusted authority boundary, C12 visual observations,
C13 held-out evaluation, and C15's full assistive-technology workflow remain separate work.
