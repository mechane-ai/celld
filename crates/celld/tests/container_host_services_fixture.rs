// Copyright 2026 Deno Land Inc. Apache-2.0 license.

use anyhow::{ensure, Context};

#[tokio::test]
#[ignore = "invoked only by the Docker-backed host-service fixture"]
async fn publish_local_fixture() -> anyhow::Result<()> {
    let project = std::path::PathBuf::from(
        std::env::var_os("CELLD_HOST_SERVICE_TEST_PROJECT")
            .context("the host-service fixture must supply its temporary project")?,
    );
    let project = std::fs::canonicalize(project)?;
    let parent = project.parent().context("fixture project has no parent")?;
    ensure!(
        parent
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("celld-host-services-")),
        "refuse a non-fixture project"
    );
    let database = project.join(".celld/dev/objects.sqlite3");
    ensure!(
        database.is_file(),
        "the synthetic dev store must already exist"
    );
    let nonce = std::env::var("CELLD_HOST_SERVICE_TEST_NONCE")
        .context("the host-service fixture must supply a publication nonce")?;
    ensure!(!nonce.is_empty(), "the fixture publication nonce is empty");
    celld::asyncrt::set_host_handle(tokio::runtime::Handle::current());
    let bucket = celld::dev::open_local_bucket(&database)?;
    let built = celld::deploy::build(&celld::deploy::Options {
        config: Some(project.join("wrangler.jsonc")),
        bucket: None,
        endpoint: None,
        region: None,
        dry_run: false,
        json: false,
        vars: celld::deploy::VarOverrides::None,
        local_images: true,
    })?;
    celld::deploy::write(&bucket, &built).await?;
    let receipt = serde_json::json!({
        "nonce": nonce,
        "packageVersion": env!("CARGO_PKG_VERSION"),
        "version": built.version,
    });
    std::fs::write(
        project.join("fixture-publication.json"),
        serde_json::to_vec(&receipt)?,
    )?;
    Ok(())
}
