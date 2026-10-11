# Independent Go MEGA provider prototype

- Add a separately built and versioned Go executable for anonymous MEGA public
  files, with no JavaScript runtime, native SDK or developer application key.
- Add private framed process communication, bounded metadata resolution,
  streaming decryption, complete MAC verification, pause/resume and cancellation.
- Verify cryptographic behavior against official SDK and published upstream
  vectors, with Windows/Linux tests and a small public-file native-process check.
- This is development infrastructure only. Production task admission, durable
  recovery, folder/CloudRAID support and signed module installation/update are
  not enabled. Existing desktop download behavior and product version stay unchanged.

## Verification

- Protocol and cryptographic fixtures precede production integration described in the subsequent module release note.
