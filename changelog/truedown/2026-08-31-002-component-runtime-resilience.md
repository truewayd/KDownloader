# Component runtime resilience

- Synchronized the canonical component runtime's guarded stylesheet adoption,
  pointer audit, isolated-world Shadow hydration, and verified action/dialog
  factories into the embedded dashboard asset.
- Kept TrueDown's native Light DOM controls and dashboard appearance unchanged;
  the new recovery path applies only when a Shadow action component is created.

## Verification

```text
npm run ui:check
npm test
cd truedown
go test ./...
go vet ./...
```
