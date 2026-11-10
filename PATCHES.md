# Mechane interim celld fork

This is an explicitly modified fork of denoland/celld v0.6.3. The upstream
LICENSE, NOTICE, and source attribution are preserved. Version
`0.6.3-mechane.3` is an unreleased candidate based on the published `.2` source
`ba63861d7b786a71c41aadde610e5daa8f7b9ee5`.

The candidate adds an operator-only declaration of local host-service TCP
ports. Linux guests receive an explicit mapping to their selected bridge
gateway, and the existing fence admits only declared interface/address/port
tuples. Grants and opted-in guest/helper cleanup belong to the stable node
state directory. Managed cleanup errors reach the CLI exit status. Worker
options and environment cannot widen native grants. The
[container guide](docs/services/containers.md#local-host-services) records the
shared-bridge scope, forced-exit recovery, and Docker Desktop limits.

The candidate also supports explicit additional module inventories for
`no_bundle`, using `find_additional_modules`, `rules`, and `base_dir`.
Module names, types, and original bytes are retained through ordinary Worker
and Durable Object loading. The [module guide](docs/wasm.md) describes the
opt-in configuration and refused inventories.

The published `.2` release and its qualification remain an immutable prior
baseline. They do not qualify these new paths or candidate binaries. Native
candidate CI records the exact source/tree, compiler, dependency lock, raw and
compressed artifact hashes, checks, and provenance before publication review.
The Docker-backed Mac qualification runs separately on the downloaded,
verified Mac release bytes. No `.3` tag or release is implied by this file.

Earlier fork corrections cover PostgreSQL net/TLS compatibility, FIFO input
gates, Docker image and container identity, TCP and R2 stream ownership, and
live event origins. The upstream base is
`8702f6d186c77698dbfb30cf29e3b1922a88f008`; `.2` retains the clean contribution
through `0a3520d82fc8c2546a68eb66f184e8676b110d8d` plus explicit fork release
metadata. Existing `.2` evidence and assets remain labeled with those exact
versions and byte identities.
