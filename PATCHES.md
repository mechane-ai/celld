# Mechane Celld distribution

This is an explicitly modified distribution of denoland/celld v0.6.3. Upstream
LICENSE, NOTICE, and source attribution remain intact. Mechane and Cogent consume
published binaries from this repository; neither consumer applies local patches.

Version `0.6.3-mechane.4` extends the published `.3` source
`5931b0cb32ac49e107c213a6f5f164ce4045c6f4` with local persistent directories,
container-bound HTTP interception, startup-aware native execution, and Cloudflare
RPC disposal metadata on returned objects. The exact `.3` source is recorded by
the release tag; candidate manifests identify the complete source tree.

The [container guide](docs/services/containers.md) owns the supported boundaries.
The `shared_container.mjs` system flow exercises cold execution, isolated files,
container replacement, runtime restart, authenticated intercepts, concurrent
requests, and RPC disposal on real Docker and Worker instances. Existing native
host-service, image identity, module inventory, storage, and network checks remain
required. Mac Docker qualification uses downloaded release candidate bytes.

Previous corrections include PostgreSQL net/TLS compatibility, FIFO input gates,
Docker image and container identity, TCP and R2 stream ownership, live event
origins, explicit operator host-service grants, and unbundled module inventory.
The upstream base is `8702f6d186c77698dbfb30cf29e3b1922a88f008`.

Candidate CI records source/tree, compiler, dependency lock, raw and compressed
hashes, check evidence, and provenance. A version in source is not evidence of a
published or qualified binary. Prior releases and their qualification are
immutable. Runtime corrections belong here or upstream, not application overlays.
