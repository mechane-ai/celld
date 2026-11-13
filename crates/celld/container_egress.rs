use super::*;
use crate::engine_api::{HttpResponse, RequestBody};
use crate::host_channels::{SvcCallReq, SVC_CALL_TX};
use crate::http_streams::{register_body_stream, RequestBodyGuard};
use futures_util::StreamExt;
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rand::RngCore;
use std::convert::Infallible;
use std::sync::atomic::AtomicBool;

const IMAGE: &str = "nginx@sha256:f46cb72c7df02710e693e863a983ac42f6a9579058a59a35f1ae36c9958e4ce0";
static NETWORK_ALLOCATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const TRANSPORT_HEADER: &str = "x-celld-egress-key";
type Body = http_body_util::combinators::UnsyncBoxBody<Bytes, std::io::Error>;

#[derive(Clone)]
pub(crate) struct Route {
    pub generation: crate::generation::GenerationId,
    pub script: String,
    pub entrypoint: crate::WorkerFetchEntrypoint,
}

pub(super) struct Binding {
    host: String,
    key: String,
    pub network: String,
    proxy: String,
    route: RwLock<Route>,
    active: AtomicBool,
    pub run: AtomicU64,
    shutdown: watch::Sender<bool>,
}

impl ContainerEngine {
    pub(crate) async fn intercept_http(
        &self,
        cell: &Arc<CellContainer>,
        host: String,
        route: Route,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.bucket.as_ref().is_none_or(|bucket| matches!(
                bucket.backend,
                crate::bucket::StorageBackend::Local
            )),
            "HTTP interception is local-only"
        );
        let mut slot = cell.egress.lock().await;
        if let Some(binding) = slot.as_ref() {
            anyhow::ensure!(
                binding.host == host,
                "only one exact HTTP host is supported"
            );
            *binding.route.write().unwrap() = route;
            return Ok(());
        }
        self.ensure_fence().await?;
        let image = self
            .docker
            .call("GET", &format!("/images/{IMAGE}/json"), None)
            .await?;
        if !image.status.is_success() {
            let encoded =
                percent_encoding::utf8_percent_encode(IMAGE, percent_encoding::NON_ALPHANUMERIC);
            self.docker
                .expect(
                    "POST",
                    &format!("/images/create?fromImage={encoded}"),
                    None,
                    "pull HTTP proxy image",
                )
                .await?;
            self.docker
                .expect(
                    "GET",
                    &format!("/images/{IMAGE}/json"),
                    None,
                    "verify HTTP proxy image",
                )
                .await?;
        }
        let identity = json!([self.volume_namespace, cell.scope]);
        let digest = format!("{:x}", Sha256::digest(identity.to_string().as_bytes()));
        let network = format!("celld-egress-{}", &digest[..24]);
        let proxy = format!("{}-egress", cell.name);
        let mut random = [0u8; 32];
        asyncrt::rng("container-http-proxy").fill_bytes(&mut random);
        let key: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let listener = tokio::net::TcpListener::bind("0.0.0.0:0").await?;
        let port = listener.local_addr()?.port();
        let (shutdown, mut stopping) = watch::channel(false);
        let binding = Arc::new(Binding {
            host: host.clone(),
            key: key.clone(),
            network: network.clone(),
            proxy: proxy.clone(),
            route: RwLock::new(route),
            active: AtomicBool::new(true),
            run: AtomicU64::new(cell.current_run()),
            shutdown,
        });
        let weak_binding = Arc::downgrade(&binding);
        let weak_cell = Arc::downgrade(cell);
        asyncrt::spawn(async move {
            loop {
                tokio::select! {
                    _ = stopping.changed() => break,
                    accepted = listener.accept() => {
                        let (stream, _) = match accepted {
                            Ok(accepted) => accepted,
                            Err(error) => {
                                tracing::error!(%error, "HTTP intercept listener failed");
                                break;
                            }
                        };
                        let binding = weak_binding.clone();
                        let cell = weak_cell.clone();
                        asyncrt::spawn(async move {
                            let handler = service_fn(move |request| {
                                let binding = binding.upgrade();
                                let cell = cell.upgrade();
                                async move {
                                    let result = match (binding, cell) {
                                        (Some(binding), Some(cell)) => dispatch(request, &binding, &cell).await,
                                        _ => Ok(refused(StatusCode::GONE, "container intercept expired")),
                                    };
                                    let response = match result {
                                        Ok(response) => response,
                                        Err(error) => {
                                            tracing::error!(%error, "HTTP intercept dispatch failed");
                                            refused(StatusCode::BAD_GATEWAY, "container intercept failed")
                                        }
                                    };
                                    Ok::<_, Infallible>(response)
                                }
                            });
                            if let Err(error) = http1::Builder::new().serve_connection(TokioIo::new(stream), handler).await {
                                tracing::debug!(%error, "HTTP intercept connection closed");
                            }
                        }).detach();
                    }
                }
            }
        }).detach();
        *slot = Some(binding.clone());
        let result = self.start_proxy(cell, &binding, port, &key).await;
        drop(slot);
        if result.is_err() {
            stop(&self.docker, cell, binding.run.load(Ordering::Acquire)).await?;
        }
        result
    }

    async fn start_proxy(
        &self,
        cell: &CellContainer,
        binding: &Binding,
        port: u16,
        key: &str,
    ) -> anyhow::Result<()> {
        let digest = format!("{:x}", Sha256::digest(binding.network.as_bytes()));
        let allocation = NETWORK_ALLOCATION.lock().await;
        let networks = self
            .docker
            .expect("GET", "/networks", None, "list network subnets")
            .await?
            .json()?;
        let mut occupied = Vec::new();
        for network in networks.as_array().context("Docker network list")? {
            if let Some(configs) = network.pointer("/IPAM/Config").and_then(Value::as_array) {
                for config in configs {
                    let subnet = config["Subnet"].as_str().context("Docker network subnet")?;
                    let (address, prefix) =
                        subnet.split_once('/').context("Docker subnet prefix")?;
                    let address: std::net::IpAddr = address.parse()?;
                    if let std::net::IpAddr::V4(address) = address {
                        let prefix: u32 = prefix.parse()?;
                        anyhow::ensure!(prefix <= 32, "invalid Docker IPv4 prefix");
                        occupied.push((u32::from(address), prefix));
                    }
                }
            }
        }
        let offset = u16::from_str_radix(&digest[..4], 16)? as u32 % 8192;
        let subnet = (0..8192)
            .map(|step| 0x0afe0000 | (((offset + step) % 8192) << 3))
            .find(|candidate| {
                !occupied.iter().any(|(address, prefix)| {
                    let bits = 29u32.min(*prefix);
                    let mask = if bits == 0 {
                        0
                    } else {
                        u32::MAX << (32 - bits)
                    };
                    candidate & mask == address & mask
                })
            })
            .context("no free /29 HTTP intercept subnet in 10.254.0.0/16")?;
        let subnet = format!("{}/29", std::net::Ipv4Addr::from(subnet));
        self.docker
            .expect(
                "POST",
                "/networks/create",
                Some(json!({
                    "Name": binding.network, "Driver": "bridge", "Internal": true,
                    "IPAM": {"Config": [{"Subnet": subnet}]},
                    "Labels": {"celld.node": self.node, "celld.egress": "1"},
                    "Options": {BRIDGE_NAME_OPTION: format!("ceg{}", &digest[..12])},
                })),
                "create isolated HTTP intercept network",
            )
            .await?;
        drop(allocation);
        let configuration = format!(
            r#"
pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events {{ worker_connections 256; }}
http {{
  access_log off;
  server {{ listen 127.0.0.1:81; return 204; }}
  client_body_temp_path /tmp/client-body;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  client_max_body_size 1g;
  server {{
    listen 80;
    server_name {};
    if ($host != "{}") {{ return 403; }}
    location / {{
      proxy_pass http://host.docker.internal:{port};
      proxy_http_version 1.1;
      proxy_request_buffering off;
      proxy_buffering off;
      proxy_read_timeout 300s;
      proxy_set_header Host $http_host;
      proxy_set_header Connection "";
      proxy_set_header {TRANSPORT_HEADER} "{key}";
    }}
  }}
}}
"#,
            binding.host, binding.host
        );
        self.docker.expect("POST", &format!("/containers/create?name={}", binding.proxy), Some(json!({
            "Image": IMAGE,
            "User": "101",
            "Entrypoint": ["sh", "-c"],
            "Cmd": ["printf '%s' \"$CELLD_EGRESS_CONFIG\" > /tmp/nginx.conf; exec nginx -c /tmp/nginx.conf -g 'daemon off;'"],
            "Env": [format!("CELLD_EGRESS_CONFIG={configuration}")],
            "Labels": {"celld.node": self.node, "celld.cell": cell.scope, "celld.egress": "1"},
            "Healthcheck": {"Test": ["CMD-SHELL", "wget -q --spider http://127.0.0.1:81/"], "Interval": 1000000000, "StartInterval": 100000000, "StartPeriod": 1000000000},
            "HostConfig": {"NetworkMode": "bridge", "ExtraHosts": if cfg!(target_os = "linux") { vec!["host.docker.internal:host-gateway"] } else { vec![] },
                "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges"], "PidsLimit": 32, "Memory": 67108864,
                "Sysctls": {"net.ipv4.ip_unprivileged_port_start": "0"}},
        })), "create HTTP intercept proxy").await?;
        self.docker
            .expect(
                "POST",
                &format!("/networks/{}/connect", binding.network),
                Some(json!({
                    "Container": binding.proxy, "EndpointConfig": {"Aliases": [binding.host]},
                })),
                "attach HTTP intercept proxy",
            )
            .await?;
        self.docker
            .expect(
                "POST",
                &format!("/containers/{}/start", binding.proxy),
                None,
                "start HTTP intercept proxy",
            )
            .await?;
        let mut healthy = false;
        for _ in 0..100 {
            let info = self
                .docker
                .expect(
                    "GET",
                    &format!("/containers/{}/json", binding.proxy),
                    None,
                    "inspect HTTP intercept readiness",
                )
                .await?
                .json()?;
            if info.pointer("/State/Health/Status").and_then(Value::as_str) == Some("healthy") {
                healthy = true;
                break;
            }
            anyhow::ensure!(
                info.pointer("/State/Running").and_then(Value::as_bool) == Some(true),
                "HTTP intercept proxy exited: {}",
                self.logs(&binding.proxy).await?
            );
            asyncrt::sleep(Duration::from_millis(100)).await;
        }
        anyhow::ensure!(healthy, "HTTP intercept proxy did not become ready");
        if self.inspect_running(cell).await?.is_some() {
            self.docker
                .expect(
                    "POST",
                    &format!("/networks/{}/connect", binding.network),
                    Some(json!({
                        "Container": cell.name,
                    })),
                    "attach running container HTTP intercept",
                )
                .await?;
        }
        Ok(())
    }
}

