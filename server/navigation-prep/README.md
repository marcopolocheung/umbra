# NYC navigation preparation

This package owns the offline preparation contract for the static NYC walking graph and
building-prism dataset. It is intentionally separate from `server/transit-prep` and from the
`_shadow`/SMB terrain pipeline.

Session 1 only provides a deterministic fixture and contract round trip. Raw source downloads
and citywide generation are deliberately not part of this PR. Full preparation will keep raw
inputs and generated artifacts outside git under a future `NAVIGATION_PREP_ROOT`.

```sh
npm run plan
npm test
npm run fixture
```

The plan command prints the pinned source locations and an external prep-root layout without
reaching the network. The fixture command prints a compact generation summary and also never
reaches the network. The real
producer will record dated OSM PBF and NYC Building Footprints receipts before accepting a
generation, and will publish OSM attribution/ODbL notices with every generation.
