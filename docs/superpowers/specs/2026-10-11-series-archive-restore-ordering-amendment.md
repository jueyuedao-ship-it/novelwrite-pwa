# Series Archive Restore Ordering Amendment

Status: Approved integration amendment
Date: 2026-10-11

This amendment supersedes the Work-ordering statements in `2026-10-10-series-archive-restore-design.md` and its implementation plan where they say Series archives must sort Works by Work ID.

## Reason

After the restore design was approved, `main` gained user-controlled Work ordering (`series-ordering.js`). Series ZIP export now preserves the Series' visible Work order rather than re-sorting by ID. Restore must preserve that order as part of the backup/restore round trip.

## Final ordering contract

- `fumizukue-series-archive` remains format version `1`.
- `manifest.works` order is authoritative and represents the Series' visible Work order at export time.
- Nested paths remain canonical by manifest position: `works/0001.zip`, `works/0002.zip`, and so on.
- Work IDs must be unique, but they are not required to be lexicographically sorted.
- Series archive import returns validated Work packages in manifest order.
- Atomic restore assigns persisted Work `order` values from manifest position so the visible order is reproduced after restore.
- `inspectSeriesRestore().targetWorkIds` may sort local IDs internally for deterministic membership comparison; this does not alter restored display order.

## Test adjustment

The archive tests must verify that a deliberately non-ID-sorted input order round-trips unchanged. Tests must reject duplicate IDs and non-canonical paths, but must not reject a valid manifest merely because its Work IDs are not lexicographically sorted.

All other requirements in the approved restore design and implementation plan remain unchanged.