pub(super) async fn stop(docker: &Docker, cell: &CellContainer, run: u64) -> anyhow::Result<()> {
    let mut slot = cell.egress.lock().await;
    if slot
        .as_ref()
        .is_some_and(|binding| binding.run.load(Ordering::Acquire) != run)
    {
        return Ok(());
    }
    if let Some(binding) = slot.take() {
        binding.active.store(false, Ordering::Release);
        binding.shutdown.send_replace(true);
        docker
            .call(
                "POST",
                &format!("/networks/{}/disconnect", binding.network),
                Some(json!({"Container": cell.name, "Force": true})),
            )
            .await?;
        for (path, operation) in [
            (
                format!("/containers/{}?force=true", binding.proxy),
                "remove HTTP intercept proxy",
            ),
            (
                format!("/networks/{}", binding.network),
                "remove HTTP intercept network",
            ),
        ] {
            let reply = docker.call("DELETE", &path, None).await?;
            anyhow::ensure!(
                reply.status.is_success() || reply.status.as_u16() == 404,
                "{operation}: {}",
                reply.message()
            );
        }
    }
    Ok(())
}

fn refused(status: StatusCode, message: &'static str) -> Response<Body> {
    Response::builder()
        .status(status)
        .body(
            Full::new(Bytes::from_static(message.as_bytes()))
                .map_err(|never| match never {})
                .boxed_unsync(),
        )
        .unwrap()
}

