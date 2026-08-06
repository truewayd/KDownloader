# KDownloader monorepo

This repository contains two independently released download tools:

- KDownloader, a Chrome Manifest V3 extension in the repository root.
- TrueDown, a Windows Go application in `truedown/`.

Changes under the KDownloader runtime and release paths publish a KDownloader
release. Changes under `truedown/` publish a TrueDown release. When a commit
changes both products, both GitHub Actions workflows run.