async fn dispatch(
    request: Request<Incoming>,
    binding: &Binding,
    cell: &CellContainer,
) -> anyhow::Result<Response<Body>> {
    let valid_key = request
        .headers()
        .get(TRANSPORT_HEADER)
        .is_some_and(|value| {
            use subtle::ConstantTimeEq;
            bool::from(value.as_bytes().ct_eq(binding.key.as_bytes()))
        });
    if !valid_key {
        return Ok(refused(
            StatusCode::FORBIDDEN,
            "invalid intercept transport",
        ));
    }
    if !binding.active.load(Ordering::Acquire)
        || !cell.running()
        || binding.run.load(Ordering::Acquire) != cell.current_run()
    {
        return Ok(refused(StatusCode::GONE, "container intercept expired"));
    }
    let authority = request
        .headers()
        .get(hyper::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if authority != binding.host && authority != format!("{}:80", binding.host) {
        return Ok(refused(
            StatusCode::FORBIDDEN,
            "HTTP intercept host mismatch",
        ));
    }
    let url = format!(
        "http://{}{}",
        binding.host,
        request
            .uri()
            .path_and_query()
            .map_or("/", |part| part.as_str())
    );
    let method = request.method().to_string();
    let headers = request
        .headers()
        .iter()
        .filter(|(name, _)| name.as_str() != TRANSPORT_HEADER)
        .map(|(name, value)| Ok((name.to_string(), value.to_str()?.to_string())))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let limit = crate::env_vars::positive_or(
        "CELLD_MAX_REQUEST_BODY_BYTES",
        crate::actor::DEFAULT_MAX_REQUEST_BODY_BYTES,
    )?;
    let chunks = Limited::new(request.into_body(), limit)
        .into_data_stream()
        .map(|chunk| {
            chunk
                .map(|bytes| bytes.to_vec())
                .map_err(|error| error.to_string())
        });
    let body =
        RequestBody::Stream(register_body_stream(Box::pin(chunks)).map_err(anyhow::Error::msg)?);
    let route = binding.route.read().unwrap().clone();
    let (reply, result) = tokio::sync::oneshot::channel();
    let call = SvcCallReq {
        cancel: None,
        generation: route.generation,
        script: route.script,
        entrypoint: Some(route.entrypoint),
        url,
        method,
        body_guard: RequestBodyGuard::of(&body),
        body,
        headers,
        reply,
    };
    SVC_CALL_TX
        .get()
        .context("no Worker service channel")?
        .send(call)
        .map_err(|_| anyhow!("Worker service channel closed"))?;
    let response: HttpResponse = result.await.context("Worker service dropped")??;
    let mut builder = Response::builder().status(response.status);
    for (name, value) in response.headers {
        if !matches!(
            name.to_ascii_lowercase().as_str(),
            "connection" | "transfer-encoding" | "keep-alive" | "upgrade" | "trailer"
        ) {
            builder = builder.header(name, value);
        }
    }
    let body = match response.stream {
        Some(stream) => StreamBody::new(stream.map(|chunk| {
            chunk
                .map(|bytes| Frame::data(Bytes::from(bytes)))
                .map_err(std::io::Error::other)
        }))
        .boxed_unsync(),
        None => Full::new(Bytes::from(response.body))
            .map_err(|never| match never {})
            .boxed_unsync(),
    };
    Ok(builder.body(body)?)
}
